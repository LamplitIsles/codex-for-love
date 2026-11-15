import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquirePrivateFileLock } from './private-file-lock.ts';
import { initializeVaultSchema } from './vault-schema.ts';

// These are server-owned purposes, not identifiers supplied by an HTTP client.
export const vaultPurposes = [
  'tts.settings', 'cli.speech', 'cli.tts', 'bark.settings', 'legacy.voice-input',
  'migration.voice-source', 'migration.tts-source', 'migration.credentials-source',
] as const;
export type VaultPurpose = typeof vaultPurposes[number];
export type VaultMigration = 'voice-secrets-v1';
export type VaultMigrationPhase = 'imported' | 'cleaning' | 'complete';
export type VaultMigrationState = { phase: VaultMigrationPhase; marker: Uint8Array };
const owner = 'owner';
const challenge = 'CFL vault master key verification v1';
const maxValueBytes = 64 * 1024;
const maxMarkerBytes = 4096;
const migrationPhases: readonly string[] = ['imported', 'cleaning', 'complete'];
const aad = (purpose: string, keyId: string) => Buffer.from(JSON.stringify(['cfl-vault', 1, owner, purpose, keyId]));

export class VaultError extends Error {
  readonly code: 'vault_unavailable' | 'vault_unauthorized' | 'vault_invalid_value';
  constructor(code: 'vault_unavailable' | 'vault_unauthorized' | 'vault_invalid_value') { super(code); this.code = code; }
}

type Encrypted = { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };
type ValueRow = Encrypted & { key_id: string; deleted: number };
type MetaRow = Encrypted & { key_id: string };

function seal(key: Buffer, keyId: string, purpose: string, plaintext: string): Encrypted {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(purpose, keyId));
  return { nonce, ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]), tag: cipher.getAuthTag() };
}

function unseal(key: Buffer, keyId: string, purpose: string, record: Encrypted): string {
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, record.nonce);
    cipher.setAAD(aad(purpose, keyId));
    cipher.setAuthTag(record.tag);
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([cipher.update(record.ciphertext), cipher.final()]));
  } catch { throw new VaultError('vault_unavailable'); }
}

async function privateFile(path: string): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size !== 32) throw new VaultError('vault_unavailable');
    const data = await file.readFile();
    if (data.length !== 32) throw new VaultError('vault_unavailable');
    return data;
  } finally { await file.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}

type DirectorySyncPoint = 'key-published' | 'key-recovered';
type BeforeDirectorySync = (point: DirectorySyncPoint) => void;

