import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCodex } from '../apps/partner/runtime/startup-codex.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('verified Codex archive is cached offline, and corrupt files trigger a verified replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-codex-test-'));
  let server;
  try {
    const source = join(root, 'source'), cache = join(root, 'cache'), archive = join(root, 'release.tar.gz');
    await mkdir(join(source, 'bin'), { recursive: true }); await mkdir(join(source, 'licenses'));
    const files = {};
    for (const name of ['bin/codex-app-server', 'bin/codex-code-mode-host', 'licenses/LICENSE', 'provenance.json']) {
      const bytes = Buffer.from(name === 'provenance.json' ? JSON.stringify({ release: 'v0.170.0-test', upstream_tag: 'rust-v0.170.0', target: 'x86_64-unknown-linux-musl' }) : name); await writeFile(join(source, name), bytes); files[name] = hash(bytes);
    }
    execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', source, ...Object.keys(files)]);
    let downloads = 0;
    const bytes = await readFile(archive);
    server = createServer((request, response) => { downloads++; if (request.url !== '/release.tar.gz') return response.writeHead(404).end(); response.end(bytes); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const pin = { release: 'v0.170.0-test', version: '0.170.0', url: `http://127.0.0.1:${server.address().port}/release.tar.gz`, digest: hash(bytes), files };
    const download = async (url, destination) => { const response = await fetch(url); assert.equal(response.status, 200); await writeFile(destination, Buffer.from(await response.arrayBuffer())); };
    const candidate = await prepareCodex({ cache, pin, download });
    await prepareCodex({ cache, pin, download: async () => { throw Error('offline'); } });
    assert.equal(downloads, 1);
    for (const name of ['codex-app-server', 'codex-code-mode-host']) {
      const executable = join(candidate, 'bin', name);
      await chmod(executable, 0o610); // Correct bytes, but only the group can execute.
      await assert.rejects(prepareCodex({ cache, pin, download: async () => { throw Error('offline'); } }), /offline/);
      const before = downloads;
      await prepareCodex({ cache, pin, download });
      assert.equal(downloads, before + 1);
      assert.equal((await stat(executable)).mode & 0o100, 0o100);
    }
    await writeFile(join(candidate, 'bin/codex-app-server'), 'corrupt');
    await prepareCodex({ cache, pin, download }); assert.equal(downloads, 4);
    await writeFile(join(candidate, 'bin/codex-app-server'), 'corrupt');
    await assert.rejects(prepareCodex({ cache, pin, download: async () => { throw Error('offline'); } }), /offline/);
    await assert.rejects(prepareCodex({ cache, pin: { ...pin, digest: '0'.repeat(64) }, download }), /SHA-256 mismatch/);
    await assert.rejects(prepareCodex({ cache, pin: { ...pin, version: '0.171.0' }, download }), /provenance mismatch/);
    const unsafe = join(root, 'unsafe.tar.gz');
    execFileSync('tar', ['--format=ustar', '-czf', unsafe, '-C', source, '--transform=s@^provenance.json$@../provenance.json@', ...Object.keys(files)]);
    await assert.rejects(prepareCodex({ cache, pin: { ...pin, digest: hash(await readFile(unsafe)) }, download: async (_url, dest) => cp(unsafe, dest) }), /Unexpected Codex archive entry/);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
