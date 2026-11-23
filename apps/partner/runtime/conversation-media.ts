import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { acquirePrivateFileLock, privateFileIdentity, privateFileLockHeld, unlockPrivateFileLock } from './private-file-lock.ts';

const fileSchema = z.object({ attachmentId: z.string().regex(/^[a-f0-9]{64}$/u), name: z.string(), size: z.number().int().nonnegative(), mediaType: z.string(), path: z.string() }).strict();
const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('voice'), messageId: z.string().min(1), createdAt: z.number().int().nonnegative(), voice: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u) }).strict() }).strict(),
  z.object({ kind: z.literal('file'), messageId: z.string().min(1), createdAt: z.number().int().nonnegative(), file: fileSchema }).strict(),
]);
const projectionSchema = z.object({ version: z.literal(2), sessionId: z.string().min(1), generation: z.string().regex(/^[a-f0-9]{32}$/u), key: z.string().regex(/^[a-f0-9]{64}$/u), entries: z.array(entrySchema) }).strict();
export type MediaEntry = z.infer<typeof entrySchema>;
export type MediaKind = MediaEntry['kind'];
export function voiceMessageId(resultId: string, itemId: string, audioId: string): string {
  return `voice:${createHash('sha256').update(JSON.stringify([resultId, itemId, audioId])).digest('hex')}`;
}
export function mediaKey(): string { return randomBytes(32).toString('hex'); }
const lockPath = (path: string, generation: string) => join(dirname(path), `conversation-media-${generation}.lock`);
/** The caller holds the stable writer lock, so no generation owner is live. */
async function cleanupMediaLocks(path: string): Promise<void> {
  for (const name of await readdir(dirname(path))) {
    if (!/^conversation-media-[a-f0-9]{32}\.lock$/u.test(name)) continue;
    const candidate = join(dirname(path), name);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(candidate, constants.O_RDWR | constants.O_NOFOLLOW);
      if (await privateFileIdentity(candidate, file)) await unlink(candidate);
    } catch { /* Cleanup is best effort; readers still require a live lock. */ }
    finally { await file?.close().catch(() => undefined); }
  }
}
export async function createMediaPublisher(path: string) {
  // The stable lock serializes publishers across shutdown/startup. It is never
  // unlinked: replacing its inode would permit two independent owners.
  const writerPath = join(dirname(path), 'conversation-media-writer.lock');
  const writer = await acquirePrivateFileLock(writerPath);
  if (!writer) throw new Error('Another media publisher is active');
  try {
    if (!await privateFileIdentity(writerPath, writer)) throw new Error('Invalid media writer lock');
    await cleanupMediaLocks(path).catch(() => undefined);
  } catch (error) { await writer.close().catch(() => undefined); throw error; }
  const generation = randomBytes(16).toString('hex'), lock = lockPath(path, generation);
  let created: Awaited<ReturnType<typeof open>>;
  try { created = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) { await writer.close().catch(() => undefined); throw error; }
  let held: Awaited<ReturnType<typeof acquirePrivateFileLock>> = null;
  try {
    held = await acquirePrivateFileLock(lock, { existing: true });
    const original = await created.stat(), current = held && await held.stat();
    if (!held || !current || original.dev !== current.dev || original.ino !== current.ino || !await privateFileIdentity(lock, held)) throw new Error('Media lock unavailable');
  } catch (error) {
    await held?.close().catch(() => undefined);
    if (await privateFileIdentity(lock, created).catch(() => undefined)) await unlink(lock).catch(() => undefined);
    await writer.close().catch(() => undefined);
    throw error;
  } finally { await created.close().catch(() => undefined); }
  const owner = held;
  let revoked = false, closed = false;
  async function revoke() {
    if (revoked) return;
    revoked = true;
    // Unlock first so readers fail closed even when removing the pathname or
    // closing the descriptor subsequently encounters a filesystem error.
    await unlockPrivateFileLock(owner).catch(() => undefined);
    try {
      if (await privateFileIdentity(lock, owner).catch(() => undefined)) await unlink(lock).catch(() => undefined);
    } finally { await owner.close(); }
  }
  return {
    async publish(sessionId: string, key: string, entries: readonly MediaEntry[]) {
      if (revoked || closed || !await privateFileIdentity(lock, owner) || !await privateFileIdentity(writerPath, writer)) throw new Error('Media publisher unavailable');
      const value = projectionSchema.parse({ version: 2, sessionId, generation, key, entries });
      const temp = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
      finally { await unlink(temp).catch(() => undefined); }
    },
    revoke,
    async close() {
      if (closed) return;
      closed = true;
      try { await revoke(); } finally { await writer.close(); }
    },
  };
}
function identity(entry: MediaEntry): string { return JSON.stringify([entry.messageId, entry.kind === 'file' ? entry.file.attachmentId : '']); }
export async function readMediaPage(path: string, markerPath: string, expectedSession: string | undefined, kind: MediaKind, cursor?: string): Promise<{items: unknown[]; nextCursor: string | null}> {
  const [raw, marker] = await Promise.all([readFile(path, 'utf8'), readFile(markerPath, 'utf8')]);
  const projection = projectionSchema.parse(JSON.parse(raw));
  const current = z.object({ threadId: z.string().min(1) }).passthrough().parse(JSON.parse(marker));
  if (current.threadId !== projection.sessionId || (expectedSession !== undefined && expectedSession !== projection.sessionId)) throw new Error('Wrong or unavailable session');
  const lock = lockPath(path, projection.generation);
  if (!await privateFileLockHeld(lock)) throw new Error('Media directory unavailable');
  const sign = (payload: string) => createHmac('sha256', Buffer.from(projection.key, 'hex')).update(payload).digest();
  let after: [number, string] | undefined;
  if (cursor) {
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra || cursor.length > 4096) throw new Error('Invalid cursor');
    const actual = Buffer.from(signature, 'base64url'), expected = sign(payload);
    if (actual.toString('base64url') !== signature || Buffer.from(payload, 'base64url').toString('base64url') !== payload || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid cursor');
    const decoded = z.tuple([z.string(), z.enum(['voice', 'file']), z.number().int().nonnegative(), z.string()]).parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (decoded[0] !== projection.sessionId || decoded[1] !== kind) throw new Error('Invalid cursor scope');
    after = [decoded[2], decoded[3]];
  }
  const entries = projection.entries.filter(entry => entry.kind === kind && (!after || entry.createdAt < after[0] || (entry.createdAt === after[0] && identity(entry) < after[1])))
    .sort((a, b) => b.createdAt - a.createdAt || (identity(a) < identity(b) ? 1 : identity(a) > identity(b) ? -1 : 0));
  const selected = entries.slice(0, 30);
  const items = await Promise.all(selected.map(async entry => {
    if (entry.kind === 'voice') return { messageId: entry.messageId, createdAt: entry.createdAt, voice: entry.voice };
    const { path: filePath, ...file } = entry.file;
    const availability = await lstat(filePath).then(info => info.isFile() && !info.isSymbolicLink() && info.size === file.size ? 'available' : 'missing', () => 'missing');
    return { messageId: entry.messageId, createdAt: entry.createdAt, file: { ...file, availability } };
  }));
  const last = selected.at(-1);
  const payload = last && entries.length > selected.length ? Buffer.from(JSON.stringify([projection.sessionId, kind, last.createdAt, identity(last)])).toString('base64url') : undefined;
  // A scope change or an index replacement during filesystem checks must not
  // let an older view escape after the new one has been published.
  const [finalRaw, finalMarker] = await Promise.all([readFile(path, 'utf8'), readFile(markerPath, 'utf8')]);
  if (raw !== finalRaw || marker !== finalMarker || !await privateFileLockHeld(lock)) throw new Error('Media directory changed during read');
  return { items, nextCursor: payload ? `${payload}.${sign(payload).toString('base64url')}` : null };
}
