import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function snapshotHandler(bytes, requests) {
  return (request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.method !== 'GET' || request.url !== '/snapshot.tgz') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
  };
}

export function verifySnapshotRequests(requests) {
  if (!requests.length || requests.some(({ method, path }) => method !== 'GET' || path !== '/snapshot.tgz')) {
    throw new Error('Forgejo must receive only GET requests for the exact snapshot tarball');
  }
}

// The input is an owner-built npm package with an independently recorded digest.
export async function saveSnapshot(input, root, expectedHash, check = () => {}) {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash ?? '')) throw new Error('Expected snapshot SHA-256 must be 64 lowercase hex characters');
  const handle = await open(input, 'r');
  const buffer = Buffer.alloc(16 * 1024 * 1024 + 1); let length = 0;
  try {
    while (length < buffer.length) {
      check(); const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
  } finally { await handle.close(); }
  if (length > 16 * 1024 * 1024) throw new Error('Snapshot exceeds the 16 MiB routing-test input limit; reassess resources');
  const saved = join(root, 'snapshot.tgz');
  await writeFile(saved, buffer.subarray(0, length), { flag: 'wx', mode: 0o400 });
  const bytes = await readFile(saved);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('Saved snapshot does not match the independently recorded SHA-256');
  return bytes;
}

// Own the temporary root, child process group and servers as one lifecycle.
export async function withRoutingWorkspace(task) {
  let root;
  const servers = []; let child; let interrupted; let killTimer;
  const signalChild = signal => {
    if (!child?.pid) return;
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = signal => {
    if (interrupted) return;
    interrupted = signal;
    signalChild('SIGTERM');
    if (child) killTimer = setTimeout(() => signalChild('SIGKILL'), 2000);
  };
  const onInt = () => interrupt('SIGINT'); const onTerm = () => interrupt('SIGTERM');
  const check = () => { if (interrupted) throw new Error(`Interrupted by ${interrupted}`); };
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    root = await mkdtemp(join(tmpdir(), 'cfl-registry-routing-')); check();
    const listen = async handler => {
      check(); const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); check();
      return `http://127.0.0.1:${server.address().port}`;
    };
    const run = async (command, args, options, onSpawn = () => {}) => {
      check(); child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const timer = setTimeout(() => signalChild('SIGKILL'), 60_000);
      const closed = once(child, 'close');
      try { onSpawn(child.pid); const [code] = await closed; if (interrupted) signalChild('SIGKILL'); check(); return { code, output }; }
      catch (error) { if (child.exitCode === null && child.signalCode === null) { signalChild('SIGKILL'); await closed.catch(() => {}); } throw error; }
      finally { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); child = undefined; }
    };
    const result = await task({ root, check, listen, run }); check(); return result;
  } finally {
    try {
      if (child) { signalChild('SIGKILL'); await once(child, 'close').catch(() => {}); }
      if (killTimer) clearTimeout(killTimer);
      for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); }
    } finally {
      try { if (root) await rm(root, { recursive: true, force: true }); }
      finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
    }
    check();
  }
}
