import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';
import { createFileOperations } from '../runtime/file-operations.ts';

const childScript = fileURLToPath(new URL('./file-intent-crash-child.mjs', import.meta.url));
const imports: string[] = [];
for (let index = 0; index < process.execArgv.length; index++) {
  const arg = process.execArgv[index]!;
  if (arg === '--import') imports.push(arg, process.execArgv[++index]!);
  else if (arg.startsWith('--import=')) imports.push(arg);
}
for (const boundary of ['directory', 'writing', 'publication', 'bound', 'removed'] as const) test(`private operation directory survives SIGKILL at ${boundary}`, { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-directory-crash-'));
  const operationId = crypto.randomUUID(), child = spawn(process.execPath, [...imports, childScript], { env: { ...process.env, CFL_FAKE_ROOT: root, CFL_FAKE_ID: operationId, CFL_FAKE_BOUNDARY: boundary }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr!.on('data', chunk => { errors += String(chunk); });
  try {
    const [event] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`Child exited before boundary: ${errors}`); })]);
    assert.deepEqual(event, { boundary });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const attachments = join(root, 'workspace', '.lamplit', 'attachments'), store = new Store(join(root, 'session.sqlite'));
    const ops = createFileOperations(store, attachments), owner = { ownerId: 'owner', sessionId: 'session' }, guard = { check: async () => {}, commit: () => {} }, realNow = Date.now;
    try {
      if (boundary === 'directory') {
        assert.equal(await ops.status(operationId, owner), null);
        assert.equal((await readdir(join(attachments, '.file-operations'))).length, 1);
      } else if (boundary === 'bound') {
        assert.deepEqual((await ops.status(operationId, owner))?.uploaded, ['f']);
        assert.equal((await ops.complete(operationId, owner, guard)).files[0]?.ref.size, 4);
      } else {
        if (boundary === 'writing' || boundary === 'publication') {
          const replacement = { sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 4 }] };
          await ops.reserve(replacement, owner, guard);
          await ops.receive(replacement.operationId, 'f', (async function* () { yield Buffer.from('data'); })(), owner, guard);
          await ops.complete(replacement.operationId, owner, guard);
          const staged = await store.stagedFiles(replacement.operationId, owner.ownerId, owner.sessionId);
          assert.equal(await readFile(staged!.files[0]!.path, 'utf8'), 'data');
        }
        Date.now = () => realNow() + 25 * 60 * 60 * 1000;
        await ops.reserve({ sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 0 }] }, owner, guard);
        await assert.rejects(ops.status(operationId, owner), /retired/);
        assert.equal((await store.pendingFileRetirements()).length, 0);
      }
    } finally { Date.now = realNow; await store.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
