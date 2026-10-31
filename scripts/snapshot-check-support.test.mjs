import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { saveSnapshot, snapshotHandler, verifySnapshotRequests, withRoutingWorkspace } from './snapshot-check-support.mjs';

test('fake Forgejo permits repeated exact snapshot GETs and rejects other requests', async () => {
  await withRoutingWorkspace(async ({ listen }) => {
    const requests = []; const bytes = Buffer.from('owned snapshot bytes');
    const origin = await listen(snapshotHandler(bytes, requests));
    assert.throws(() => verifySnapshotRequests(requests), /only GET requests/);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${origin}/snapshot.tgz`);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    verifySnapshotRequests(requests);
    assert.equal((await fetch(`${origin}/snapshot.tgz`, { method: 'POST' })).status, 404);
    assert.throws(() => verifySnapshotRequests(requests), /only GET requests/);
    requests.pop();
    assert.equal((await fetch(`${origin}/other.tgz`)).status, 404);
    assert.throws(() => verifySnapshotRequests(requests), /only GET requests/);
  });
});

test('copies the owner-built snapshot once and checks its independently recorded hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-snapshot-copy-'));
  try {
    const source = join(root, 'input.tgz'); const owned = join(root, 'owned'); const bad = join(root, 'bad');
    await mkdir(owned); await mkdir(bad); await writeFile(source, 'snapshot bytes');
    const hash = createHash('sha256').update('snapshot bytes').digest('hex');
    const bytes = await saveSnapshot(source, owned, hash);
    await writeFile(source, 'changed original');
    assert.equal(bytes.toString(), 'snapshot bytes');
    assert.deepEqual(await readFile(join(owned, 'snapshot.tgz')), bytes);
    await assert.rejects(saveSnapshot(source, bad, hash), /independently recorded SHA-256/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} reaps the child and cleans the owned server and workspace`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-snapshot-signal-')); const marker = join(root, 'ready'); const pidFile = join(root, 'child-pid');
  const support = pathToFileURL(join(import.meta.dirname, 'snapshot-check-support.mjs')).href;
  const fake = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,root:process.argv[2],origin:process.argv[3]})); setInterval(()=>{},1000)`;
  const script = `import {writeFileSync} from 'node:fs'; import {withRoutingWorkspace} from ${JSON.stringify(support)}; try { await withRoutingWorkspace(async ({root,listen,run}) => { const origin=await listen((req,res)=>res.end('test')); await run(process.execPath,['-e',${JSON.stringify(fake)},${JSON.stringify(marker)},root,origin],{env:{PATH:process.env.PATH}},pid=>writeFileSync(${JSON.stringify(pidFile)},String(pid))); }); } catch(e) { console.error(e.message); process.exitCode=1; }`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, TMPDIR: root }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(parent, 'close');
  const wait = async ms => {
    let timer; try { return await Promise.race([closed.then(result => ({ result })), new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  };
  let stderr = ''; parent.stderr.on('data', chunk => { stderr += chunk; });
  try {
    let ready;
    for (let i = 0; i < 200 && !ready; i++) { try { ready = JSON.parse(await readFile(marker, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    assert.ok(ready, 'fake child started');
    parent.kill(signal);
    const completion = await wait(8000);
    assert.ok(completion, 'wrapper exited after signal');
    assert.notEqual(completion.result[0], 0); assert.match(stderr, new RegExp(`Interrupted by ${signal}`));
    assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
    await assert.rejects(readFile(join(ready.root, 'missing')), { code: 'ENOENT' });
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('cfl-registry-routing-')), []);
    const url = new URL(ready.origin); const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    try { await assert.rejects(once(socket, 'connect'), { code: 'ECONNREFUSED' }); } finally { socket.destroy(); }
  } finally {
    const readPid = async () => { try { const pid = Number(await readFile(pidFile, 'utf8')); return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined; } catch { return undefined; } };
    const killChild = pid => { try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    // Give the wrapper its normal cleanup path first, including reaping its child.
    parent.kill('SIGTERM');
    if (!await wait(3500)) {
      const pid = await readPid();
      if (!pid) {
        parent.kill('SIGKILL'); await wait(2000);
        throw new Error('Fake child was not identified; preserve the owned test directory');
      }
      killChild(pid);
      if (!await wait(2000)) { parent.kill('SIGKILL'); assert.ok(await wait(2000), 'wrapper did not exit after SIGKILL'); }
    }
    const pid = await readPid();
    if (pid) {
      let gone = false;
      for (let i = 0; i < 100 && !gone; i++) {
        try { process.kill(pid, 0); killChild(pid); }
        catch (error) { if (error.code !== 'ESRCH') throw error; gone = true; }
        if (!gone) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(gone, 'fake child was not reaped; preserve the owned test directory');
    }
    await rm(root, { recursive: true, force: true });
  }
});
