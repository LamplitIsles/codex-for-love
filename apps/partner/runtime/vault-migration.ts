import { constants, renameSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { acquirePrivateFileLock } from './private-file-lock.ts';
import { Vault, type VaultMigrationPhase, type VaultPurpose } from './vault.ts';

// These schemas describe the retired file formats, not current settings APIs.
const validKey = (v: string) => v.length > 0 && v.length <= 512 && v === v.trim() && !/[\x00-\x20\x7f]/u.test(v);
const key = z.string().refine(validKey);
const voice = z.string().min(1).max(512).refine(v => v === v.trim() && !/[\x00-\x1f\x7f]/u.test(v));
const speed = z.number().finite().min(0.5).max(2).nullable();
const retiredVoice = z.object({ region: z.enum(['beijing', 'singapore']), apiKey: key }).strict();
const tts = z.object({
  provider: z.enum(['minimax', 'alibaba', 'bytedance', 'elevenlabs']).nullable(),
  voices: z.object({ minimax: voice.optional(), alibaba: voice.optional(), bytedance: voice.optional(), elevenlabs: voice.optional() }).strict(),
  speeds: z.object({ minimax: speed.optional(), bytedance: speed.optional() }).strict(),
  keys: z.object({ alibaba: key.optional(), bytedance: key.optional(), elevenlabs: key.optional() }).strict(),
}).strict().refine(v => v.provider === null || !!v.voices[v.provider]);
const credentials = z.object({ speech: z.string().min(1).optional(), tts: z.string().min(1).optional(), keet: z.string().min(1).optional(), keet_receiver: z.string().min(1).optional(), post: z.string().min(1).optional(), post_receiver: z.string().min(1).optional() }).strict();
const markerSchema = z.object({ version: z.literal(1), voice: z.boolean(), tts: z.boolean(), credentials: z.boolean() }).strict();
type Marker = z.infer<typeof markerSchema>;
type Kind = 'voice' | 'tts' | 'credentials';
type Checkpoint = 'after-import' | 'before-file-sync' | 'after-rename' | 'after-replace' | 'before-completion-sync' | 'before-completion-commit';
type FaultHook = (checkpoint: Checkpoint, kind?: Kind) => void;
const names: Record<Kind, string> = { voice: 'voice-settings.json', tts: 'tts-settings.json', credentials: 'credentials.json' };
const source: Record<Kind, VaultPurpose> = { voice: 'migration.voice-source', tts: 'migration.tts-source', credentials: 'migration.credentials-source' };
const limits: Record<Kind, number> = { voice: 4096, tts: 16384, credentials: 65536 };
const kinds: Kind[] = ['voice', 'tts', 'credentials'];
const encodeMarker = (marker: Marker) => Buffer.from(JSON.stringify(marker));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class VaultMigrationError extends Error {
  constructor() { super('vault_migration_unavailable'); }
}

async function readPrivate(path: string, limit: number): Promise<unknown | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > limit) throw new VaultMigrationError();
    const bytes = await file.readFile();
    if (bytes.byteLength > limit) throw new VaultMigrationError();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await file.close(); }
}

