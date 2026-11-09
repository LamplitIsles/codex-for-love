// Local synthetic frontend development host. Never use with a real workspace.
import { once } from 'node:events';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.ts';
import { developmentNow, seedDevelopment } from './frontend-development-seed.ts';
import { createWebServer } from './web-server.ts';

const marker = 'CFL synthetic frontend development fixture v1\n';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.scratch/frontend-development-fixture/state');

async function verifyTree(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error(`Unsafe development data entry: ${path}`);
    if (info.isDirectory()) await verifyTree(path);
  }
}

// The lock is deliberately conservative: after a crash it must be inspected and
// removed manually, never guessed stale from a PID that may have been reused.
async function acquire(directory: string, create: boolean) {
  directory = resolve(directory);
  if (await realpath(dirname(directory)) !== dirname(directory)) throw new Error('Development parent must not contain symlinks');
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, 'MARKER'), marker, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const markerPath = join(directory, 'MARKER');
  const markerInfo = await lstat(markerPath);
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory || !markerInfo.isFile() || markerInfo.nlink !== 1 || await readFile(markerPath, 'utf8') !== marker) throw new Error('Not a verified development directory');
  const lock = join(directory, 'LOCK');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Development fixture is active or has an uninspected stale lock'); throw error; }
  try { await writeFile(join(lock, 'pid'), `${process.pid}\n`, { flag: 'wx' }); }
  catch (error) { await rm(lock, { recursive: true }); throw error; }
  return async () => { await rm(lock, { recursive: true }); };
}

export async function resetDevelopment(directory: string) {
  const release = await acquire(directory, false);
  try {
    // Keep this outside data so a partial recursive deletion cannot erase it.
    const resetting = join(directory, 'RESETTING');
    try { await mkdir(resetting, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(resetting)).isDirectory()) throw error;
    }
    const data = join(directory, 'data');
    try { if ((await lstat(data)).isSymbolicLink()) throw new Error('Refusing symlinked development data'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rm(data, { recursive: true, force: true });
    await rmdir(resetting);
  } finally { await release(); }
}

export async function startDevelopment(directory: string, port: number) {
  const release = await acquire(directory, true);
  let app: ReturnType<typeof createWebServer> | undefined;
  let partner: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['createPartner']>> | undefined;
  let socketDirectory: string | undefined;
  try {
    try { await lstat(join(directory, 'RESETTING')); throw new Error('Incomplete reset; run reset explicitly before starting'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const data = join(directory, 'data');
    let first = false;
    try { await mkdir(data, { mode: 0o700 }); first = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if ((await lstat(data)).isSymbolicLink() || await realpath(data) !== data) throw new Error('Refusing symlinked development data');
    if (!first) {
      await verifyTree(data);
      if (await readFile(join(data, 'SEEDED'), 'utf8') !== marker) throw new Error('Incomplete development seed; stop and reset explicitly');
    }
    const f = await fixture(data);
    // Profile images must be inside the workspace. Preserve an existing sample
    // path so restarts never overwrite a developer's chosen image.
    const profileDir = join(f.workspace, '.lamplit', 'profile');
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const avatar = join(profileDir, 'development-companion.jpg');
    try { await copyFile(new URL('./fixtures/frontend-development/companion-avatar.jpg', import.meta.url), avatar, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    // The TOML schema requires a pair, but the runtime supports a missing user
    // avatar. This in-memory, synthetic fixture deliberately configures only Mica.
    f.config.avatars = { companion: avatar } as NonNullable<typeof f.config.avatars>;
    if (first) {
      await seedDevelopment(f.workspace, f.appServer.env.FAKE_SERVER_STATE!);
      await writeFile(join(data, 'SEEDED'), marker, { flag: 'wx' });
    }
    await writeFile(join(data, 'control.json'), JSON.stringify({ completedText: '【模拟回复】这是本地开发夹具的回复。' }));
    socketDirectory = await mkdtemp(join(tmpdir(), 'cfl-dev-socket-'));
    f.config.codex.socket_path = join(socketDirectory, 'codex.sock');
    partner = await f.createPartner({ now: () => developmentNow });
    app = createWebServer(partner, join(data, 'assets'));
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    return { origin, async close() { await app!.close(); await rm(socketDirectory!, { recursive: true, force: true }); await release(); } };
  } catch (error) {
    // Keep the lock if shutdown itself fails: the fake server may still be live.
    if (app) await app.close(); else await partner?.close();
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    await release();
    throw error;
  }
}

if (process.argv[1] === import.meta.filename) {
  const command = process.argv[2];
  if (command === 'reset' && process.argv.length === 3) { await resetDevelopment(root); console.log(`Reset ${root}; next start will seed it.`); }
  else if (command === 'start' && process.argv.length <= 4) {
    const port = Number(process.argv[3] ?? 3090);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    await mkdir(dirname(root), { recursive: true });
    const host = await startDevelopment(root, port);
    console.log(`Synthetic development fixture: ${host.origin}\nState: ${root}\nLocal only; no real authentication or model.`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().then(() => process.exit(0)); });
  } else throw new Error('Usage: frontend-development-host.ts start [port] | reset');
}
