// Explicitly invoked only after approval: creates a test-owned npm prefix and cache.
// Input must be the exact prepared snapshot tarball for the supplied CFL commit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { snapshotVersion } from './snapshot-publish.mjs';
import { saveSnapshot, snapshotHandler, verifySnapshotRequests, withRoutingWorkspace } from './snapshot-check-support.mjs';

const [input, sha, expectedHash] = process.argv.slice(2);
if (!input || !/^[a-f0-9]{40}$/u.test(sha ?? '') || !/^[a-f0-9]{64}$/u.test(expectedHash ?? '')) throw new Error('Usage: node scripts/snapshot-registry-install.check.mjs <owner-built-snapshot.tgz> <full-CFL-commit-SHA> <independently-recorded-SHA256>');
const supported = { 'linux-x64': '@lamplitisles/codex-for-love-linux-x64', 'darwin-arm64': '@lamplitisles/codex-for-love-darwin-arm64' };
const nativeName = supported[`${process.platform}-${process.arch}`];
if (!nativeName) throw new Error('Routing check requires a supported Linux x64 or macOS arm64 host');
const artifact = resolve(input);
await withRoutingWorkspace(async ({ root, check, listen, run }) => {
  const mainBytes = await saveSnapshot(artifact, root, expectedHash, check);
  gunzipSync(mainBytes, { maxOutputLength: 32 * 1024 * 1024 });
  console.log(`Owner-built snapshot source: ${artifact}; SHA-256: ${expectedHash}; CFL commit: ${sha}`);
  const home = join(root, 'home'); const cache = join(root, 'npm-cache'); const prefix = join(root, 'prefix');
  const extracted = join(root, 'extracted');
  const env = { PATH: process.env.PATH, HOME: home, npm_config_cache: cache,
    npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'),
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  const requests = { forge: [], npm: [] };
  await Promise.all([home, extracted].map(path => mkdir(path, { recursive: true })));
  await Promise.all([writeFile(env.npm_config_userconfig, ''), writeFile(env.npm_config_globalconfig, '')]);
  // Only a freshly owner-built npm package with an independently recorded digest is accepted.
  // This tar inspection is not intended for arbitrary archives.
  const names = execFileSync('tar', ['-tzf', '-'], { input: mainBytes, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
  assert.ok(names.length && names.every(name => name.startsWith('package/') && !name.split('/').includes('..')), 'unexpected package paths');
  assert.equal(new Set(names).size, names.length, 'duplicate package paths');
  execFileSync('tar', ['-xzf', '-', '-C', extracted], { input: mainBytes });
  check();
  const mainSource = join(extracted, 'package');
  const original = JSON.parse(await readFile(new URL('../packages/codex-for-love/package.json', import.meta.url), 'utf8'));
  const staged = JSON.parse(await readFile(join(mainSource, 'package.json'), 'utf8'));
  assert.equal(staged.name, '@lamplitisles/codex-for-love');
  assert.equal(staged.version, snapshotVersion(original.version, sha));
  assert.equal(staged.publishConfig?.registry, 'https://forgejo.n5.guion.io/api/packages/LamplitIsles/npm/');
  assert.deepEqual(staged.optionalDependencies, original.optionalDependencies);
  assert.equal(JSON.parse(await readFile(join(mainSource, 'vendor/source.json'), 'utf8')).cfl.sha, sha);
  for (const path of ['bin/codex-for-love.mjs', 'vendor/runtime/cli.mjs', 'vendor/runtime/companion-mcp.mjs', 'vendor/source.json', 'LICENSE', 'NOTICE', 'README.md']) assert.ok(names.includes(`package/${path}`), `missing ${path}`);
  assert.ok(!names.some(path => path.startsWith('package/vendor/build/')), 'browser must not be bundled');
  const packages = new Map();
  for (const [name, version] of Object.entries({ ...staged.dependencies, ...staged.optionalDependencies })) {
    const pkgRoot = join(root, `synthetic-${packages.size}`); const packageDir = join(pkgRoot, 'package');
    await mkdir(packageDir, { recursive: true });
    const platform = name.endsWith('-linux-x64') ? { os: ['linux'], cpu: ['x64'] }
      : name.endsWith('-darwin-arm64') ? { os: ['darwin'], cpu: ['arm64'] } : {};
    const manifest = { name, version, ...platform };
    await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(packageDir, 'fixture.txt'), `${name}@${version}\n`);
    const tarball = join(root, `synthetic-${packages.size}.tgz`);
    execFileSync('tar', ['-czf', tarball, '-C', pkgRoot, 'package']);
    packages.set(name, { manifest, bytes: await readFile(tarball) });
  }
  let npmOrigin;
  npmOrigin = await listen((request, response) => {
    const path = new URL(request.url, npmOrigin).pathname;
    requests.npm.push(path);
    if (path.startsWith('/tar/')) {
      const pkg = [...packages.values()][Number(path.slice('/tar/'.length))];
      if (!pkg) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(pkg.bytes); return;
    }
    const name = decodeURIComponent(path.slice(1)); const pkg = packages.get(name);
    if (!pkg) { response.writeHead(404).end(); return; }
    const index = [...packages.keys()].indexOf(name);
    const dist = { tarball: `${npmOrigin}/tar/${index}`, integrity: `sha512-${createHash('sha512').update(pkg.bytes).digest('base64')}` };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, 'dist-tags': { latest: pkg.manifest.version }, versions: { [pkg.manifest.version]: { ...pkg.manifest, dist } } }));
  });
  const forgeOrigin = await listen(snapshotHandler(mainBytes, requests.forge));
  const args = ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, '--registry', npmOrigin, `${forgeOrigin}/snapshot.tgz`];
  const { code, output } = await run('npm', args, { cwd: root, env });
  assert.equal(code, 0, output);
  verifySnapshotRequests(requests.forge);
  assert.ok(requests.npm.some(path => decodeURIComponent(path).slice(1) === nativeName), 'native metadata must be requested from npmjs server');
  assert.ok(requests.npm.includes(`/tar/${[...packages.keys()].indexOf(nativeName)}`), 'native tarball must be requested from npmjs server');
  const mainRoot = join(prefix, 'lib/node_modules/@lamplitisles/codex-for-love');
  const compareFiles = async (source, destination, relative = '') => {
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await compareFiles(source, destination, path);
      else {
        assert.ok(entry.isFile(), `unexpected non-file archive entry ${path}`);
        assert.deepEqual(await readFile(join(destination, path)), await readFile(join(source, path)), `installed file differs: ${path}`);
      }
    }
  };
  await compareFiles(mainSource, mainRoot);
  const installedRequire = createRequire(join(mainRoot, 'package.json'));
  const native = JSON.parse(await readFile(installedRequire.resolve(`${nativeName}/package.json`), 'utf8'));
  assert.equal(native.version, staged.optionalDependencies[nativeName]);
  assert.equal(native.name, nativeName);
  assert.equal(await readFile(installedRequire.resolve(`${nativeName}/fixture.txt`), 'utf8'), `${nativeName}@${native.version}\n`);
  console.log(`Exact snapshot ${staged.version} and synthetic ${nativeName}@${native.version} installed through separate loopback registries`);
});
