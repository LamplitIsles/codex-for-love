import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { authMarkerPath, requireAuthMarker } from '../apps/partner/runtime/frontend-contract.ts';
import { prepareFrontend, verifyFrontend } from '../apps/partner/runtime/startup-frontend.ts';
import { buildWithFreshAuthMarker } from './shared-source.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const marker = 'export const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n';
const expected = { 'dist/index.js': sha('contract'), [authMarkerPath]: sha(marker) };
const revision = 'a'.repeat(40);

test('source preparation requires the current build to produce the marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-marker-test-'));
  try {
    const dist = join(root, 'packages/contracts/dist');
    await mkdir(dist, { recursive: true });
    const path = join(root, 'packages/contracts', authMarkerPath);
    const other = join(dist, 'index.js');
    await writeFile(path, marker); await writeFile(other, 'retain this output');
    let oldBuildRan = false;
    await assert.rejects(buildWithFreshAuthMarker(root, async () => {
      oldBuildRan = true;
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    }), /App build lacks the Better Auth browser-host protocol marker/);
    assert.equal(oldBuildRan, true);
    assert.equal(await readFile(other, 'utf8'), 'retain this output');
    await writeFile(path, marker);
    await buildWithFreshAuthMarker(root, async () => {
      await assert.rejects(readFile(path), { code: 'ENOENT' });
      await writeFile(path, marker);
    });
    assert.equal(await readFile(path, 'utf8'), marker);
    assert.equal(await readFile(other, 'utf8'), 'retain this output');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime metadata requires the agreed marker before frontend preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-marker-test-'));
  try {
    requireAuthMarker(expected, 'Runtime');
    for (const contracts of [{ 'dist/index.js': sha('contract') }, { ...expected, [authMarkerPath]: sha('other') }]) {
      assert.throws(() => requireAuthMarker(contracts, 'Runtime'), /Better Auth browser-host protocol marker/);
      for (const [metadata, runtime] of [
        [join(root, 'source/.generated/shared-app/source.json'), join(root, 'source/apps/partner/runtime/cli.ts')],
        [join(root, 'package/vendor/source.json'), join(root, 'package/vendor/runtime/cli.mjs')],
      ]) {
        await mkdir(join(metadata, '..'), { recursive: true });
        await writeFile(metadata, JSON.stringify({ contracts }));
        await assert.rejects(prepareFrontend(revision, pathToFileURL(runtime).href, { cache: join(root, 'must-not-exist') }), /CFL runtime contracts.*Better Auth browser-host protocol marker/);
      }
    }
    await assert.rejects(readFile(join(root, 'must-not-exist')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('frontend fixture rejects old or altered protocol and retains exact contract checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-marker-test-'));
  try {
    await mkdir(join(root, 'browser')); await mkdir(join(root, 'contracts/dist'), { recursive: true }); await mkdir(join(root, 'licenses'));
    await writeFile(join(root, 'browser/index.html'), 'frontend');
    const licenses = Object.fromEntries(['lamplit-app-Apache-2.0.txt', 'lamplit-app-IMPORTS.md', 'NotoSansSC-OFL-1.1.txt'].map(name => [name, sha('license')]));
    for (const name of Object.keys(licenses)) await writeFile(join(root, 'licenses', name), 'license');
    await writeFile(join(root, 'contracts/dist/index.js'), 'contract');
    const manifest = { revision, browser: { 'index.html': sha('frontend') }, contracts: { 'dist/index.js': sha('contract') }, licenses };
    const save = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await save();
    await assert.rejects(verifyFrontend(root, revision, expected), /Selected frontend contracts.*Better Auth browser-host protocol marker/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), manifest);
    await writeFile(join(root, 'contracts', authMarkerPath), 'old protocol');
    manifest.contracts[authMarkerPath] = sha('old protocol'); await save();
    await assert.rejects(verifyFrontend(root, revision, expected), /Selected frontend contracts.*Better Auth browser-host protocol marker/);
    await writeFile(join(root, 'contracts', authMarkerPath), marker);
    await assert.rejects(verifyFrontend(root, revision, expected), /contracts integrity mismatch/);
    manifest.contracts[authMarkerPath] = sha(marker); await save();
    await verifyFrontend(root, revision, expected);
    await writeFile(join(root, 'contracts/dist/index.js'), 'different');
    manifest.contracts['dist/index.js'] = sha('different'); await save();
    await assert.rejects(verifyFrontend(root, revision, expected), /compiled public contracts differ/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
