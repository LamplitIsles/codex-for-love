import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPin, readDigest, hashes, unpackContracts } from './shared-source.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('source and independently recorded archive digest have distinct strict formats', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-pin-'));
  try {
    const path = join(directory, 'pin');
    await writeFile(path, 'a'.repeat(40)); assert.equal(await readPin(path), 'a'.repeat(40));
    await assert.rejects(readDigest(path), /SHA-256/);
    await writeFile(path, 'b'.repeat(64)); assert.equal(await readDigest(path), 'b'.repeat(64));
    await assert.rejects(readPin(path), /full lowercase commit SHA/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('published contracts require trusted bytes, matching source, exports and notices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-contract-artifact-')); const pin = 'a'.repeat(40);
  try {
    const pkg = join(root, 'package'); await mkdir(join(pkg, 'dist'), { recursive: true }); await mkdir(join(pkg, 'licenses'));
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@lamplit/contracts', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }, dependencies: { typebox: '1.3.34' }, license: 'Apache-2.0' }));
    await writeFile(join(pkg, 'lamplit-source.json'), JSON.stringify({ revision: pin }));
    await writeFile(join(pkg, 'LICENSE'), 'license'); await writeFile(join(pkg, 'licenses/chord-1.0.0-MIT.txt'), 'chord');
    await writeFile(join(pkg, 'dist/index.js'), 'contract'); await writeFile(join(pkg, 'dist/index.d.ts'), 'types');
    await writeFile(join(pkg, 'dist/cfl-browser-host-auth.js'), 'export const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n');
    const archive = join(root, 'artifact.tgz'); const dest = join(root, 'out');
    const pack = () => execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
    const unpack = async (expectedPin = pin, digest) => { await rm(dest, { recursive: true, force: true }); await mkdir(dest); return unpackContracts(archive, dest, expectedPin, digest ?? sha(await readFile(archive))); };
    pack(); const digest = sha(await readFile(archive));
    const first = await unpack(pin, digest); assert.deepEqual(first, await hashes(pkg)); assert.deepEqual(await unpack(pin, digest), first);
    await assert.rejects(unpack(pin, 'b'.repeat(64)), /SHA-256 mismatch/);
    await assert.rejects(unpack('b'.repeat(40), digest), /source revision mismatch/);
    await rm(join(pkg, 'dist/index.d.ts')); pack(); await assert.rejects(unpack(), /ENOENT/);
    await writeFile(join(pkg, 'dist/index.d.ts'), 'types'); await rm(join(pkg, 'licenses/chord-1.0.0-MIT.txt')); pack(); await assert.rejects(unpack(), /ENOENT/);
    await writeFile(join(pkg, 'licenses/chord-1.0.0-MIT.txt'), 'chord');
    await writeFile(join(pkg, 'dist/cfl-browser-host-auth.js'), 'old marker'); pack();
    await assert.rejects(unpack(), /Better Auth browser-host protocol marker/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
