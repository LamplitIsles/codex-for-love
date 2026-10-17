import { constants } from 'node:fs';
import { open, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import koffi from 'koffi';
import sharp from 'sharp';

export const MAX_WORKSPACE_IMAGE_BYTES = 20 * 1024 * 1024;
const mediaTypes = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']]);
// Darwin fcntl is variadic (including on arm64). F_GETPATH=50 takes a
// MAXPATHLEN=1024 output buffer. This reads the opened vnode, not a pathname.
const darwinFcntl = process.platform === 'darwin'
  ? koffi.load('/usr/lib/libSystem.B.dylib').func('int fcntl(int fd, int cmd, ...)') : undefined;

async function descriptorPath(fd: number): Promise<string> {
  let path: string;
  if (darwinFcntl) {
    const output = Buffer.alloc(1024);
    if (darwinFcntl(fd, 50, 'void *', output) !== 0) throw new Error('Image path unavailable');
    const end = output.indexOf(0);
    if (end <= 0) throw new Error('Image path unavailable');
    path = new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, end));
  } else {
    path = await readlink(`/proc/self/fd/${fd}`);
  }
  // Both OS mechanisms report a full vnode path. Do not realpath that string:
  // a second pathname lookup could approve a different, substituted object.
  if (!isAbsolute(path) || path !== resolve(path)) throw new Error('Image path unavailable');
  return path;
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** Literal query path, never a Markdown URI: percent sequences are filenames. */
export async function readWorkspaceImage(workspace: string, path: string | null): Promise<{ bytes: Buffer; mediaType: string } | null> {
  if (!path || path !== path.trim() || /[\x00-\x1f\x7f-\x9f\\\uFFFD]/u.test(path)
    || /^[a-z][a-z0-9+.-]*:/iu.test(path) || path.startsWith('//')
    || path.split('/').includes('..') || !/\.(?:png|jpe?g|webp|gif)$/iu.test(path)) return null;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    const root = await realpath(workspace);
    const rootIdentity = await stat(root, { bigint: true });
    const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(rootHandle);
    const openedRoot = await rootHandle.stat({ bigint: true });
    if (!openedRoot.isDirectory() || openedRoot.dev !== rootIdentity.dev || openedRoot.ino !== rootIdentity.ino
      || await descriptorPath(rootHandle.fd) !== root) return null;
    const requested = resolve(root, path);
    const canonical = await realpath(requested);
    if (!contained(root, canonical)) return null;
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(MAX_WORKSPACE_IMAGE_BYTES)) return null;
    // Bind containment to the opened file; parent/leaf substitution cannot
    // redirect the descriptor after this check. No bytes have been read yet.
    if (!contained(root, await descriptorPath(file.fd)) || await descriptorPath(rootHandle.fd) !== root) return null;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (length !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return null;
    const bytes = buffer.subarray(0, length);
    const image = sharp(bytes, { animated: true, limitInputPixels: 100_000_000, failOn: 'error' });
    const metadata = await image.metadata();
    const mediaType = metadata.format && mediaTypes.get(metadata.format);
    if (!mediaType) return null;
    // Decode all frames, not just the header. stats avoids a large raw output.
    await image.stats();
    return { bytes, mediaType };
  } catch { return null; }
  finally { for (const handle of handles.reverse()) await handle.close(); }
}