async function publishMasterKey(state: string, path: string, beforeDirectorySync?: BeforeDirectorySync): Promise<Buffer> {
  const key = randomBytes(32);
  const temp = join(state, `.vault-key-${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(key); await file.sync(); } finally { await file.close(); }
    // link is an atomic create-if-absent; it never replaces an existing key.
    await link(temp, path);
    beforeDirectorySync?.('key-published');
    await syncDirectory(state);
    return key;
  } finally { await unlink(temp).catch(() => {}); }
}

export interface VaultTransaction {
  get(purpose: VaultPurpose): string | undefined;
  put(purpose: VaultPurpose, value: string): void;
  /** A tombstone counts as present, so old migration data cannot resurrect it. */
  putIfAbsent(purpose: VaultPurpose, value: string): boolean;
  clear(purpose: VaultPurpose): void;
  /** Marker data is non-secret recovery metadata, never plaintext credentials. */
  getMigration(name: VaultMigration): VaultMigrationState | undefined;
  setMigration(name: VaultMigration, state: VaultMigrationState): void;
  /** Persist an attempt before sending; false means this turn was already claimed. */
  claimNotification(threadId: string, turnId: string): boolean;
}

/** Private, independently backed-up server secret store shared by local processes. */
export class Vault {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly keyId: string;
  private constructor(db: DatabaseSync, key: Buffer, keyId: string) { this.db = db; this.key = key; this.keyId = keyId; }

  static async open(state: string, options?: { beforeDirectorySync?: BeforeDirectorySync }): Promise<Vault> {
    let db: DatabaseSync | undefined;
    let lock: Awaited<ReturnType<typeof acquirePrivateFileLock>> = null;
    try {
      await mkdir(state, { recursive: true, mode: 0o700 });
      const directory = await open(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stat = await directory.stat();
        if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new VaultError('vault_unavailable');
      } finally { await directory.close(); }
      for (let i = 0; i < 500 && !lock; i++) {
        lock = await acquirePrivateFileLock(join(state, 'vault.lock'));
        if (!lock) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!lock) throw new VaultError('vault_unavailable');
      const lockStat = await lock.stat();
      if (!lockStat.isFile() || (lockStat.mode & 0o077) !== 0 || (process.getuid && lockStat.uid !== process.getuid())) throw new VaultError('vault_unavailable');
      const keyPath = join(state, 'vault-key');
      const databasePath = join(state, 'vault.sqlite');
      let key = await privateFile(keyPath);
      let dbFile;
      try { dbFile = await open(databasePath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || key) throw error;
        dbFile = await open(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        await dbFile.sync();
        await syncDirectory(state);
      }
      try {
        const stat = await dbFile.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new VaultError('vault_unavailable');
      } finally { await dbFile.close(); }
      db = new DatabaseSync(databasePath);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      initializeVaultSchema(db);
      const meta = db.prepare('SELECT key_id, nonce, ciphertext, tag FROM vault_meta WHERE id=1').get() as MetaRow | undefined;
      if (!meta) {
        // An unbound database can only be initialized if it has no prior state.
        for (const table of ['vault_values', 'vault_migrations', 'notification_attempts']) {
          if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new VaultError('vault_unavailable');
        }
        if (key) {
          // A previous process may have linked the key but failed before its
          // directory sync. Make that link durable before binding metadata.
          options?.beforeDirectorySync?.('key-recovered');
          await syncDirectory(state);
        } else key = await publishMasterKey(state, keyPath, options?.beforeDirectorySync);
        const id = createHash('sha256').update(key).digest('hex');
        const proof = seal(key, id, 'master-check', challenge);
        db.prepare('INSERT INTO vault_meta (id,key_id,nonce,ciphertext,tag) VALUES (1,?,?,?,?)').run(id, proof.nonce, proof.ciphertext, proof.tag);
      } else {
        if (!key || createHash('sha256').update(key).digest('hex') !== meta.key_id || unseal(key, meta.key_id, 'master-check', meta) !== challenge) throw new VaultError('vault_unavailable');
      }
      const id = createHash('sha256').update(key).digest('hex');
      const result = new Vault(db, key, id);
      db = undefined;
      return result;
    } catch {
      db?.close();
      throw new VaultError('vault_unavailable');
    } finally { await lock?.close(); }
  }

  transaction<T>(operation: (tx: VaultTransaction) => T, authorized: () => boolean = () => true): T {
    const db = this.db;
    let active = true;
    const validate = (purpose: VaultPurpose) => {
      if (!active || !(vaultPurposes as readonly string[]).includes(purpose)) throw new VaultError('vault_invalid_value');
    };
    const row = (purpose: VaultPurpose) => {
      validate(purpose);
      return db.prepare('SELECT key_id,deleted,nonce,ciphertext,tag FROM vault_values WHERE owner_id=? AND purpose=?').get(owner, purpose) as ValueRow | undefined;
    };
    const put = (purpose: VaultPurpose, value: string) => {
      validate(purpose);
      if (typeof value !== 'string' || Buffer.byteLength(value) > maxValueBytes) throw new VaultError('vault_invalid_value');
      const previous = row(purpose);
      if (previous && previous.key_id !== this.keyId) throw new VaultError('vault_unavailable');
      if (previous && !previous.deleted) unseal(this.key, this.keyId, purpose, previous);
      const encrypted = seal(this.key, this.keyId, purpose, value);
      db.prepare(`INSERT INTO vault_values (owner_id,purpose,key_id,revision,deleted,nonce,ciphertext,tag) VALUES (?,?,?,1,0,?,?,?)
        ON CONFLICT(owner_id,purpose) DO UPDATE SET key_id=excluded.key_id,revision=revision+1,deleted=0,nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag`)
        .run(owner, purpose, this.keyId, encrypted.nonce, encrypted.ciphertext, encrypted.tag);
    };
    const tx: VaultTransaction = {
      get: purpose => {
        const value = row(purpose);
        if (!value) return undefined;
        if (value.key_id !== this.keyId) throw new VaultError('vault_unavailable');
        return value.deleted ? undefined : unseal(this.key, this.keyId, purpose, value);
      },
      put,
      putIfAbsent: (purpose, value) => { if (row(purpose)) return false; put(purpose, value); return true; },
      clear: purpose => {
        validate(purpose);
        const previous = row(purpose);
        if (previous && previous.key_id !== this.keyId) throw new VaultError('vault_unavailable');
        if (previous && !previous.deleted) unseal(this.key, this.keyId, purpose, previous);
        db.prepare(`INSERT INTO vault_values (owner_id,purpose,key_id,revision,deleted,nonce,ciphertext,tag) VALUES (?,?,?,1,1,NULL,NULL,NULL)
          ON CONFLICT(owner_id,purpose) DO UPDATE SET key_id=excluded.key_id,revision=revision+1,deleted=1,nonce=NULL,ciphertext=NULL,tag=NULL`).run(owner, purpose, this.keyId);
      },
      getMigration: name => {
        if (!active || name !== 'voice-secrets-v1') throw new VaultError('vault_invalid_value');
        const value = db.prepare('SELECT phase,marker FROM vault_migrations WHERE name=?').get(name) as { phase: string; marker: Uint8Array } | undefined;
        if (!value) return undefined;
        if (!migrationPhases.includes(value.phase) || !(value.marker instanceof Uint8Array) || value.marker.byteLength > maxMarkerBytes) throw new VaultError('vault_unavailable');
        return { phase: value.phase as VaultMigrationPhase, marker: Uint8Array.from(value.marker) };
      },
      setMigration: (name, state) => {
        if (!active || name !== 'voice-secrets-v1' || !state || !migrationPhases.includes(state.phase)
          || !(state.marker instanceof Uint8Array) || state.marker.byteLength > maxMarkerBytes) throw new VaultError('vault_invalid_value');
        const previous = tx.getMigration(name);
        if (previous && migrationPhases.indexOf(state.phase) < migrationPhases.indexOf(previous.phase)) throw new VaultError('vault_invalid_value');
        db.prepare(`INSERT INTO vault_migrations (name,phase,marker) VALUES (?,?,?)
          ON CONFLICT(name) DO UPDATE SET phase=excluded.phase,marker=excluded.marker`).run(name, state.phase, state.marker);
      },
      claimNotification: (threadId, turnId) => {
        if (!active || [threadId, turnId].some(id => typeof id !== 'string' || !id || id.length > 512 || /[\x00-\x1f\x7f]/u.test(id))) throw new VaultError('vault_invalid_value');
        return Number(db.prepare('INSERT INTO notification_attempts (thread_id,turn_id,attempted_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(threadId, turnId, Date.now()).changes) === 1;
      },
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(tx);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new VaultError('vault_invalid_value');
      if (!authorized()) throw new VaultError('vault_unauthorized');
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { active = false; }
  }

  get(purpose: VaultPurpose): string | undefined { return this.transaction(tx => tx.get(purpose)); }
  put(purpose: VaultPurpose, value: string, authorized?: () => boolean): void { this.transaction(tx => tx.put(purpose, value), authorized); }
  clear(purpose: VaultPurpose, authorized?: () => boolean): void { this.transaction(tx => tx.clear(purpose), authorized); }
  close(): void { this.db.close(); this.key.fill(0); }
}
