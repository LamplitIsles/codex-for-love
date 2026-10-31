import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { prepareFrontend, runFrontendCommand } from '../runtime/startup-frontend.ts';
import { authMarkerHash, authMarkerPath } from '../runtime/frontend-contract.ts';
import { loadConfig } from '../runtime/config.ts';

const one = '1'.repeat(40); const two = '2'.repeat(40); const three = '3'.repeat(40);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const contracts = { 'dist/index.js': digest('contract'), [authMarkerPath]: authMarkerHash };
const notices = ['lamplit-app-Apache-2.0.txt', 'lamplit-app-IMPORTS.md', 'NotoSansSC-OFL-1.1.txt'];

test('startup downloads and verifies the selected App, reuses cache offline, and rejects unsafe or incompatible archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-test-'));
  const cache = join(root, 'cache'); let latest = one; let downloads = 0; let fail = '';
  const execute = async (command: string, args: string[], cwd: string) => {
    assert.equal(command, 'curl');
    if (args.at(-1)!.endsWith('/commits/main')) {
      if (fail === 'resolve') throw new Error('offline');
      return JSON.stringify({ sha: latest });
    }
    downloads++;
    const revision = /app-([a-f0-9]{40})\/lamplit-app-\1\.tar\.gz$/u.exec(args.at(-1)!)?.[1];
    assert.ok(revision, 'exact public GitHub release URL');
    assert.equal(args.at(-1), `https://github.com/LamplitIsles/lamplit-app/releases/download/app-${revision}/lamplit-app-${revision}.tar.gz`);
    if (fail === 'download') throw new Error('404');
    const archive = args[args.indexOf('--output') + 1]!;
    if (fail === 'corrupt') { await writeFile(archive, 'not gzip'); return ''; }
    const source = join(cwd, 'fixture');
    await mkdir(join(source, 'browser/assets'), { recursive: true });
    await mkdir(join(source, 'contracts/dist'), { recursive: true });
    await mkdir(join(source, 'licenses'), { recursive: true });
    const contract = fail === 'contracts' ? 'changed' : 'contract';
    const marker = fail === 'marker' ? 'wrong' : 'export const CFL_BROWSER_HOST_AUTH_PROTOCOL = "better-auth";\n';
    await writeFile(join(source, 'browser/index.html'), revision);
    await writeFile(join(source, 'browser/assets/app.js'), `asset ${revision}`);
    await writeFile(join(source, 'contracts/dist/index.js'), contract);
    await writeFile(join(source, 'contracts', authMarkerPath), marker);
    const licenses: Record<string, string> = {};
    for (const notice of notices) {
      if (fail === `missing:${notice}` || fail === 'no-notices') continue;
      await writeFile(join(source, 'licenses', notice), 'license'); licenses[notice] = digest('license');
    }
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ revision: fail === 'revision' ? one : revision, browser: { 'index.html': digest(fail === 'integrity' ? 'wrong' : revision), 'assets/app.js': digest(`asset ${revision}`) }, contracts: { 'dist/index.js': digest(contract), [authMarkerPath]: digest(marker) }, licenses }));
    if (fail === 'link') await symlink('../../escape', join(source, 'browser/link'));
    const transform = fail === 'traversal' ? ['--transform=s,^browser/index.html$,../escape,'] : [];
    execFileSync('tar', ['--format=ustar', ...transform, '-czf', archive, '-C', source, 'manifest.json', 'browser', 'contracts', 'licenses']);
    return '';
  };
  const opts = { cache, execute, expectedContracts: contracts };
  try {
    const first = await prepareFrontend('latest', import.meta.url, opts);
    assert.equal(await readFile(join(first, 'index.html'), 'utf8'), one);
    assert.equal(await prepareFrontend(one, import.meta.url, opts), first);
    assert.equal(downloads, 1);
    const vendor = join(root, 'package/vendor');
    await mkdir(join(vendor, 'runtime'), { recursive: true });
    await writeFile(join(vendor, 'source.json'), JSON.stringify({ contracts }));
    assert.equal(await prepareFrontend(one, pathToFileURL(join(vendor, 'runtime/cli.mjs')).href, { cache, execute }), first);
    const sourceRoot = join(root, 'checkout');
    await mkdir(join(sourceRoot, '.generated/shared-app'), { recursive: true });
    await writeFile(join(sourceRoot, '.generated/shared-app/source.json'), JSON.stringify({ contracts }));
    assert.equal(await prepareFrontend(one, pathToFileURL(join(sourceRoot, 'apps/partner/runtime/cli.ts')).href, { cache, execute }), first);
    latest = two;
    const second = await prepareFrontend('latest', import.meta.url, opts);
    assert.equal(await readFile(join(second, 'index.html'), 'utf8'), two);
    fail = 'resolve'; await assert.rejects(prepareFrontend('latest', import.meta.url, opts), /offline/);
    for (const [failure, pattern] of [['download', /release may still be publishing/], ['corrupt', /incorrect header|unknown compression/i], ['revision', /invalid revision/], ['integrity', /browser integrity mismatch/], ['contracts', /contracts differ/], ['marker', /protocol marker/i], ['link', /Unsupported frontend archive entry/], ['traversal', /Unsafe frontend archive path/]] as const) {
      fail = failure; await assert.rejects(prepareFrontend(three, import.meta.url, opts), pattern);
    }
    for (const missing of ['no-notices', ...notices.map(notice => `missing:${notice}`)]) {
      fail = missing; await assert.rejects(prepareFrontend(three, import.meta.url, opts), /required license notice missing/);
      assert.equal((await readdir(cache)).includes(three), false);
    }
    assert.equal((await readdir(cache)).some(name => name.startsWith('.stage-')), false);
    fail = '';
    const cachedRoot = join(cache, one);
    const cachedManifestPath = join(cachedRoot, 'manifest.json');
    const cachedManifest = JSON.parse(await readFile(cachedManifestPath, 'utf8'));
    await rm(join(cachedRoot, 'licenses', notices[0]!)); delete cachedManifest.licenses[notices[0]!];
    await writeFile(cachedManifestPath, JSON.stringify(cachedManifest));
    await assert.rejects(prepareFrontend(one, import.meta.url, opts), /required license notice missing/);
    await writeFile(join(cachedRoot, 'licenses', notices[0]!), 'license'); cachedManifest.licenses[notices[0]!] = digest('license');
    await writeFile(cachedManifestPath, JSON.stringify(cachedManifest));
    await writeFile(join(first, 'index.html'), 'corrupt');
    await assert.rejects(prepareFrontend(one, import.meta.url, opts), /integrity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download subprocess environment excludes service secrets and timeout reaps the child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-process-'));
  process.env.CFL_TEST_SECRET = 'must-not-leak';
  try {
    const output = await runFrontendCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({secret: process.env.CFL_TEST_SECRET, home: process.env.HOME}))'], root, root, 3000);
    assert.deepEqual(JSON.parse(output), { home: root });
    await assert.rejects(runFrontendCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], root, root, 100), /timed out/);
  } finally { delete process.env.CFL_TEST_SECRET; await rm(root, { recursive: true, force: true }); }
});

