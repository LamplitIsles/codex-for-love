import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { FileRef, FileUpload } from '@lamplit/contracts';
import type { StoredFile, StagedFiles } from './store.ts';

export const fileLimits = { maxFilesPerMessage: 6, maxFileBytes: 8_000_000, maxMessageFileBytes: 24_000_000 };
export { ownerId as fileOwner } from './auth.ts';

function fileId(operationId: string, position: number, name: string, mediaType: string, bytes: Uint8Array): string {
  return createHash('sha256').update(JSON.stringify([operationId, position, name, mediaType])).update(bytes).digest('hex');
}
async function verifyAttachments(attachments: string): Promise<void> {
  const root = dirname(dirname(attachments));
  const managed = dirname(attachments);
  const rootReal = await realpath(root);
  for (const [path, expected] of [[managed, join(rootReal, '.lamplit')], [attachments, join(rootReal, '.lamplit', 'attachments')]] as const) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== expected) throw new Error('File storage directory unavailable');
  }
}
export async function readStoredFile(file: StoredFile, attachments: string): Promise<Buffer> {
  const storedName = basename(file.path);
  const storedDigest = /^([a-f0-9]{64})(?:-[a-f0-9]{32})?\.file$/u.exec(storedName)?.[1];
  if (!storedDigest || resolve(file.path) !== join(resolve(attachments), storedName) || !/^[a-f0-9]{64}$/u.test(file.id)) throw new Error('Invalid file path');
  await verifyAttachments(attachments);
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.size || stat.size > fileLimits.maxFileBytes) throw new Error('File unavailable');
    const bytes = await handle.readFile();
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== storedDigest || fileId(file.operation_id,file.position,file.name,file.media_type,bytes) !== file.id) throw new Error('File changed');
    return bytes;
  } finally { await handle.close(); }
}
export function fileRef(file: StoredFile, availability: FileRef['availability'] = 'available'): FileRef {
  return { attachmentId: file.id, name: file.name, mediaType: file.media_type, size: file.size, availability };
}
async function syncAttachments(attachments: string): Promise<void> {
  const directory = await open(attachments, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
function unavailableFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : '';
  return code === 'ENOENT' || code === 'ELOOP' || message === 'File unavailable' || message === 'File changed';
}
export async function materializeFiles(input: FileUpload, ownerId: string, attachments: string, reuse?: readonly StoredFile[]): Promise<StagedFiles> {
  const managed = dirname(attachments);
  const managedStat = await lstat(managed);
  if (!managedStat.isDirectory() || managedStat.isSymbolicLink()) throw new Error('File storage directory unavailable');
  if (await realpath(managed) !== join(await realpath(dirname(managed)), '.lamplit')) throw new Error('File storage directory unavailable');
  await mkdir(attachments, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  await verifyAttachments(attachments);
  const files: StoredFile[] = [];
  for (const source of input.files) {
    const bytes = Buffer.from(source.data, 'base64');
    const id = fileId(input.operationId,source.order,source.name,source.mediaType,bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const file: StoredFile = { id, operation_id: input.operationId, owner_id: ownerId, session_id: input.sessionId, position: source.order, name: source.name, media_type: source.mediaType, size: bytes.length, path: join(attachments, `${digest}.file`) };
    if (reuse) {
      const sourceFile = reuse[source.order];
      if (!sourceFile || sourceFile.owner_id !== ownerId || sourceFile.session_id !== input.sessionId) throw new Error('Original file unavailable');
      file.path = sourceFile.path;
      await readStoredFile(file, attachments);
      await syncAttachments(attachments);
      files.push(file);
      continue;
    }
    try { await readStoredFile(file, attachments); await syncAttachments(attachments); files.push(file); continue; }
    catch (error) { if (!unavailableFile(error)) throw error; }
    const temporary = join(attachments, `.${randomUUID()}.tmp`);
    let owned: { dev: bigint; ino: bigint } | undefined;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat({ bigint: true });
        owned = { dev: stat.dev, ino: stat.ino };
        await handle.writeFile(bytes); await handle.sync();
      }
      finally { await handle.close(); }
      const temporaryEntry = await lstat(temporary, { bigint: true });
      if (!temporaryEntry.isFile() || temporaryEntry.dev !== owned.dev || temporaryEntry.ino !== owned.ino) throw new Error('Temporary file changed');
      let linked = false;
      try { await link(temporary, file.path); linked = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try { await readStoredFile(file, attachments); }
        catch (existingError) {
          if (!unavailableFile(existingError)) throw existingError;
          // A corrupt or symlinked shared path is never removed or overwritten.
          // Publish this copy under its digest and an independent opaque suffix.
          file.path = join(attachments, `${digest}-${randomUUID().replaceAll('-', '')}.file`);
          await link(temporary, file.path); linked = true;
        }
      }
      if (linked) {
        const published = await lstat(file.path, { bigint: true });
        if (!published.isFile() || published.dev !== owned.dev || published.ino !== owned.ino) throw new Error('Published file changed');
      }
      await readStoredFile(file, attachments);
      await syncAttachments(attachments);
      files.push(file);
    } finally {
      if (owned) {
        const entry = await lstat(temporary, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
        if (entry?.isFile() && entry.dev === owned.dev && entry.ino === owned.ino) await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
    }
  }
  return { files, refs: files.map(file => fileRef(file)) };
}
