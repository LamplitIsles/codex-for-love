import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { fileRef, fileLimits, verifyAttachments, verifyStoredFile } from './files.ts';
import { FileOperationNotFound } from './store.ts';
import type { FileManifest, FileReservation, StagedFiles, Store, StoredFile } from './store.ts';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const manifestSchema = z.object({ sessionId: z.string().min(1).max(300), operationId: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u), files: z.array(z.object({ id: opaque, name: z.string().min(1).max(200), mediaType: z.string().max(255), size: z.number().int().min(0).max(100_000_000) }).strict()).min(1).max(6) }).strict();
export function validateManifest(value: unknown): FileManifest {
  const input = manifestSchema.parse(value);
  if (new Set(input.files.map(file => file.id)).size !== input.files.length || input.files.reduce((sum, file) => sum + file.size, 0) > fileLimits.maxMessageFileBytes) throw new Error('Invalid file manifest');
  return input;
}
type Owner = { ownerId: string; sessionId: string };
type Guard = { check: () => Promise<void>; commit: () => void };
function result(op: FileReservation) {
  if (!op.staged) throw new Error('Upload incomplete');
  return { sessionId: op.manifest.sessionId, operationId: op.manifest.operationId, files: op.staged.refs.map((ref, order) => ({ id: op.manifest.files[order]!.id, order, ref })) };
}
function status(op: FileReservation) {
  return { manifest: op.manifest, uploaded: op.files.filter(file => file.digest !== null).map(file => file.file_id), ...(op.staged ? { result: result(op) } : {}) };
}
export function createFileOperations(store: Store, attachments: string) {
  const active = new Set<string>();
  const root = join(resolve(attachments), '.file-operations');
  async function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (active.has(id) || active.size >= 4) throw new Error('Upload busy');
    active.add(id);
    try { return await action(); } finally { active.delete(id); }
  }
  async function syncDirectory(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function privateDirectory(path: string) {
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || typeof process.geteuid !== 'function' || before.uid !== BigInt(process.geteuid()) || (before.mode & 0o077n) !== 0n) throw new Error('Private file directory unavailable');
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat({ bigint: true });
      if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino || actual.uid !== before.uid || (actual.mode & 0o077n) !== 0n) throw new Error('Private file directory changed');
      return before;
    } finally { await handle.close(); }
  }
  async function privateRoot() {
    await verifyAttachments(attachments);
    let created = false;
    try { await mkdir(root, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await privateDirectory(root);
    if (created) await syncDirectory(attachments);
  }
  function directory(key: string) {
    if (!/^[a-f0-9]{32}$/u.test(key)) throw new Error('Invalid file directory');
    return join(root, key);
  }
  async function get(id: string, owner: Owner) { return store.fileReservation(id, owner.ownerId, owner.sessionId); }
  return {
    async reserve(value: unknown, owner: Owner, guard: Guard) {
      const manifest = validateManifest(value);
      if (manifest.sessionId !== owner.sessionId) throw new Error('Wrong session');
      return exclusive(manifest.operationId, async () => {
        await guard.check();
        const previous = await get(manifest.operationId, owner);
        if (previous) return status(await store.reserveFiles(manifest, owner.ownerId, previous.dirKey, guard.commit));
        await privateRoot();
        let key: string, path: string;
        for (;;) {
          key = randomBytes(16).toString('hex'); path = directory(key);
          try { await mkdir(path, { mode: 0o700 }); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        const owned = await privateDirectory(path);
        try {
          await syncDirectory(root); await guard.check();
          return status(await store.reserveFiles(manifest, owner.ownerId, key, guard.commit));
        } catch (error) {
          // A crash before the reservation commits may leave an empty directory.
          // Never sweep unregistered directories; an uncertain commit keeps it.
          try {
            if (!await store.hasFileDirectoryKey(key)) {
              const current = await privateDirectory(path);
              if (current.dev === owned.dev && current.ino === owned.ino && !(await readdir(path)).length) { await rmdir(path); await syncDirectory(root); }
            }
          } catch { /* preserve on uncertainty */ }
          throw error;
        }
      });
    },
    async protectRead<T>(id: string, action: () => Promise<T>): Promise<T | undefined> {
      // An operation being mutated by an upload must not be observed concurrently.
      if (active.has(id)) return undefined;
      return action();
    },
    async status(id: string, owner: Owner) { const op = await get(id, owner); return op ? status(op) : null; },
    async receive(id: string, fileId: string, source: AsyncIterable<Uint8Array>, owner: Owner, guard: Guard) {
      await exclusive(id, async () => {
        const op = await get(id, owner); if (!op) throw new FileOperationNotFound();
        const index = op.manifest.files.findIndex(file => file.id === fileId), entry = op.manifest.files[index], previous = op.files[index];
        if (!entry || !previous) throw new Error('Missing file');
        await privateRoot(); const path = directory(op.dirKey); await privateDirectory(path);
        const temporary = join(path, `p${index}.tmp`);
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let owned: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>> | undefined;
        try {
          if (!previous.digest) {
            const entries = await readdir(path);
            if (entries.some(name => name === `p${index}.tmp` || new RegExp(`^p${index}-[a-f0-9]{64}\\.file$`, 'u').test(name))) throw new Error('Interrupted upload; start a new attempt');
            handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            owned = await handle.stat();
            if (!owned.isFile() || owned.size !== 0 || (owned.mode & 0o077) !== 0 || (typeof process.geteuid === 'function' && owned.uid !== process.geteuid())) throw new Error('Private file unavailable');
          }
          const digest = createHash('sha256'), identity = createHash('sha256').update(JSON.stringify([id, index, entry.name, entry.mediaType]));
          let size = 0;
          for await (const chunk of source) {
            size += chunk.byteLength; if (size > entry.size) throw new Error('File too large');
            digest.update(chunk); identity.update(chunk);
            if (handle) { let offset = 0; while (offset < chunk.byteLength) { const written = await handle.write(chunk, offset, chunk.byteLength - offset); if (!written.bytesWritten) throw new Error('Short write'); offset += written.bytesWritten; } }
          }
          if (size !== entry.size) throw new Error('File size mismatch');
          if (handle) await handle.sync();
          const hash = digest.digest('hex'), attachmentId = identity.digest('hex');
          if (previous.digest !== null && (previous.digest !== hash || previous.attachment_id !== attachmentId)) throw new Error('File content conflict');
          await guard.check();
          const publication = previous.path ?? join(path, `p${index}-${hash}.file`);
          const file: StoredFile = { id: attachmentId, operation_id: id, owner_id: owner.ownerId, session_id: owner.sessionId, position: index, name: entry.name, media_type: entry.mediaType, size, path: publication };
          if (handle && owned) {
            const current = await lstat(temporary);
            if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('Temporary file changed');
            await link(temporary, publication);
            const published = await lstat(publication); if (!published.isFile() || published.dev !== owned.dev || published.ino !== owned.ino) throw new Error('Published file changed');
            await syncDirectory(path);
          }
          await verifyStoredFile(file, attachments); await guard.check();
          await store.recordFileUpload(op.manifest, owner.ownerId, fileId, { digest: hash, path: publication, attachmentId }, guard.commit);
        } finally {
          if (handle) await handle.close();
          if (owned) try {
            const current = await lstat(temporary);
            if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino) { await unlink(temporary); await syncDirectory(path); }
          } catch { /* preserve unknown or already removed entries */ }
        }
      });
    },
    async complete(id: string, owner: Owner, guard: Guard) {
      return exclusive(id, async () => {
        const op = await get(id, owner); if (!op) throw new FileOperationNotFound();
        const files: StoredFile[] = [];
        for (const [index, entry] of op.manifest.files.entries()) {
          const row = op.files[index]; if (!row?.digest || !row.path || !row.attachment_id) throw new Error('Upload incomplete');
          const file: StoredFile = { id: row.attachment_id, operation_id: id, owner_id: owner.ownerId, session_id: owner.sessionId, position: index, name: entry.name, media_type: entry.mediaType, size: entry.size, path: row.path };
          await verifyStoredFile(file, attachments); files.push(file);
        }
        const staged: StagedFiles = { files, refs: files.map(file => fileRef(file)) };
        await guard.check();
        return result({ ...op, staged: await store.completeFileReservation(op.manifest, owner.ownerId, staged, guard.commit) });
      });
    },
  };
}
