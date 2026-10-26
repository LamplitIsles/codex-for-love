import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const wizard = resolve('skills/cfl-release/scripts/publish-native-wizard.sh');
for (const [flag, target, os, cpu] of [
  ['--linux', 'x86_64-unknown-linux-musl', 'linux', 'x64'],
  ['--mac', 'aarch64-apple-darwin', 'darwin', 'arm64'],
]) {
  test(`native prepare retains exact ${os}/${cpu} package without publishing`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cfl-native-prepare-'));
    try {
      const input = join(root, 'input');
      const source = join(root, 'source');
      await mkdir(input);
      await mkdir(join(source, 'native/bin'), { recursive: true });
      for (const name of ['codex-app-server', 'codex-code-mode-host']) {
        await writeFile(join(source, 'native/bin', name), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
      }
      for (const name of ['LICENSE', 'NOTICE']) await writeFile(join(source, 'native', name), 'test-owned notice\n');
      const provenance = { schemaVersion: 1, sourceRevision: 'a'.repeat(40), target, codexVersion: '0.164.0' };
      await writeFile(join(source, 'native/provenance.json'), JSON.stringify(provenance));
      const archive = join(input, `fixture-${target}.tar.gz`);
      execFileSync('tar', ['-czf', archive, '-C', source, 'native']);
      const output = join(root, 'output');
      const env = { PATH: process.env.PATH, HOME: root, CFL_NATIVE_INPUT_DIR: input,
        CFL_NATIVE_OUTPUT_DIR: output, npm_config_cache: join(root, 'cache'),
        npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'),
        npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:1' };
      const prepare = () => spawnSync('bash', [wizard, 'prepare', '0.7.0', flag], { env, encoding: 'utf8' });
      const result = prepare();
      assert.equal(result.status, 0, result.stderr);
      const artifact = JSON.parse(result.stdout);
      const bytes = await readFile(artifact.artifact);
      assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(artifact.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
      const manifest = JSON.parse(execFileSync('tar', ['-xOzf', artifact.artifact, 'package/package.json']));
      assert.equal(manifest.name, `@lamplitisles/codex-for-love-${os === 'linux' ? 'linux-x64' : 'darwin-arm64'}`);
      assert.equal(manifest.version, '0.7.0');
      assert.deepEqual(manifest.os, [os]);
      assert.deepEqual(manifest.cpu, [cpu]);
      assert.equal(manifest.scripts, undefined);
      assert.deepEqual(JSON.parse(execFileSync('tar', ['-xOzf', artifact.artifact, 'package/provenance.json'])), provenance);
      assert.equal(execFileSync('tar', ['-xOzf', artifact.artifact, 'package/NOTICE'], { encoding: 'utf8' }), 'test-owned notice\n');
      assert.equal(prepare().status, 0, 'identical preparation is reusable');
      await writeFile(artifact.artifact, 'different immutable bytes');
      const collision = prepare();
      assert.notEqual(collision.status, 0);
      assert.match(collision.stderr, /refusing to replace different prepared bytes/);
      assert.equal(await readFile(artifact.artifact, 'utf8'), 'different immutable bytes');
      await writeFile(join(input, `duplicate-${target}.tar.gz`), await readFile(archive));
      const ambiguous = prepare();
      assert.notEqual(ambiguous.status, 0);
      assert.match(ambiguous.stderr, /expected exactly one/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