async function syncDirectory(state: string): Promise<void> {
  const directory = await open(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function replacePrivate(state: string, path: string, value: unknown, kind: Kind, fault?: FaultHook): Promise<void> {
  const temp = join(state, `.voice-migration-${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); fault?.('before-file-sync', kind); await file.sync(); } finally { await file.close(); }
    renameSync(temp, path);
    fault?.('after-rename', kind);
    await syncDirectory(state);
  } finally { await unlink(temp).catch(() => {}); }
}

/** Call only after old versions have stopped writing the legacy files. */
export async function migrateVoiceSecrets(state: string, vault: Vault, options?: { fault?: FaultHook }): Promise<void> {
  let lock: Awaited<ReturnType<typeof acquirePrivateFileLock>> = null;
  try {
    for (let i = 0; i < 500 && !lock; i++) {
      lock = await acquirePrivateFileLock(join(state, 'voice-secrets-migration.lock'));
      if (!lock) await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!lock) throw new VaultMigrationError();
    const lockInfo = await lock.stat();
    if (!lockInfo.isFile() || (lockInfo.mode & 0o077) !== 0 || (process.getuid && lockInfo.uid !== process.getuid())) throw new VaultMigrationError();
    let progress = vault.transaction(tx => tx.getMigration('voice-secrets-v1'));
    if (progress?.phase === 'complete') { markerSchema.parse(JSON.parse(Buffer.from(progress.marker).toString())); return; }
    if (!progress) {
      const voiceFile = await readPrivate(join(state, names.voice), limits.voice);
      const ttsFile = await readPrivate(join(state, names.tts), limits.tts);
      const credsFile = await readPrivate(join(state, names.credentials), limits.credentials);
      const oldVoice = voiceFile === undefined ? undefined : retiredVoice.parse(voiceFile);
      const oldTts = ttsFile === undefined ? undefined : tts.parse(ttsFile);
      const oldCreds = credsFile === undefined ? undefined : credentials.parse(credsFile);
      const voiceCreds = oldCreds && { ...(oldCreds.speech === undefined ? {} : { speech: oldCreds.speech }), ...(oldCreds.tts === undefined ? {} : { tts: oldCreds.tts }) };
      const marker: Marker = { version: 1, voice: !!oldVoice, tts: !!oldTts, credentials: !!oldCreds };
      vault.transaction(tx => {
        if (tx.getMigration('voice-secrets-v1')) throw new VaultMigrationError();
        if (oldVoice) {
          if (!tx.putIfAbsent('migration.voice-source', JSON.stringify(oldVoice))) throw new VaultMigrationError();
          if (!tx.putIfAbsent('legacy.voice-input', JSON.stringify(oldVoice))) {
            const existing = tx.get('legacy.voice-input');
            if (existing === undefined || !equal(retiredVoice.parse(JSON.parse(existing)), oldVoice)) throw new VaultMigrationError();
          }
        }
        if (oldTts) { if (!tx.putIfAbsent('migration.tts-source', JSON.stringify(oldTts))) throw new VaultMigrationError(); tx.putIfAbsent('tts.settings', JSON.stringify(oldTts)); }
        if (voiceCreds) {
          if (!tx.putIfAbsent('migration.credentials-source', JSON.stringify(voiceCreds))) throw new VaultMigrationError();
          if (voiceCreds.speech !== undefined) tx.putIfAbsent('cli.speech', voiceCreds.speech);
          if (voiceCreds.tts !== undefined) tx.putIfAbsent('cli.tts', voiceCreds.tts);
        }
        tx.setMigration('voice-secrets-v1', { phase: 'imported', marker: encodeMarker(marker) });
      });
      progress = { phase: 'imported', marker: encodeMarker(marker) };
      options?.fault?.('after-import');
    }
    const marker = markerSchema.parse(JSON.parse(Buffer.from(progress.marker).toString()));
    if (progress.phase === 'imported') vault.transaction(tx => tx.setMigration('voice-secrets-v1', { phase: 'cleaning', marker: encodeMarker(marker) }));
    for (const kind of kinds) {
      const path = join(state, names[kind]);
      const current = await readPrivate(path, limits[kind]);
      if (!marker[kind]) { if (current !== undefined) throw new VaultMigrationError(); continue; }
      const snapshot = vault.get(source[kind]);
      if (snapshot === undefined || current === undefined) throw new VaultMigrationError();
      const old = JSON.parse(snapshot);
      let sanitized: unknown;
      if (kind === 'voice') {
        const original = retiredVoice.parse(old);
        sanitized = { region: original.region };
        if (!equal(current, sanitized) && !equal(retiredVoice.parse(current), original)) throw new VaultMigrationError();
      } else if (kind === 'tts') {
        const original = tts.parse(old);
        const now = tts.parse(current);
        sanitized = { ...original, keys: {} };
        if (!equal(now, sanitized) && !equal(now, original)) throw new VaultMigrationError();
      } else {
        const original = z.object({ speech: z.string().min(1).optional(), tts: z.string().min(1).optional() }).strict().parse(old);
        const now = credentials.parse(current);
        const currentVoice = { ...(now.speech === undefined ? {} : { speech: now.speech }), ...(now.tts === undefined ? {} : { tts: now.tts }) };
        if (!equal(currentVoice, {}) && !equal(currentVoice, original)) throw new VaultMigrationError();
        const { speech: _speech, tts: _tts, ...remaining } = now;
        sanitized = remaining;
      }
      if (!equal(current, sanitized)) { await replacePrivate(state, path, sanitized, kind, options?.fault); options?.fault?.('after-replace', kind); }
    }
    // A previous attempt may have renamed a file but failed to sync the directory.
    // Sync again before marking complete even when all files already look clean.
    options?.fault?.('before-completion-sync');
    await syncDirectory(state);
    vault.transaction(tx => {
      for (const kind of kinds) if (marker[kind]) tx.clear(source[kind]);
      options?.fault?.('before-completion-commit');
      tx.setMigration('voice-secrets-v1', { phase: 'complete' as VaultMigrationPhase, marker: encodeMarker(marker) });
    });
  } catch { throw new VaultMigrationError(); }
  finally { await lock?.close(); }
}
