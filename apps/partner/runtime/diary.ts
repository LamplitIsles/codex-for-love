import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { DiaryEntry } from '@lamplit/contracts';

export const MAX_DIARY_ENTRY_BYTES = 128 * 1024;
const datedName = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\.md$/u;
async function memoryRoot(workspace: string) {
  const root = await realpath(join(workspace, 'memory'));
  const name = relative(await realpath(workspace), root);
  if (name === '..' || name.startsWith('../') || isAbsolute(name)) throw new Error('Unsafe diary directory');
  return root;
}
export async function listDiary(workspace: string) {
  let root: string;
  try { root = await memoryRoot(workspace); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const entries = await Promise.all((await readdir(root)).filter(name => datedName.test(name)).map(async name => {
    try { const info = await lstat(join(root, name)); return info.isFile() && !info.isSymbolicLink() ? name : undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }));
  return entries.filter((name): name is string => name !== undefined).sort().reverse();
}
export async function readDiary(workspace: string, name: string): Promise<DiaryEntry> {
  if (!datedName.test(name)) return { name, status: 'missing' };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await memoryRoot(workspace);
    handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return { name, status: 'missing' };
    if (info.size > MAX_DIARY_ENTRY_BYTES) return { name, status: 'too-large' };
    const bytes = Buffer.alloc(MAX_DIARY_ENTRY_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_DIARY_ENTRY_BYTES) return { name, status: 'too-large' };
    const text = bytes.subarray(0, size).toString('utf8');
    return Buffer.byteLength(text) > MAX_DIARY_ENTRY_BYTES ? { name, status: 'too-large' } : { name, status: 'found', text };
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return { name, status: 'missing' };
    throw error;
  } finally { await handle?.close(); }
}
