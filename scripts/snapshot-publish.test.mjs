import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { registryDecision, snapshotManifest, snapshotVersion, verifySnapshotArtifact } from './snapshot-publish.mjs';

const old = 'a'.repeat(40); const current = 'b'.repeat(40);
const version = snapshotVersion('0.1.0-beta.0', current);
const oldVersion = snapshotVersion('0.1.0-beta.0', old);
const ancestor = (a, b) => a === old && b === current || a === b;

test('snapshot identity is a valid commit-derived version', () => {
  assert.equal(version, `0.1.0-beta.0.snapshot.g${current}`);
  assert.equal(snapshotVersion('1.0.0', current), `1.0.0-snapshot.g${current}`);
  assert.throws(() => snapshotVersion('1.0.0', 'short'));
});

test('publication only permits advancing verified latest or an identical retry', () => {
  assert.equal(registryDecision(null, version, 'sha512-good', current, ancestor), 'publish');
  const metadata = { 'dist-tags': { latest: oldVersion }, versions: {} };
  assert.equal(registryDecision(metadata, version, 'sha512-good', current, ancestor), 'publish');
  metadata.versions[version] = { dist: { integrity: 'sha512-good' } };
  assert.throws(() => registryDecision(metadata, version, 'sha512-good', current, ancestor), /not latest/);
  metadata['dist-tags'].latest = version;
  assert.equal(registryDecision(metadata, version, 'sha512-good', current, ancestor), 'skip');
  assert.throws(() => registryDecision(metadata, version, 'sha512-different', current, ancestor), /different integrity/);
  assert.throws(() => registryDecision(metadata, oldVersion, 'sha512-good', old, ancestor), /not a verified ancestor/);
  assert.throws(() => registryDecision({ versions: { [version]: {} } }, version, 'x', current, ancestor), /no latest/);
  assert.throws(() => registryDecision({ 'dist-tags': { latest: 'unexpected' } }, version, 'x', current, ancestor), /not a verified ancestor/);
});