test('a signal between preparation steps prevents every subsequent subprocess', async () => {
  for (const stopAfter of [1, 2]) {
    const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-cancel-'));
    const calls: string[] = [];
    const execute = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.slice(0, 2).join(' ')}`);
      if (calls.length === stopAfter) process.emit(stopAfter % 2 ? 'SIGTERM' : 'SIGINT');
      if (command === 'curl' && args.at(-1)!.endsWith('/commits/main')) return JSON.stringify({ sha: one });
      return '';
    };
    try {
      await assert.rejects(prepareFrontend('latest', import.meta.url, { cache: root, execute, expectedContracts: contracts }), /interrupted/);
      assert.equal(calls.length, stopAfter, `no command after step ${stopAfter}`);
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('shutdown terminates and reaps an active download child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-shutdown-'));
  const marker = join(root, 'pid');
  const module = fileURLToPath(new URL('../runtime/startup-frontend.ts', import.meta.url));
  const build = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const script = `import { runFrontendCommand } from ${JSON.stringify(pathToFileURL(module).href)}; try { await runFrontendCommand(process.execPath, ['-e', ${JSON.stringify(build)}], ${JSON.stringify(root)}, ${JSON.stringify(root)}, 10000); } catch (e) { if (!String(e).includes('shutdown')) throw e; }`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  try {
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try { pid = Number(await readFile(marker, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(pid, 'build child started');
    const exited = once(parent, 'exit'); parent.kill('SIGTERM');
    const [code] = await exited; assert.equal(code, 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { parent.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});

test('frontend TOML accepts only latest or a full lowercase commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-config-')); const path = join(root, 'partner.toml');
  try {
    const base = 'name = "Test"\nprompts = { persona = "persona.md" }\n';
    await writeFile(path, base); assert.equal((await loadConfig(path)).frontend, undefined);
    for (const selector of ['latest', one]) { await writeFile(path, `${base}frontend = "${selector}"\n`); assert.equal((await loadConfig(path)).frontend, selector); }
    for (const selector of ['main', 'abc', one.toUpperCase().replace('1', 'A')]) { await writeFile(path, `${base}frontend = "${selector}"\n`); await assert.rejects(loadConfig(path)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
