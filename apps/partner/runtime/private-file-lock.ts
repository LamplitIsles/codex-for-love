import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

// Resolve glibc, musl or libSystem lazily when a private lock is needed.
let nativeLock: Promise<{ flock: (fd: number, operation: number) => number; errno: () => number; wouldBlock: number; again: number }> | undefined;
async function lockApi() {
  return nativeLock ??= import('koffi').then(({default:koffi}) => ({
    flock: koffi.load(null).func('int flock(int fd, int operation)'),
    errno: () => koffi.errno(), wouldBlock: koffi.os.errno.EWOULDBLOCK, again: koffi.os.errno.EAGAIN,
  }));
}
export async function acquirePrivateFileLock(path: string, options: { existing?: boolean } = {}) {
  const { flock } = await lockApi();
  const file = await open(path, (options.existing ? 0 : constants.O_CREAT) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  if (flock(file.fd, 2 | 4) !== 0) { await file.close(); return null; }
  // Keep the inode; the kernel releases its lock on close or process exit.
  return file;
}

export async function unlockPrivateFileLock(file: { fd: number }): Promise<void> {
  const { flock } = await lockApi();
  if (flock(file.fd, 8) !== 0) throw new Error('Could not release private lock');
}

/** Confirm a private descriptor still names the same regular pathname. */
export async function privateFileIdentity(path: string, file: FileHandle) {
  const [opened, named] = await Promise.all([file.stat(), lstat(path)]);
  return opened.isFile() && named.isFile() && opened.dev === named.dev && opened.ino === named.ino && opened.nlink === 1
    && (opened.mode & 0o077) === 0 && (!process.geteuid || opened.uid === process.geteuid()) ? opened : undefined;
}

/** Probe an existing private inode without creating it. Only lock contention is
 * proof of a publisher; unexpected flock errors must fail closed. */
export async function privateFileLockHeld(path: string): Promise<boolean> {
  const api = await lockApi();
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = await privateFileIdentity(path, file);
    if (!opened) throw new Error('Invalid private lock file');
    // Shared probes never contend with one another. Only the publisher's
    // exclusive lock can make this attempt report contention.
    const result = api.flock(file.fd, 1 | 4);
    const errno = result === 0 ? 0 : api.errno();
    if (result !== 0 && errno !== api.wouldBlock && errno !== api.again) throw new Error('Could not inspect private lock');
    const after = await lstat(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) throw new Error('Private lock changed');
    return result !== 0;
  } finally { await file.close(); }
}
