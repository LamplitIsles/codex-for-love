import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type WebAuthnCredential,
} from '@simplewebauthn/server';
import { initializeAuthSchema } from './auth-schema.ts';

const pairingLifetime = 10 * 60_000;
const ceremonyLifetime = 2 * 60_000;
const sessionLifetime = 30 * 24 * 60 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest();
const secret = () => randomBytes(32).toString('base64url');
type Ceremony = { kind: 'register' | 'login'; challenge: string; expires_at: number; pairing_generation: string | null; credential_epoch: number };
type Credential = { id: string; public_key: Uint8Array; counter: number; transports: string | null };

export class AuthFailure extends Error {
  readonly code: 'invalid_pairing' | 'authentication_failed';
  constructor(code: 'invalid_pairing' | 'authentication_failed') { super(code); this.code = code; }
}

/** Separate from Partner's exclusively locked journal so the host CLI can pair a running server. */
export class AuthStore {
  private readonly db: DatabaseSync;
  readonly rpID: string;
  readonly origin: string;
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
    this.db = new DatabaseSync(path);
    try { this.db.exec('PRAGMA busy_timeout=5000;'); initializeAuthSchema(this.db); }
    catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  sameOrigin(request: IncomingMessage): boolean { return request.headers.origin === this.origin && request.headers['sec-fetch-site'] !== 'cross-site'; }
  authorize(request: IncomingMessage): boolean { return this.signedIn(sessionToken(request.headers.cookie)); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private metadata() { return this.db.prepare('SELECT credential_epoch,user_id FROM auth_metadata WHERE id=1').get() as { credential_epoch: number; user_id: Uint8Array }; }
  private prune(now: number) {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM auth_ceremonies WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM auth_pairing WHERE expires_at<=?').run(now);
  }
  issuePairing(): string {
    const code = secret(), now = Date.now();
    this.transaction(() => {
      this.prune(now);
      this.db.prepare('INSERT OR REPLACE INTO auth_pairing(id,code_hash,expires_at,generation) VALUES(1,?,?,?)').run(hash(code), now + pairingLifetime, secret());
    });
    return code;
  }
  signedIn(token: string | undefined): boolean {
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now()));
  }
  status(token?: string): 'setup' | 'signed_out' | 'signed_in' {
    if (this.signedIn(token)) return 'signed_in';
    return this.db.prepare('SELECT 1 FROM auth_credentials LIMIT 1').get() ? 'signed_out' : 'setup';
  }
  logout(token?: string): void { if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(token)); }
  private saveCeremony(kind: Ceremony['kind'], challenge: string, pairing: string | null, epoch: number): string {
    const handle = secret(), now = Date.now();
    this.transaction(() => {
      this.prune(now);
      this.db.prepare('INSERT INTO auth_ceremonies(handle_hash,kind,challenge,expires_at,pairing_generation,credential_epoch) VALUES(?,?,?,?,?,?)')
        .run(hash(handle), kind, challenge, now + ceremonyLifetime, pairing, epoch);
    });
    return handle;
  }
  private takeCeremony(handle: string, kind: Ceremony['kind']): Ceremony {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(handle)) throw new AuthFailure('authentication_failed');
    const row = this.transaction(() => {
      const row = this.db.prepare('SELECT kind,challenge,expires_at,pairing_generation,credential_epoch FROM auth_ceremonies WHERE handle_hash=?').get(hash(handle)) as Ceremony | undefined;
      this.db.prepare('DELETE FROM auth_ceremonies WHERE handle_hash=?').run(hash(handle));
      return row;
    });
    if (!row || row.kind !== kind || row.expires_at <= Date.now()) throw new AuthFailure('authentication_failed');
    return row;
  }
  async registrationOptions(code: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) throw new AuthFailure('invalid_pairing');
    const pairing = this.db.prepare('SELECT generation FROM auth_pairing WHERE code_hash=? AND expires_at>?').get(hash(code), Date.now()) as { generation: string } | undefined;
    if (!pairing) throw new AuthFailure('invalid_pairing');
    const metadata = this.metadata();
    const options = await generateRegistrationOptions({ rpName: 'Codex for Love', rpID: this.rpID, userName: 'owner', userDisplayName: 'Owner', userID: new Uint8Array(metadata.user_id), timeout: ceremonyLifetime, attestationType: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } });
    return { options, ceremony: this.saveCeremony('register', options.challenge, pairing.generation, metadata.credential_epoch) };
  }
  async loginOptions() {
    const metadata = this.metadata();
    const credentials = this.db.prepare('SELECT id,transports FROM auth_credentials').all() as Array<{ id: string; transports: string | null }>;
    const options = await generateAuthenticationOptions({ rpID: this.rpID, timeout: ceremonyLifetime, userVerification: 'required', allowCredentials: credentials.map(row => ({ id: row.id, ...(row.transports ? { transports: JSON.parse(row.transports) } : {}) })) });
    return { options, ceremony: this.saveCeremony('login', options.challenge, null, metadata.credential_epoch) };
  }
  private createSession(now: number): string {
    const token = secret();
    this.db.prepare('INSERT INTO auth_sessions(token_hash,expires_at) VALUES(?,?)').run(hash(token), now + sessionLifetime);
    return token;
  }
  async register(handle: string, response: RegistrationResponseJSON): Promise<string> {
    const ceremony = this.takeCeremony(handle, 'register');
    let credential: WebAuthnCredential;
    try {
      const result = await verifyRegistrationResponse({ response, expectedChallenge: ceremony.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true });
      if (!result.verified || !result.registrationInfo.userVerified) throw new Error();
      credential = result.registrationInfo.credential;
    } catch { throw new AuthFailure('authentication_failed'); }
    return this.transaction(() => {
      const now = Date.now();
      const pairing = this.db.prepare('SELECT 1 FROM auth_pairing WHERE id=1 AND generation=? AND expires_at>?').get(ceremony.pairing_generation, now);
      if (!pairing || ceremony.expires_at <= now || this.metadata().credential_epoch !== ceremony.credential_epoch) throw new AuthFailure('authentication_failed');
      this.db.exec('DELETE FROM auth_pairing; DELETE FROM auth_credentials; DELETE FROM auth_sessions; DELETE FROM auth_ceremonies; UPDATE auth_metadata SET credential_epoch=credential_epoch+1 WHERE id=1');
      this.db.prepare('INSERT INTO auth_credentials(id,public_key,counter,transports) VALUES(?,?,?,?)').run(credential.id, credential.publicKey, credential.counter, credential.transports ? JSON.stringify(credential.transports) : null);
      return this.createSession(now);
    });
  }
  async login(handle: string, response: AuthenticationResponseJSON): Promise<string> {
    const ceremony = this.takeCeremony(handle, 'login');
    if (!response || typeof response.id !== 'string') throw new AuthFailure('authentication_failed');
    const stored = this.db.prepare('SELECT id,public_key,counter,transports FROM auth_credentials WHERE id=?').get(response.id) as Credential | undefined;
    if (!stored) throw new AuthFailure('authentication_failed');
    let counter: number;
    try {
      const result = await verifyAuthenticationResponse({ response, expectedChallenge: ceremony.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true, credential: { id: stored.id, publicKey: new Uint8Array(stored.public_key), counter: stored.counter, ...(stored.transports ? { transports: JSON.parse(stored.transports) } : {}) } });
      if (!result.verified || !result.authenticationInfo.userVerified) throw new Error();
      counter = result.authenticationInfo.newCounter;
    } catch { throw new AuthFailure('authentication_failed'); }
    return this.transaction(() => {
      if (ceremony.expires_at <= Date.now() || this.metadata().credential_epoch !== ceremony.credential_epoch) throw new AuthFailure('authentication_failed');
      const updated = this.db.prepare('UPDATE auth_credentials SET counter=? WHERE id=? AND counter=?').run(counter, stored.id, stored.counter);
      if (!updated.changes) throw new AuthFailure('authentication_failed');
      return this.createSession(Date.now());
    });
  }
}

export function sessionToken(header: string | undefined): string | undefined {
  const cookies = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('cfl_session='));
  return cookies.length === 1 ? cookies[0]!.slice('cfl_session='.length) : undefined;
}
export function sessionCookie(origin: string, token?: string): string {
  return `cfl_session=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionLifetime / 1000 : 0}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
