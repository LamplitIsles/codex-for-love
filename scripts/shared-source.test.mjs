import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPin, requirePinned, hashes, identity } from './shared-source.mjs';

test('source pins accept only a complete commit and formal preparation requires that clean commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-source-pin-'));
  try {
    const path = join(directory, 'pin'); const pin = 'a'.repeat(40);
    await writeFile(path, pin + '\n'); assert.equal(await readPin(path), pin);
    for (const value of ['main', 'a'.repeat(39), 'A'.repeat(40), pin + '\n' + pin]) { await writeFile(path, value); await assert.rejects(readPin(path), /full lowercase commit SHA/); }
    requirePinned({ sha: pin, dirty: false }, pin);
    assert.throws(() => requirePinned({ sha: pin, dirty: true }, pin), /local changes/);
    assert.throws(() => requirePinned({ sha: 'b'.repeat(40), dirty: false }, pin), /Formal source/);
    assert.throws(() => identity(join(directory, 'missing')), /Adjacent lamplit-app source is unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('artifact manifests detect changed bytes and added resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-source-assets-'));
  try {
    await mkdir(join(directory, 'assets')); await writeFile(join(directory, 'assets/app.js'), 'current');
    const before = await hashes(directory); assert.equal(Object.keys(before)[0], 'assets/app.js');
    await writeFile(join(directory, 'assets/app.js'), 'edited'); assert.notDeepEqual(await hashes(directory), before);
    await mkdir(join(directory, 'node_modules')); await writeFile(join(directory, 'node_modules/install-output'), 'pnpm');
    assert.equal(Object.keys(await hashes(directory)).length, 1);
    await writeFile(join(directory, 'index.html'), '<html>'); assert.equal(Object.keys(await hashes(directory)).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('local source identity changes with untracked bytes and symlink targets, but ignores generated state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-source-git-'));
  const previousEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
  const git = args => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  try {
    git(['init', '--quiet']);
    await writeFile(join(directory, '.gitignore'), 'generated/\nnode_modules/\n');
    git(['add', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture']);
    const clean = identity(directory); assert.equal(clean.dirty, false);
    const path = join(directory, 'new ui\n.svelte');
    await writeFile(path, '<p>first</p>');
    const prepared = identity(directory); assert.equal(prepared.dirty, true);
    assert.equal(prepared.sha, clean.sha);
    assert.deepEqual(identity(directory), prepared);
    await writeFile(path, '<p>other</p>');
    const edited = identity(directory);
    assert.equal(edited.sha, prepared.sha); assert.equal(edited.dirty, prepared.dirty);
    assert.notEqual(edited.diffSha256, prepared.diffSha256);
    for (const name of ['generated', 'node_modules']) {
      await mkdir(join(directory, name)); await writeFile(join(directory, name, 'ignored'), 'build output');
    }
    assert.deepEqual(identity(directory), edited);
    const link = join(directory, 'asset-link');
    await symlink('generated/missing-one', link);
    const linked = identity(directory);
    await unlink(link); await symlink('generated/missing-two', link);
    assert.notEqual(identity(directory).diffSha256, linked.diffSha256);
    await unlink(link); await writeFile(path, '<p>first</p>');
    assert.deepEqual(identity(directory), prepared);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
