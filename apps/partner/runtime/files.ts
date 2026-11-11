import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { FileRef } from '@lamplit/contracts';
import type { StoredFile } from './store.ts';

export const fileLimits = { maxFilesPerMessage: 6, maxFileBytes: 100_000_000, maxMessageFileBytes: 200_000_000 };
export { ownerId as fileOwner } from './auth.ts';

export async function verifyAttachments(attachments: string): Promise<void> {
  const root = dirname(dirname(attachments));
  const managed = dirname(attachments);
  const rootReal = await realpath(root);
  for (const [path, expected] of [[managed, join(rootReal, '.lamplit')], [attachments, join(rootReal, '.lamplit', 'attachments')]] as const) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== expected) throw new Error('File storage directory unavailable');
  }
}
async function openStoredFile(file: StoredFile, attachments: string) {
  const storedName = basename(file.path);
  const legacyDigest = /^([a-f0-9]{64})-o[a-fA-F0-9]{32}-[a-f0-9]{32}\.file$/u.exec(storedName)?.[1];
  const current = /^p([0-5])-([a-f0-9]{64})\.file$/u.exec(storedName);
  const directory = dirname(resolve(file.path)), root = join(resolve(attachments), '.file-operations');
  const isCurrent = !!current && Number(current[1]) === file.position && dirname(directory) === root && /^[a-f0-9]{32}$/u.test(basename(directory));
  const storedDigest = isCurrent ? current![2] : legacyDigest;
  if (!storedDigest || (!isCurrent && resolve(file.path) !== join(resolve(attachments), storedName)) || !/^[a-f0-9]{64}$/u.test(file.id)) throw new Error('Invalid file path');
  await verifyAttachments(attachments);
  if (isCurrent) for (const path of [root, directory]) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || (typeof process.geteuid === 'function' && entry.uid !== process.geteuid()) || await realpath(path) !== join(await realpath(attachments), relative(resolve(attachments), path))) throw new Error('File storage directory unavailable');
  }
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = await handle.stat().catch(async error => { await handle.close(); throw error; });
  if (!stat.isFile() || stat.size !== file.size || stat.size > fileLimits.maxFileBytes) { await handle.close(); throw new Error('File unavailable'); }
  return { handle, storedDigest };
}
async function verifyHandle(file: StoredFile, handle: Awaited<ReturnType<typeof open>>, storedDigest: string): Promise<void> {
  const digest = createHash('sha256');
  const identity = createHash('sha256').update(JSON.stringify([file.operation_id, file.position, file.name, file.media_type]));
  {
    let count = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > file.size) throw new Error('File changed');
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk); identity.update(chunk);
    }
    if (count !== file.size || digest.digest('hex') !== storedDigest || identity.digest('hex') !== file.id) throw new Error('File changed');
  }
}
export async function verifyStoredFile(file: StoredFile, attachments: string): Promise<void> {
  const { handle, storedDigest } = await openStoredFile(file, attachments);
  try { await verifyHandle(file, handle, storedDigest); } finally { await handle.close(); }
}
export async function openVerifiedFile(file: StoredFile, attachments: string) {
  const { handle, storedDigest } = await openStoredFile(file, attachments);
  try { await verifyHandle(file, handle, storedDigest); }
  catch (error) { await handle.close(); throw error; }
  return handle;
}
export function fileRef(file: StoredFile, availability: FileRef['availability'] = 'available'): FileRef {
  return { attachmentId: file.id, name: file.name, mediaType: file.media_type, size: file.size, availability };
}
