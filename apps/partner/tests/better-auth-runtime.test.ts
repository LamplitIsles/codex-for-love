import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { AuthStore } from '../runtime/auth.ts';
import { createWebServer } from '../runtime/server.ts';
import type { Partner } from '../runtime/partner.ts';
import { authenticator } from './synthetic-auth.ts';

const origin = 'http://localhost:3082';
const cookie = (response: Response, name: string) => {
  const value = response.headers.getSetCookie().find(item => item.startsWith(`${name}=`));
  assert.ok(value, `missing ${name} cookie`);
  return value.split(';')[0]!;
};

test('Better Auth pairing and recovery retain access until successful verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-ba-test-'));
  const assets = join(root, 'assets');
  await mkdir(assets); await writeFile(join(assets, 'index.html'), 'test app');
  const auth = new AuthStore(root, origin);
  const partner = { close: async () => {}, voiceCredential: () => null } as unknown as Partner;
  const app = createWebServer(partner, assets, { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, opts: { method?: string; data?: unknown; cookies?: string[] } = {}) => fetch(base + path, {
    method: opts.method ?? 'GET', redirect: 'manual',
    headers: { host: 'localhost:3082', origin, ...(opts.data !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.cookies?.length ? { cookie: opts.cookies.join('; ') } : {}) },
    ...(opts.data !== undefined ? { body: JSON.stringify(opts.data) } : {}),
  });
  const pair = async (code: string) => {
    const result = await call('/api/auth/pairing', { method: 'POST', data: { code } });
    assert.equal(result.status, 200, await result.clone().text());
    return cookie(result, 'cfl_pairing');
  };
  const options = async (pairCookie: string, session?: string) => {
    const result = await call('/api/auth/passkey/generate-register-options', { cookies: [pairCookie, ...(session ? [session] : [])] });
    assert.equal(result.status, 200, await result.clone().text());
    return { challenge: (await result.json() as { challenge: string }).challenge, challengeCookie: cookie(result, 'better-auth.better-auth-passkey') };
  };
  const verify = (device: ReturnType<typeof authenticator>, challenge: string, cookies: string[], site = origin) => call('/api/auth/passkey/verify-registration', { method: 'POST', data: { createSession: true, response: device.register(challenge, site) }, cookies });
  try {
    await auth.initialize();
    assert.equal((await call('/api/auth/pairing', { method: 'POST', data: { code: 'invalid' } })).status, 401);
    const first = authenticator(); const code = auth.issuePairing(); const pairCookie = await pair(code);
    const firstOptions = await options(pairCookie);
    const registered = await verify(first, firstOptions.challenge, [pairCookie, firstOptions.challengeCookie]);
    assert.equal(registered.status, 200, await registered.clone().text());
    const session = cookie(registered, 'better-auth.session_token');
    assert.equal((await call('/api/auth/status', { cookies: [session] }).then(r => r.json()) as { state: string }).state, 'signed_in');
    assert.equal((await call('/api/auth/pairing', { method: 'POST', data: { code } })).status, 401);
    assert.notEqual((await call('/api/auth/passkey/generate-register-options', { cookies: [session] })).status, 200);
    const expiredCode = auth.issuePairing();
    const expiredCookie = await pair(expiredCode);
    const { DatabaseSync } = await import('node:sqlite');
    const expiryDb = new DatabaseSync(join(root, 'auth.db'));
    try { expiryDb.prepare('UPDATE "authPairing" SET "expiresAt"=? WHERE id=?').run(new Date(0).toISOString(), 'owner'); }
    finally { expiryDb.close(); }
    const expiredPreflight = await call('/api/auth/pairing', { method: 'POST', data: { code: expiredCode } });
    assert.equal(expiredPreflight.status, 401);
    assert.equal((await expiredPreflight.json() as { error: { code: string } }).error.code, 'invalid_pairing');
    const expiredOptions = await call('/api/auth/passkey/generate-register-options', { cookies: [expiredCookie] });
    assert.equal(expiredOptions.status, 401);
    assert.deepEqual(await expiredOptions.json(), { code: 'INVALID_PAIRING', message: 'Pairing code is invalid or expired.' });
    const ceremonyCode = auth.issuePairing(); const ceremonyCookie = await pair(ceremonyCode);
    const ceremony = await options(ceremonyCookie, session);
    const expiredDuringCeremony = new DatabaseSync(join(root, 'auth.db'));
    try { expiredDuringCeremony.prepare('UPDATE "authPairing" SET "expiresAt"=? WHERE id=?').run(new Date(0).toISOString(), 'owner'); }
    finally { expiredDuringCeremony.close(); }
    const expiredVerification = await verify(authenticator(), ceremony.challenge, [ceremonyCookie, ceremony.challengeCookie, session]);
    assert.equal(expiredVerification.status, 401);
    assert.deepEqual(await expiredVerification.json(), { code: 'INVALID_PAIRING', message: 'Pairing code is invalid or expired.' });
    assert.equal((await call('/api/auth/status', { cookies: [session] }).then(r => r.json()) as { state: string }).state, 'signed_in');
    const recovery = auth.issuePairing(); const recoveryCookie = await pair(recovery); const replacement = authenticator();
    const failedOptions = await options(recoveryCookie, session);
    const failed = await verify(replacement, failedOptions.challenge, [recoveryCookie, failedOptions.challengeCookie, session], 'https://attacker.example');
    assert.notEqual(failed.status, 200);
    assert.notEqual((await failed.json() as { code?: string }).code, 'INVALID_PAIRING');
    assert.equal((await call('/api/auth/status', { cookies: [session] }).then(r => r.json()) as { state: string }).state, 'signed_in');
    // A later persistence failure must roll back pair consumption and revocation.
    const db = new DatabaseSync(join(root, 'auth.db'));
    db.exec(`CREATE TRIGGER test_fail_passkey BEFORE INSERT ON "passkey" BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    const rejectedOptions = await options(recoveryCookie, session);
    const rejected = await verify(replacement, rejectedOptions.challenge, [recoveryCookie, rejectedOptions.challengeCookie, session]);
    assert.notEqual(rejected.status, 200);
    assert.equal((await call('/api/auth/status', { cookies: [session] }).then(r => r.json()) as { state: string }).state, 'signed_in');
    db.exec('DROP TRIGGER test_fail_passkey'); db.close();
    const next = await options(recoveryCookie, session);
    const success = await verify(replacement, next.challenge, [recoveryCookie, next.challengeCookie, session]);
    assert.equal(success.status, 200, await success.clone().text());
    assert.equal((await call('/api/auth/status', { cookies: [session] }).then(r => r.json()) as { state: string }).state, 'signed_out');
    assert.equal((await call('/api/auth/pairing', { method: 'POST', data: { code: recovery } })).status, 401);
    const login = await call('/api/auth/passkey/generate-authenticate-options');
    const loginChallenge = (await login.json() as { challenge: string }).challenge;
    const challengeCookie = cookie(login, 'better-auth.better-auth-passkey');
    const unverified = await call('/api/auth/passkey/verify-authentication', { method: 'POST', cookies: [challengeCookie], data: { response: replacement.login(loginChallenge, 1, origin, false) } });
    assert.notEqual(unverified.status, 200);
    const signedOut = await call('/api/auth/status');
    assert.equal((await signedOut.json() as { state: string }).state, 'signed_out');
    const loginOptions = await call('/api/auth/passkey/generate-authenticate-options');
    assert.equal(loginOptions.status, 200);
    const validChallenge = (await loginOptions.json() as { challenge: string }).challenge;
    const signedIn = await call('/api/auth/passkey/verify-authentication', {
      method: 'POST', cookies: [cookie(loginOptions, 'better-auth.better-auth-passkey')],
      data: { response: replacement.login(validChallenge) },
    });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const loginSession = cookie(signedIn, 'better-auth.session_token');
    assert.equal((await call('/api/auth/status', { cookies: [loginSession] }).then(r => r.json()) as { state: string }).state, 'signed_in');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('native OAuth consent, S256 exchange, refresh and recovery use the provider', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'cfl-ba-oauth-'));
  const assets = join(root, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), 'test app');
  const auth = new AuthStore(root, origin);
  const partner = { close: async () => {}, voiceCredential: () => null } as unknown as Partner;
  const app = createWebServer(partner, assets, { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, options: { method?: string; data?: unknown; form?: URLSearchParams; cookies?: string[] } = {}) => fetch(base + path, {
    method: options.method ?? 'GET', redirect: 'manual',
    headers: { host: 'localhost:3082', origin, ...(options.data !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(options.cookies?.length ? { cookie: options.cookies.join('; ') } : {}) },
    ...(options.data !== undefined ? { body: JSON.stringify(options.data) } : options.form ? { body: options.form.toString() } : {}),
  });
  try {
    await auth.initialize();
    const metadata = await request('/.well-known/oauth-authorization-server/api/auth');
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json() as { issuer: string }).issuer, `${origin}/api/auth`);
    const code = auth.issuePairing();
    const pairing = await request('/api/auth/pairing', { method: 'POST', data: { code } });
    assert.equal(pairing.status, 200); const pairCookie = cookie(pairing, 'cfl_pairing');
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: 'etos', redirect_uri: 'etosllmstudio://auth/callback', response_type: 'code', scope: 'cfl offline_access', resource: origin, state: 'synthetic-state', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const invalidRedirect = new URLSearchParams(query); invalidRedirect.set('redirect_uri', 'https://attacker.example/callback');
    const wrongTarget = await request(`/api/auth/oauth2/authorize?${invalidRedirect}`);
    const wrongDestination = (await wrongTarget.json() as { url: string }).url;
    assert.ok(!wrongDestination.includes('attacker.example'));
    const plain = new URLSearchParams(query); plain.set('code_challenge_method', 'plain');
    const rejectedPkce = await request(`/api/auth/oauth2/authorize?${plain}`);
    assert.match((await rejectedPkce.json() as { url: string }).url, /error=/u);
    const authorization = await request(`/api/auth/oauth2/authorize?${query}`);
    assert.equal(authorization.status, 200, await authorization.clone().text());
    const loginLocation = new URL((await authorization.json() as { url: string }).url, origin);
    assert.equal(loginLocation.pathname, '/');
    const options = await request('/api/auth/passkey/generate-register-options', { cookies: [pairCookie] });
    assert.equal(options.status, 200); const challenge = (await options.json() as { challenge: string }).challenge;
    const challengeCookie = cookie(options, 'better-auth.better-auth-passkey');
    const registered = await request('/api/auth/passkey/verify-registration', { method: 'POST', cookies: [pairCookie, challengeCookie], data: { response: authenticator().register(challenge), createSession: true, oauth_query: loginLocation.search.slice(1) } });
    assert.equal(registered.status, 200, await registered.clone().text());
    const session = cookie(registered, 'better-auth.session_token');
    const continuation = await registered.json() as { redirect: boolean; url: string };
    assert.equal(continuation.redirect, true);
    const consentLocation = new URL(continuation.url, origin);
    assert.equal(consentLocation.pathname, '/consent');
    assert.equal((await request('/consent')).status, 200);
    const signedQuery = consentLocation.search.slice(1);
    const details = await request('/api/auth/consent-details', { method: 'POST', cookies: [session], data: { oauth_query: signedQuery } });
    assert.equal(details.status, 200, await details.clone().text());
    assert.deepEqual(await details.json(), { client: { id: 'etos', name: 'ETOS' }, scopes: ['cfl', 'offline_access'] });
    const tampered = signedQuery.replace('client_id=etos', 'client_id=other');
    assert.equal((await request('/api/auth/consent-details', { method: 'POST', cookies: [session], data: { oauth_query: tampered } })).status, 400);
    const consent = await request('/api/auth/oauth2/consent', { method: 'POST', cookies: [session], data: { accept: true, oauth_query: signedQuery } });
    assert.equal(consent.status, 200, await consent.clone().text());
    const accepted = await consent.json() as { redirect: boolean; url: string };
    assert.equal(accepted.redirect, true);
    const callback = new URL(accepted.url);
    assert.equal(`${callback.protocol}//${callback.host}${callback.pathname}`, 'etosllmstudio://auth/callback');
    assert.equal(callback.searchParams.get('state'), 'synthetic-state');
    assert.equal(callback.searchParams.get('iss'), `${origin}/api/auth`);
    const authorizationCode = callback.searchParams.get('code'); assert.ok(authorizationCode);
    const exchangeCode = (code: string, codeVerifier: string) => request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'etos', redirect_uri: 'etosllmstudio://auth/callback', code, code_verifier: codeVerifier, resource: origin }) });
    const wrongVerifier = randomBytes(32).toString('base64url');
    const wrongExchange = await exchangeCode(authorizationCode, wrongVerifier);
    assert.equal(wrongExchange.status, 400);
    const wrongResult = await wrongExchange.json() as { error?: string; access_token?: string; refresh_token?: string };
    assert.ok(wrongResult.error);
    assert.equal(wrongResult.access_token, undefined);
    assert.equal(wrongResult.refresh_token, undefined);
    assert.notEqual((await exchangeCode(authorizationCode, verifier)).status, 200);
    // Request a separate code; the provider consumes the first code even on failed PKCE.
    const renewedAuthorization = await request(`/api/auth/oauth2/authorize?${query}`, { cookies: [session] });
    assert.equal(renewedAuthorization.status, 200, await renewedAuthorization.clone().text());
    const renewedCallback = new URL((await renewedAuthorization.json() as { url: string }).url);
    const nextCode = renewedCallback.searchParams.get('code'); assert.ok(nextCode);
    const exchange = () => exchangeCode(nextCode, verifier);
    const tokenResponse = await exchange();
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    let tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    assert.ok(tokens.access_token); assert.ok(tokens.refresh_token);
    const human = await fetch(base + '/api/auth/status', { headers: { host: 'localhost:3082', authorization: `Bearer ${tokens.access_token}` } });
    assert.equal((await human.json() as { state: string }).state, 'signed_in');
    const renewed = await request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'etos', refresh_token: tokens.refresh_token }) });
    assert.equal(renewed.status, 200, await renewed.clone().text());
    tokens = await renewed.json() as { access_token: string; refresh_token: string };
    const replacementCode = auth.issuePairing(); const newPair = cookie(await request('/api/auth/pairing', { method: 'POST', data: { code: replacementCode } }), 'cfl_pairing');
    const next = await request('/api/auth/passkey/generate-register-options', { cookies: [newPair] });
    const nextChallenge = (await next.json() as { challenge: string }).challenge;
    const recovery = await request('/api/auth/passkey/verify-registration', { method: 'POST', cookies: [newPair, cookie(next, 'better-auth.better-auth-passkey')], data: { createSession: true, response: authenticator().register(nextChallenge) } });
    assert.equal(recovery.status, 200, await recovery.clone().text());
    const revoked = await fetch(base + '/api/auth/status', { headers: { host: 'localhost:3082', authorization: `Bearer ${tokens.access_token}` } });
    assert.equal((await revoked.json() as { state: string }).state, 'signed_out');
    const refresh = await request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'etos', refresh_token: tokens.refresh_token }) });
    assert.notEqual(refresh.status, 200);
    assert.notEqual((await exchange()).status, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('sign-out revokes native grants issued to the browser session', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'cfl-ba-logout-'));
  const assets = join(root, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), 'test app');
  const auth = new AuthStore(root, origin);
  let cancellations = 0;
  const partner = { close: async () => {}, voiceCredential: () => 'test-key', cancel: async () => { cancellations++; } } as unknown as Partner;
  const app = createWebServer(partner, assets, { auth, voice: { connect: () => Object.assign(new EventEmitter(), { terminate() {} }) as unknown as WebSocket } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, options: { method?: string; data?: unknown; form?: URLSearchParams; cookies?: string[]; token?: string; site?: string | null } = {}) => fetch(base + path, {
    method: options.method ?? 'GET', redirect: 'manual',
    headers: { host: 'localhost:3082', ...(options.site === null ? {} : { origin: options.site ?? origin }), ...(options.data !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(options.cookies?.length ? { cookie: options.cookies.join('; ') } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(options.data !== undefined ? { body: JSON.stringify(options.data) } : options.form ? { body: options.form.toString() } : {}),
  });
  let activeSocket: WebSocket | undefined;
  try {
    await auth.initialize();
    const pairing = await request('/api/auth/pairing', { method: 'POST', data: { code: auth.issuePairing() } });
    assert.equal(pairing.status, 200);
    const pairCookie = cookie(pairing, 'cfl_pairing');
    const options = await request('/api/auth/passkey/generate-register-options', { cookies: [pairCookie] });
    const challenge = (await options.json() as { challenge: string }).challenge;
    const device = authenticator();
    const registered = await request('/api/auth/passkey/verify-registration', { method: 'POST', cookies: [pairCookie, cookie(options, 'better-auth.better-auth-passkey')], data: { response: device.register(challenge), createSession: true } });
    assert.equal(registered.status, 200); const session = cookie(registered, 'better-auth.session_token');
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: 'etos', redirect_uri: 'etosllmstudio://auth/callback', response_type: 'code', scope: 'cfl offline_access', resource: origin, state: 'logout-test', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const authorization = await request(`/api/auth/oauth2/authorize?${query}`, { cookies: [session] });
    const consentUrl = new URL((await authorization.json() as { url: string }).url, origin);
    assert.equal(consentUrl.pathname, '/consent');
    const consent = await request('/api/auth/oauth2/consent', { method: 'POST', cookies: [session], data: { accept: true, oauth_query: consentUrl.search.slice(1) } });
    const callback = new URL((await consent.json() as { url: string }).url);
    const code = callback.searchParams.get('code'); assert.ok(code);
    const exchange = await request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'etos', redirect_uri: 'etosllmstudio://auth/callback', code, code_verifier: verifier, resource: origin }) });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const tokens = await exchange.json() as { access_token: string; refresh_token: string };
    assert.ok(tokens.access_token); assert.ok(tokens.refresh_token);
    assert.equal((await request('/api/auth/status', { token: tokens.access_token }).then(r => r.json()) as { state: string }).state, 'signed_in');
    for (const site of ['http://foreign.example', null]) {
      assert.equal((await request('/api/cancel', { method: 'POST', data: { id: 'test' }, token: tokens.access_token, site })).status, 403);
    }
    assert.equal(cancellations, 0);
    assert.equal((await request('/api/cancel', { method: 'POST', data: { id: 'test' }, token: tokens.access_token })).status, 200);
    assert.equal(cancellations, 1);
    const connect = (site: string | null) => new WebSocket(base.replace('http:', 'ws:') + '/api/voice/stream', {
      headers: { host: 'localhost:3082', authorization: `Bearer ${tokens.access_token}`, ...(site === null ? {} : { origin: site }) },
    });
    const rejected = async (site: string | null) => {
      const ws = connect(site);
      ws.on('error', () => {});
      const [, response] = await once(ws, 'unexpected-response') as [import('node:http').ClientRequest, import('node:http').IncomingMessage];
      response.resume(); ws.terminate();
      return response.statusCode;
    };
    assert.equal(await rejected('http://foreign.example'), 403);
    assert.equal(await rejected(null), 403);
    activeSocket = connect(origin);
    await once(activeSocket, 'open');
    // A failed token deletion must fail the request and roll back the whole revocation.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, 'auth.db'));
    try {
      db.exec(`CREATE TRIGGER test_fail_refresh BEFORE DELETE ON "oauthRefreshToken" BEGIN SELECT RAISE(ABORT, 'synthetic logout failure'); END`);
      const failedSignOut = await request('/api/auth/sign-out', { method: 'POST', cookies: [session], data: {} });
      assert.notEqual(failedSignOut.status, 200);
      assert.equal((await request('/api/auth/status', { token: tokens.access_token }).then(r => r.json()) as { state: string }).state, 'signed_in');
      assert.equal((await request('/api/auth/status', { cookies: [session] }).then(r => r.json()) as { state: string }).state, 'signed_in');
      db.exec('DROP TRIGGER test_fail_refresh');
      db.exec(`CREATE TRIGGER test_fail_session BEFORE DELETE ON "session" BEGIN SELECT RAISE(ABORT, 'synthetic session deletion failure'); END`);
      const failedSessionDeletion = await request('/api/auth/sign-out', { method: 'POST', cookies: [session], data: {} });
      assert.notEqual(failedSessionDeletion.status, 200, 'session deletion failure must fail sign-out');
      assert.doesNotMatch(failedSessionDeletion.headers.get('set-cookie') ?? '', /better-auth\.session_token=;/);
      assert.equal((await request('/api/auth/status', { token: tokens.access_token }).then(r => r.json()) as { state: string }).state, 'signed_in');
      assert.equal((await request('/api/auth/status', { cookies: [session] }).then(r => r.json()) as { state: string }).state, 'signed_in');
      assert.equal(activeSocket.readyState, WebSocket.OPEN);
      db.exec('DROP TRIGGER test_fail_session');
    } finally { db.close(); }
    const retryRefresh = await request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'etos', refresh_token: tokens.refresh_token, resource: origin }) });
    assert.equal(retryRefresh.status, 200, await retryRefresh.clone().text());
    const refreshed = await retryRefresh.json() as { refresh_token: string };
    assert.ok(refreshed.refresh_token);
    const loginOptions = await request('/api/auth/passkey/generate-authenticate-options');
    const loginChallenge = (await loginOptions.json() as { challenge: string }).challenge;
    const otherLogin = await request('/api/auth/passkey/verify-authentication', { method: 'POST', cookies: [cookie(loginOptions, 'better-auth.better-auth-passkey')], data: { response: device.login(loginChallenge) } });
    assert.equal(otherLogin.status, 200); const otherSession = cookie(otherLogin, 'better-auth.session_token');
    const socketClosed = once(activeSocket, 'close');
    const signOut = await request('/api/auth/sign-out', { method: 'POST', cookies: [session], data: {} });
    assert.equal(signOut.status, 200);
    assert.match(signOut.headers.get('set-cookie') ?? '', /better-auth\.session_token=;/);
    await socketClosed;
    assert.equal((await request('/api/auth/status', { token: tokens.access_token }).then(r => r.json()) as { state: string }).state, 'signed_out');
    assert.equal((await request('/api/session', { token: tokens.access_token })).status, 401);
    assert.equal((await request('/api/cancel', { method: 'POST', data: { id: 'test' }, token: tokens.access_token })).status, 401);
    assert.equal(cancellations, 1);
    assert.equal(await rejected(origin), 403);
    assert.equal((await request('/api/auth/status', { cookies: [otherSession] }).then(r => r.json()) as { state: string }).state, 'signed_in');
    const refresh = await request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'etos', refresh_token: refreshed.refresh_token }) });
    assert.notEqual(refresh.status, 200, 'logout must revoke the linked refresh token');
  } finally { activeSocket?.terminate(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('native grants require their authorizing session to remain live', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'cfl-ba-session-grants-'));
  const assets = join(root, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), 'test app');
  const auth = new AuthStore(root, origin);
  const partner = { close: async () => {}, voiceCredential: () => null } as unknown as Partner;
  const app = createWebServer(partner, assets, { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, options: { method?: string; data?: unknown; form?: URLSearchParams; cookies?: string[]; token?: string } = {}) => fetch(base + path, {
    method: options.method ?? 'GET', redirect: 'manual',
    headers: { host: 'localhost:3082', origin, ...(options.data !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(options.cookies?.length ? { cookie: options.cookies.join('; ') } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(options.data !== undefined ? { body: JSON.stringify(options.data) } : options.form ? { body: options.form.toString() } : {}),
  });
  type Tokens = { access_token: string; refresh_token: string };
  const stored = (token: string) => createHash('sha256').update(token).digest('base64url');
  const refresh = (token: string) => request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'etos', refresh_token: token, resource: origin }) });
  const state = async (token: string) => (await request('/api/auth/status', { token }).then(r => r.json()) as { state: string }).state;
  try {
    await auth.initialize();
    const pairing = await request('/api/auth/pairing', { method: 'POST', data: { code: auth.issuePairing() } });
    const pairCookie = cookie(pairing, 'cfl_pairing');
    const options = await request('/api/auth/passkey/generate-register-options', { cookies: [pairCookie] });
    const challenge = (await options.json() as { challenge: string }).challenge;
    const device = authenticator();
    const registration = await request('/api/auth/passkey/verify-registration', { method: 'POST', cookies: [pairCookie, cookie(options, 'better-auth.better-auth-passkey')], data: { response: device.register(challenge), createSession: true } });
    assert.equal(registration.status, 200);
    const initialSession = cookie(registration, 'better-auth.session_token');
    let counter = 0;
    const login = async () => {
      const loginOptions = await request('/api/auth/passkey/generate-authenticate-options');
      const loginChallenge = (await loginOptions.json() as { challenge: string }).challenge;
      const response = await request('/api/auth/passkey/verify-authentication', { method: 'POST', cookies: [cookie(loginOptions, 'better-auth.better-auth-passkey')], data: { response: device.login(loginChallenge, ++counter) } });
      assert.equal(response.status, 200, await response.clone().text());
      return cookie(response, 'better-auth.session_token');
    };
    const grant = async (session: string): Promise<Tokens> => {
      const verifier = randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ client_id: 'etos', redirect_uri: 'etosllmstudio://auth/callback', response_type: 'code', scope: 'cfl offline_access', resource: origin, state: 'session-test', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      const response = await request(`/api/auth/oauth2/authorize?${query}`, { cookies: [session] });
      assert.equal(response.status, 200, await response.clone().text());
      let location = new URL((await response.json() as { url: string }).url, origin);
      if (location.pathname === '/consent') {
        const consent = await request('/api/auth/oauth2/consent', { method: 'POST', cookies: [session], data: { accept: true, oauth_query: location.search.slice(1) } });
        assert.equal(consent.status, 200, await consent.clone().text());
        location = new URL((await consent.json() as { url: string }).url);
      }
      const code = location.searchParams.get('code'); assert.ok(code);
      const exchange = await request('/api/auth/oauth2/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'etos', redirect_uri: 'etosllmstudio://auth/callback', code, code_verifier: verifier, resource: origin }) });
      assert.equal(exchange.status, 200, await exchange.clone().text());
      return await exchange.json() as Tokens;
    };
    const db = new DatabaseSync(join(root, 'auth.db'));
    try {
      let tokens = await grant(initialSession);
      assert.equal(await state(tokens.access_token), 'signed_in');
      const validRefresh = await refresh(tokens.refresh_token);
      assert.equal(validRefresh.status, 200, await validRefresh.clone().text());
      tokens = await validRefresh.json() as Tokens;
      assert.equal(await state(tokens.access_token), 'signed_in');
      const sessionId = (db.prepare('SELECT "sessionId" FROM "oauthRefreshToken" WHERE token=?').get(stored(tokens.refresh_token)) as { sessionId: string }).sessionId;
      db.prepare('UPDATE "session" SET "expiresAt"=? WHERE id=?').run(new Date(0).toISOString(), sessionId);
      assert.equal(await state(tokens.access_token), 'signed_out');
      const expiredRefresh = await refresh(tokens.refresh_token);
      assert.equal(expiredRefresh.status, 400, 'expired session must not refresh before cleanup');
      assert.equal((await expiredRefresh.json() as { error: string }).error, 'invalid_grant');
      assert.ok(db.prepare('SELECT 1 FROM "session" WHERE id=?').get(sessionId), 'expired session remains before cleanup');
      const cleaned = await request('/api/auth/get-session', { cookies: [initialSession] });
      assert.equal(cleaned.status, 200);
      assert.equal(await cleaned.json(), null);
      assert.equal(db.prepare('SELECT 1 FROM "session" WHERE id=?').get(sessionId), undefined);
      assert.equal(await state(tokens.access_token), 'signed_out');
      assert.notEqual((await refresh(tokens.refresh_token)).status, 200, 'expired session must not refresh after cleanup');

      tokens = await grant(await login());
      db.prepare('UPDATE "oauthAccessToken" SET "sessionId"=NULL WHERE token=?').run(stored(tokens.access_token));
      db.prepare('UPDATE "oauthRefreshToken" SET "sessionId"=NULL WHERE token=?').run(stored(tokens.refresh_token));
      assert.equal(await state(tokens.access_token), 'signed_out', 'unbound bearer must fail');
      assert.notEqual((await refresh(tokens.refresh_token)).status, 200, 'unbound refresh must fail');

      tokens = await grant(await login());
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare('UPDATE "oauthAccessToken" SET "sessionId"=? WHERE token=?').run('missing-session', stored(tokens.access_token));
      db.prepare('UPDATE "oauthRefreshToken" SET "sessionId"=? WHERE token=?').run('missing-session', stored(tokens.refresh_token));
      assert.equal(await state(tokens.access_token), 'signed_out', 'missing session bearer must fail');
      assert.notEqual((await refresh(tokens.refresh_token)).status, 200, 'missing session refresh must fail');

      tokens = await grant(await login());
      const deletedSession = (db.prepare('SELECT "sessionId" FROM "oauthRefreshToken" WHERE token=?').get(stored(tokens.refresh_token)) as { sessionId: string }).sessionId;
      db.exec('PRAGMA foreign_keys=ON');
      db.prepare('DELETE FROM "session" WHERE id=?').run(deletedSession);
      assert.equal(await state(tokens.access_token), 'signed_out');
      assert.notEqual((await refresh(tokens.refresh_token)).status, 200, 'deleted session must not refresh');
    } finally { db.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