test('snapshot checkout must match the CI commit before preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-snapshot-head-'));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  try {
    execFileSync('git', ['init', '-q', root], { env });
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'], { env });
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
    const script = fileURLToPath(new URL('./snapshot-publish.mjs', import.meta.url));
    const run = sha => spawnSync(process.execPath, [script, 'verify-head'], { cwd: root, env: { ...env, CI_COMMIT_SHA: sha }, encoding: 'utf8' });
    assert.equal(run(head).status, 0);
    const mismatch = run(head === old ? current : old);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match CI_COMMIT_SHA/);
    const malformed = run('abc');
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /full lowercase commit SHA/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git-verified snapshot build passes only committed source and staged manifest to the builder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-snapshot-build-'));
  const repo = join(root, 'repo'); const builder = join(root, 'fake-dagger.mjs');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NODE_DISABLE_COMPILE_CACHE: '1', DAGGER_CLI: builder, _EXPERIMENTAL_DAGGER_RUNNER_HOST: 'tcp://127.0.0.1:1' };
  try {
    await mkdir(join(repo, 'scripts'), { recursive: true }); await mkdir(join(repo, 'packages/codex-for-love'), { recursive: true }); await mkdir(join(repo, 'dagger'));
    await writeFile(join(repo, 'dagger/dagger.json'), '{}');
    for (const file of ['snapshot-build.sh', 'snapshot-publish.mjs']) await copyFile(new URL(`./${file}`, import.meta.url), join(repo, 'scripts', file));
    const manifest = { name: '@lamplitisles/codex-for-love', version: '0.1.0-beta.0' };
    await writeFile(join(repo, 'packages/codex-for-love/package.json'), JSON.stringify(manifest));
    await writeFile(join(repo, '.gitignore'), 'ignored-secret\n');
    execFileSync('git', ['init', '-q', repo], { env });
    execFileSync('git', ['-C', repo, 'add', '.'], { env });
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture'], { env });
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
    await writeFile(join(repo, 'ignored-secret'), 'not included');
    await writeFile(builder, `#!/usr/bin/env node
import assert from 'node:assert/strict'; import {createHash} from 'node:crypto'; import {mkdir,readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
const args=process.argv.slice(2); const option=name=>args.find(x=>x.startsWith(name+'='))?.slice(name.length+1);
assert.equal(args[0],'call'); assert.equal(args[2],'snapshot'); assert.equal(option('--revision'),${JSON.stringify(sha)});
const source=option('--source'), staged=JSON.parse(await readFile(option('--staged-manifest'),'utf8'));
const original=JSON.parse(await readFile(join(source,'packages/codex-for-love/package.json'),'utf8'));
assert.equal(original.version,'0.1.0-beta.0'); assert.equal(staged.version,'0.1.0-beta.0.snapshot.g'+${JSON.stringify(sha)});
await assert.rejects(readFile(join(source,'ignored-secret')),{code:'ENOENT'}); await assert.rejects(readFile(join(source,'.git/HEAD')),{code:'ENOENT'});
const out=option('--output'); await mkdir(out,{recursive:true}); const bytes=Buffer.from('synthetic snapshot');
await writeFile(join(out,'snapshot.tgz'),bytes); await writeFile(join(out,'snapshot.sha256'),(process.env.FAKE_BAD_HASH ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'))+'  snapshot.tgz\\n');
`); await chmod(builder, 0o700);
    const script = join(repo, 'scripts/snapshot-build.sh');
    const noEngine = spawnSync('sh', [script], { cwd: repo, env: { ...env, CI_COMMIT_SHA: sha, _EXPERIMENTAL_DAGGER_RUNNER_HOST: '' }, encoding: 'utf8' });
    assert.notEqual(noEngine.status, 0); assert.match(noEngine.stderr, /Select the existing Dagger engine/);
    const mismatch = spawnSync('sh', [script], { cwd: repo, env: { ...env, CI_COMMIT_SHA: 'a'.repeat(40) }, encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /does not match CI_COMMIT_SHA/);
    await writeFile(join(repo, 'packages/codex-for-love/package.json'), JSON.stringify({ ...manifest, version: '9.0.0' }));
    const dirty = spawnSync('sh', [script], { cwd: repo, env: { ...env, CI_COMMIT_SHA: sha }, encoding: 'utf8' });
    assert.notEqual(dirty.status, 0); assert.match(dirty.stderr, /Snapshot source must be clean/);
    await writeFile(join(repo, 'packages/codex-for-love/package.json'), JSON.stringify(manifest));
    const result = spawnSync('sh', [script], { cwd: repo, env: { ...env, CI_COMMIT_SHA: sha }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(repo, 'packages/codex-for-love/package.json'), 'utf8')), manifest);
    assert.deepEqual(JSON.parse(await readFile(join(repo, '.snapshot-artifacts/staged-package.json'), 'utf8')), snapshotManifest(manifest, sha));
    assert.equal(await readFile(join(repo, '.snapshot-artifacts/package/snapshot.tgz'), 'utf8'), 'synthetic snapshot');
    await rm(join(repo, '.snapshot-artifacts'), { recursive: true });
    const corrupted = spawnSync('sh', [script], { cwd: repo, env: { ...env, CI_COMMIT_SHA: sha, FAKE_BAD_HASH: '1' }, encoding: 'utf8' });
    assert.notEqual(corrupted.status, 0); assert.match(corrupted.stderr, /checksum.*did NOT match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot publication rejects a tarball with a different manifest or source revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-snapshot-package-'));
  const directory = join(root, 'package'); const artifact = join(root, 'snapshot.tgz');
  const manifest = snapshotManifest({ name: '@lamplitisles/codex-for-love', version: '0.1.0-beta.0' }, current);
  try {
    await mkdir(join(directory, 'vendor'), { recursive: true });
    const pack = () => execFileSync('tar', ['-czf', artifact, '-C', root, 'package']);
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'vendor/source.json'), JSON.stringify({ cfl: { sha: current } }));
    pack(); await verifySnapshotArtifact(artifact, manifest, current);
    await writeFile(join(directory, 'vendor/source.json'), JSON.stringify({ cfl: { sha: old } }));
    pack(); await assert.rejects(verifySnapshotArtifact(artifact, manifest, current), /source revision differs/);
    await writeFile(join(directory, 'vendor/source.json'), JSON.stringify({ cfl: { sha: current } }));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, version: oldVersion }));
    pack(); await assert.rejects(verifySnapshotArtifact(artifact, manifest, current), /Packed manifest differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot publication authenticates against package metadata and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-snapshot-registry-'));
  const repo = join(root, 'repo'); const bin = join(root, 'bin');
  const artifact = join(root, 'snapshot.tgz'); const requestLog = join(root, 'request'); const publishLog = join(root, 'published');
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NODE_DISABLE_COMPILE_CACHE: '1', FIXTURE_REQUEST: requestLog, FIXTURE_PUBLISH: publishLog };
  try {
    await mkdir(join(repo, 'packages/codex-for-love'), { recursive: true });
    await mkdir(join(root, 'package/vendor'), { recursive: true }); await mkdir(bin);
    execFileSync('git', ['init', '-q', repo], { env });
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'], { env });
    const parent = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'next fixture'], { env });
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
    const manifest = snapshotManifest({ name: '@lamplitisles/codex-for-love', version: '0.1.0-beta.0' }, sha);
    await writeFile(join(repo, 'packages/codex-for-love/package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'package/package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'package/vendor/source.json'), JSON.stringify({ cfl: { sha } }));
    execFileSync('tar', ['-czf', artifact, '-C', root, 'package']);
    const integrity = `sha512-${createHash('sha512').update(await readFile(artifact)).digest('base64')}`;
    const mock = join(root, 'fetch.mjs');
    await writeFile(mock, `import { writeFile } from 'node:fs/promises';
globalThis.fetch = async (url, options) => {
  await writeFile(process.env.FIXTURE_REQUEST, JSON.stringify({ url, authorization: options.headers.Authorization, redirect: options.redirect }), { flag: 'wx' });
  if (process.env.FIXTURE_STATUS === 'network') throw new Error('synthetic network failure');
  return new Response(process.env.FIXTURE_BODY || null, { status: Number(process.env.FIXTURE_STATUS) });
};\n`);
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf called > "$FIXTURE_PUBLISH"\nexit "${FIXTURE_NPM_EXIT:-0}"\n'); await chmod(join(bin, 'npm'), 0o700);
    const script = fileURLToPath(new URL('./snapshot-publish.mjs', import.meta.url));
    const run = async (status, body, token = 'synthetic-token', npmExit = '0') => {
      await rm(requestLog, { force: true }); await rm(publishLog, { force: true });
      const result = spawnSync(process.execPath, ['--import', mock, script, 'publish', artifact], { cwd: repo, env: { ...env, CI_COMMIT_SHA: sha, FORGEJO_PACKAGES_TOKEN: token, FIXTURE_STATUS: status, FIXTURE_BODY: body ?? '', FIXTURE_NPM_EXIT: npmExit }, encoding: 'utf8' });
      const readOptional = async path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const request = await readOptional(requestLog); const published = await readOptional(publishLog);
      if (request) assert.deepEqual(JSON.parse(request), { url: 'https://forgejo.n5.guion.io/api/packages/LamplitIsles/npm/%40lamplitisles%2Fcodex-for-love', authorization: `Bearer ${token}`, redirect: 'error' });
      return { ...result, request, published };
    };
    for (const token of ['', '   ', 'bad token', 'bad\ttoken', 'bad\r\ntoken', 'bad\u0085token', 'badé', 'bad\x01token']) {
      const result = await run('404', null, token);
      assert.notEqual(result.status, 0); assert.equal(result.request, null); assert.equal(result.published, null);
    }
    for (const [status, token] of [['401', 'invalid-token'], ['401', 'no-package-scope'], ...['403', '500', '201', '302', 'network'].map(status => [status, 'synthetic-token'])]) {
      const result = await run(status, null, token);
      assert.notEqual(result.status, 0, status); assert.ok(result.request, status); assert.equal(result.published, null, status);
    }
    const absent = await run('404'); assert.equal(absent.status, 0, absent.stderr); assert.equal(absent.published, 'called');
    for (const metadata of [null, {}, [], { 'dist-tags': { latest: version } }, { versions: {}, 'dist-tags': { latest: version } }, { versions: [] }, { versions: 'bad' }, { versions: { example: {} } }, { versions: { example: {} }, 'dist-tags': null }, { versions: { example: {} }, 'dist-tags': [] }, { versions: { example: {} }, 'dist-tags': {} }, { versions: { example: {} }, 'dist-tags': { latest: null } }, { versions: { example: {} }, 'dist-tags': { latest: 'bad' } }]) {
      const result = await run('200', JSON.stringify(metadata));
      assert.notEqual(result.status, 0); assert.equal(result.published, null);
    }
    const parentVersion = snapshotVersion('0.1.0-beta.0', parent);
    for (const versions of [{ unrelated: {} }, { [parentVersion]: null }, { [parentVersion]: {}, [manifest.version]: null }, { [parentVersion]: {}, [manifest.version]: 'bad' }]) {
      const result = await run('200', JSON.stringify({ 'dist-tags': { latest: parentVersion }, versions }));
      assert.notEqual(result.status, 0); assert.equal(result.published, null);
    }
    const previous = JSON.stringify({ 'dist-tags': { latest: parentVersion }, versions: { [parentVersion]: {} } });
    const existing = await run('200', previous); assert.equal(existing.status, 0, existing.stderr); assert.equal(existing.published, 'called');
    const nonAncestor = await run('200', JSON.stringify({ 'dist-tags': { latest: oldVersion }, versions: { [oldVersion]: {} } })); assert.notEqual(nonAncestor.status, 0); assert.equal(nonAncestor.published, null);
    const matching = JSON.stringify({ 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: { dist: { integrity } } } });
    const retry = await run('200', matching); assert.equal(retry.status, 0, retry.stderr); assert.equal(retry.published, null);
    const conflict = await run('200', matching.replace(integrity, 'sha512-different')); assert.notEqual(conflict.status, 0); assert.equal(conflict.published, null);
    const unknown = await run('404', null, 'synthetic-token', '1'); assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /outcome is unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('builder applies only the snapshot manifest for its source and revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-snapshot-stage-'));
  const path = join(root, 'packages/codex-for-love/package.json'); const stagedPath = join(root, 'staged.json');
  const manifest = { name: '@lamplitisles/codex-for-love', version: '0.1.0-beta.0' };
  const script = fileURLToPath(new URL('./snapshot-apply-stage.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, HOME: root, NODE_DISABLE_COMPILE_CACHE: '1' };
  try {
    await mkdir(join(root, 'packages/codex-for-love'), { recursive: true });
    await writeFile(path, JSON.stringify(manifest));
    await writeFile(stagedPath, JSON.stringify({ ...snapshotManifest(manifest, current), name: '@unexpected/name' }));
    const run = () => spawnSync(process.execPath, [script, stagedPath, current], { cwd: root, env, encoding: 'utf8' });
    const bad = run(); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /Staged manifest differs/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), manifest);
    await writeFile(stagedPath, JSON.stringify(snapshotManifest(manifest, current)));
    const good = run(); assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), snapshotManifest(manifest, current));
  } finally { await rm(root, { recursive: true, force: true }); }
});
