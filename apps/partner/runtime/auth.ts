import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { betterAuth, getCurrentAdapter } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { passkey } from '@better-auth/passkey';
import { oauthProvider, oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { initializeBetterAuthSchema, pairingSchema } from './better-auth-schema.ts';

const pairingLifetime = 10 * 60_000;
const sessionLifetime = 30 * 24 * 60 * 60;
const ownerId = 'owner';
const clientId = 'etos';
const redirectUri = 'etosllmstudio://auth/callback';
const scopes = ['cfl', 'offline_access'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const isFutureTimestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
const invalidPairing = () => new APIError('UNAUTHORIZED', { code: 'INVALID_PAIRING', message: 'Pairing code is invalid or expired.' });
const cookieValue = (header: string | null | undefined, name: string): string | undefined => {
  const matches = (header ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  try { return decodeURIComponent(matches[0]!.slice(name.length + 1)); } catch { return undefined; }
};

export class AuthFailure extends Error {
  readonly code: 'invalid_pairing' | 'authentication_failed';
  constructor(code: 'invalid_pairing' | 'authentication_failed') { super(code); this.code = code; }
}

/** Separate from Partner's journal so the host CLI can pair a running server. */
export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly secret: string;
  private readonly auth;
  private readonly ready: Promise<void>;
  readonly origin: string;
  readonly rpID: string;
  constructor(state: string, origin: string) {
    this.origin = origin;
    this.rpID = new URL(origin).hostname;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    if ((statSync(state).mode & 0o077) !== 0) throw new Error('Authentication state directory must be private (chmod 700)');
    const path = join(state, 'auth.db');
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Authentication database must be a private regular file (chmod 600)');
    const secretPath = join(state, 'auth-secret');
    try { writeFileSync(secretPath, random(), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const secretInfo = lstatSync(secretPath);
    if (!secretInfo.isFile() || (secretInfo.mode & 0o077) !== 0) throw new Error('Authentication secret must be a private regular file (chmod 600)');
    this.secret = readFileSync(secretPath, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/u.test(this.secret)) throw new Error('Invalid authentication secret');
    this.db = new DatabaseSync(path);
    try { this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON'); initializeBetterAuthSchema(this.db); }
    catch (error) { this.db.close(); throw error; }
    this.auth = betterAuth({
      baseURL: origin, secret: this.secret, telemetry: { enabled: false },
      database: this.db,
      trustedOrigins: [origin],
      advanced: { defaultCookieAttributes: { sameSite: 'strict', httpOnly: true, secure: origin.startsWith('https:') } },
      session: { expiresIn: sessionLifetime, cookieCache: { enabled: false } },
      hooks: { before: createAuthMiddleware(async ctx => {
        if (ctx.path === '/oauth2/token' && ctx.body?.grant_type === 'refresh_token' && typeof ctx.body.refresh_token === 'string') {
          // The provider validates the grant but does not check its session.
          const token = createHash('sha256').update(ctx.body.refresh_token).digest('base64url');
          const grant = this.db.prepare(`SELECT r."sessionId",s."expiresAt" AS "sessionExpiresAt"
            FROM "oauthRefreshToken" r LEFT JOIN "session" s ON r."sessionId"=s.id WHERE r.token=?`).get(token) as { sessionId: string | null; sessionExpiresAt: string | null } | undefined;
          if (grant && (!grant.sessionId || !isFutureTimestamp(grant.sessionExpiresAt))) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Authorizing session is no longer active' });
          }
        }
        if (ctx.path === '/sign-out') {
          const session = await getSessionFromCtx(ctx);
          if (session) await ctx.context.adapter.transaction(async adapter => {
            for (const model of ['oauthAccessToken', 'oauthRefreshToken']) {
              await adapter.deleteMany({ model, where: [{ field: 'sessionId', value: session.session.id }] });
            }
            // Better Auth's sign-out handler catches session deletion errors. Delete
            // here so a failure rolls back the grants and reaches the caller.
            await adapter.delete({ model: 'session', where: [{ field: 'id', value: session.session.id }] });
          });
        }
        if (ctx.path === '/passkey/generate-register-options' || ctx.path === '/passkey/verify-registration') {
          if (!this.pairingGeneration(ctx.headers?.get('cookie'))) throw invalidPairing();
          if (ctx.path === '/passkey/verify-registration' && ctx.body?.createSession !== true) throw new APIError('BAD_REQUEST', { message: 'Registration requires a session' });
        }
      }) },
      plugins: [pairingSchema, passkey({
        rpID: this.rpID, rpName: 'Codex for Love', origin,
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        registration: {
          requireSession: false,
          resolveUser: ({ ctx }) => {
            if (!this.pairingGeneration(ctx.headers?.get('cookie'))) throw invalidPairing();
            return { id: ownerId, name: 'owner', displayName: 'Owner' };
          },
          afterVerification: async ({ ctx, user, verification }) => {
            if (user.id !== ownerId || !verification.registrationInfo?.userVerified) throw new APIError('UNAUTHORIZED');
            const generation = this.pairingGeneration(ctx.headers?.get('cookie'));
            if (!generation) throw invalidPairing();
            const adapter = await getCurrentAdapter(ctx.context.adapter);
            const paired = await adapter.consumeOne({ model: 'authPairing', where: [
              { field: 'id', value: ownerId }, { field: 'generation', value: generation },
              { field: 'expiresAt', operator: 'gt', value: new Date() },
            ] });
            if (!paired) throw invalidPairing();
            for (const model of ['oauthAccessToken', 'oauthRefreshToken', 'passkey', 'session']) {
              await adapter.deleteMany({ model, where: [{ field: 'userId', value: ownerId }] });
            }
          },
        },
        authentication: { afterVerification: ({ verification }) => {
          if (!verification.authenticationInfo.userVerified) throw new APIError('UNAUTHORIZED');
        } },
      }), oauthProvider({
        loginPage: '/', consentPage: '/consent', disableJwtPlugin: true,
        allowDynamicClientRegistration: false, grantTypes: ['authorization_code', 'refresh_token'],
        scopes, resources: [origin], enforcePerClientResources: false, storeTokens: 'hashed',
      })],
    });
    this.ready = this.seed();
  }
  private async seed() {
    const { adapter } = await this.auth.$context;
    if (!await adapter.findOne({ model: 'user', where: [{ field: 'id', value: ownerId }] })) {
      await adapter.create({ model: 'user', forceAllowId: true, data: { id: ownerId, name: 'Owner', email: 'owner@invalid', emailVerified: false, createdAt: new Date(), updatedAt: new Date() } });
    }
    if (!await adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] })) {
      await adapter.create({ model: 'oauthClient', data: {
        clientId, name: 'ETOS', redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none', applicationType: 'native',
        grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], requirePKCE: true, scopes,
      } });
    }
  }
  async initialize() { await this.ready; }
  close() { this.db.close(); }
  sameOrigin(request: IncomingMessage): boolean { return request.headers.origin === this.origin && request.headers['sec-fetch-site'] !== 'cross-site'; }
  private sign(value: string): string { return createHmac('sha256', this.secret).update(value).digest('base64'); }
  private verify(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const dot = value.lastIndexOf('.');
    if (dot < 1) return undefined;
    const content = value.slice(0, dot), supplied = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.sign(content));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? content : undefined;
  }
  private pairingGeneration(header: string | null | undefined): string | undefined {
    const generation = this.verify(cookieValue(header, 'cfl_pairing'));
    if (!generation) return undefined;
    return this.db.prepare('SELECT generation FROM "authPairing" WHERE id=? AND generation=? AND "expiresAt">?').get(ownerId, generation, new Date().toISOString()) ? generation : undefined;
  }
  issuePairing(): string {
    const code = random();
    this.db.prepare('INSERT OR REPLACE INTO "authPairing" (id,"codeHash","expiresAt",generation) VALUES (?,?,?,?)')
      .run(ownerId, hash(code), new Date(Date.now() + pairingLifetime).toISOString(), random());
    return code;
  }
  pairingCookie(code: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) throw new AuthFailure('invalid_pairing');
    const row = this.db.prepare('SELECT generation FROM "authPairing" WHERE id=? AND "codeHash"=? AND "expiresAt">?')
      .get(ownerId, hash(code), new Date().toISOString()) as { generation: string } | undefined;
    if (!row) throw new AuthFailure('invalid_pairing');
    return `cfl_pairing=${encodeURIComponent(`${row.generation}.${this.sign(row.generation)}`)}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${pairingLifetime / 1000}${this.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  authorize(request: IncomingMessage): boolean {
    const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(request.headers.authorization ?? '')?.[1];
    if (bearer) {
      const row = this.db.prepare(`SELECT t."expiresAt",t.revoked,t.scopes,t.resources,t.confirmation,t."userId",t."clientId",t."sessionId",t."refreshId",
        c."clientId" AS registeredClient,c.disabled AS clientDisabled,s."expiresAt" AS sessionExpiresAt,r.revoked AS refreshRevoked,r."expiresAt" AS refreshExpiresAt
        FROM "oauthAccessToken" t LEFT JOIN "oauthClient" c ON t."clientId"=c."clientId"
        LEFT JOIN "session" s ON t."sessionId"=s.id LEFT JOIN "oauthRefreshToken" r ON t."refreshId"=r.id WHERE t.token=?`).get(createHash('sha256').update(bearer).digest('base64url')) as Record<string, unknown> | undefined;
      if (!row || row.userId !== ownerId || row.clientId !== clientId || row.registeredClient !== clientId || row.clientDisabled || row.revoked || row.confirmation || !isFutureTimestamp(row.expiresAt)) return false;
      if (!row.sessionId || !isFutureTimestamp(row.sessionExpiresAt)) return false;
      if (row.refreshId && (row.refreshRevoked || !isFutureTimestamp(row.refreshExpiresAt))) return false;
      try {
        const resource = row.resources ? JSON.parse(String(row.resources)) as unknown : [];
        return Array.isArray(resource) && resource.every(item => item === this.origin) && (JSON.parse(String(row.scopes)) as unknown[]).includes('cfl');
      } catch { return false; }
    }
    return this.authorizeSession(request);
  }
  authorizeSession(request: IncomingMessage): boolean {
    const name = `${this.origin.startsWith('https:') ? '__Secure-' : ''}better-auth.session_token`;
    const token = this.verify(cookieValue(request.headers.cookie, name));
    if (!token) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM "session" WHERE token=? AND "userId"=? AND "expiresAt">?').get(token, ownerId, new Date().toISOString()));
  }
  status(request: IncomingMessage): 'setup' | 'signed_out' | 'signed_in' {
    if (this.authorize(request)) return 'signed_in';
    return this.db.prepare('SELECT 1 FROM "passkey" WHERE "userId"=? LIMIT 1').get(ownerId) ? 'signed_out' : 'setup';
  }
  async consentDetails(query: string) {
    await this.ready;
    if (!await verifyOAuthQueryParams(query, this.secret)) throw new Error('Invalid authorization');
    const params = new URLSearchParams(query);
    for (const key of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope']) {
      if (params.getAll(key).length > 1) throw new Error('Invalid authorization');
    }
    if (params.get('client_id') !== clientId || params.get('redirect_uri') !== redirectUri || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) throw new Error('Invalid authorization');
    const adapter = (await this.auth.$context).adapter;
    const client = await adapter.findOne<{ name: string; clientId: string; disabled?: boolean; redirectUris: string[]; scopes: string[] }>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
    if (!client || client.disabled || !client.redirectUris.includes(redirectUri)) throw new Error('Invalid authorization');
    const requested = params.has('scope') ? params.get('scope')!.split(' ').filter(Boolean) : client.scopes;
    if (!requested.length || requested.some(scope => !client.scopes.includes(scope))) throw new Error('Invalid authorization');
    return { client: { id: client.clientId, name: client.name }, scopes: requested };
  }
  async handle(request: IncomingMessage, response: ServerResponse, revoke: () => void) {
    await this.ready;
    let size = 0; const chunks: Buffer[] = [];
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) throw new Error('Authentication request too large');
        chunks.push(chunk);
      }
    }
    const url = new URL(request.url ?? '/', this.origin);
    const headers = fromNodeHeaders(request.headers);
    if (url.pathname === '/api/auth/passkey/generate-register-options') {
      // The plugin otherwise uses the internal required email as the authenticator label.
      const name = `${this.origin.startsWith('https:') ? '__Secure-' : ''}better-auth.session_token`;
      headers.set('cookie', (headers.get('cookie') ?? '').split(';').filter(part => !part.trim().startsWith(`${name}=`)).join(';'));
    }
    const req = new Request(url, { method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const result = url.pathname === '/.well-known/oauth-authorization-server/api/auth'
      ? await oauthProviderAuthServerMetadata(this.auth)(req)
      : await this.auth.handler(req);
    if (url.pathname === '/api/auth/passkey/verify-registration' || url.pathname === '/api/auth/sign-out') revoke();
    for (const [name, value] of result.headers) if (name !== 'set-cookie') response.setHeader(name, value);
    const cookies = result.headers.getSetCookie();
    if (url.pathname === '/api/auth/passkey/verify-registration' && result.ok) cookies.push(`cfl_pairing=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${this.origin.startsWith('https:') ? '; Secure' : ''}`);
    if (cookies.length) response.setHeader('set-cookie', cookies);
    response.statusCode = result.status;
    response.end(Buffer.from(await result.arrayBuffer()));
  }
}
