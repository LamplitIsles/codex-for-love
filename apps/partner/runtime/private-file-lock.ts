import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// Resolve glibc, musl or libSystem only when a settings write needs a lock.
let nativeLock: Promise<(fd: number, operation: number) => number> | undefined;
export async function acquirePrivateFileLock(path: string) {
  const flock = await (nativeLock ??= import('koffi').then(({default:koffi}) =>
    koffi.load(null).func('int flock(int fd, int operation)')));
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  if (flock(file.fd, 2 | 4) !== 0) { await file.close(); return null; }
  // Keep the inode; the kernel releases its lock on close or process exit.
  return file;
}
