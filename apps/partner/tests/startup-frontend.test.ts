import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { prepareFrontend, runFrontendCommand } from '../runtime/startup-frontend.ts';
import { loadConfig } from '../runtime/config.ts';
import { createWebServer } from '../runtime/server.ts';
import { fixture } from './fixture.ts';

const one = '1'.repeat(40); const two = '2'.repeat(40); const three = '3'.repeat(40);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const contracts = { 'dist/index.js': digest('contract') };

test('startup selects, serves, revalidates and rolls back exact App revisions; failures do not fall back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-test-'));
  const cache = join(root, 'cache'); let latest = one; let builds = 0; let fail = ''; let revision = '';
  const execute = async (command: string, args: string[], cwd: string, _home: string) => {
    if (command === 'curl' && args.at(-1)!.endsWith('/commits/main')) {
      if (fail === 'resolve') throw new Error('offline');
      return JSON.stringify({ sha: latest });
    }
    if (command === 'curl') { if (fail === 'download') throw new Error('download failed'); revision = args.at(-1)!.split('/').at(-1)!; return ''; }
    if (command === 'tar') {
      const source = args.at(-1)!;
      await writeFile(join(source, 'package.json'), JSON.stringify({ packageManager: 'bun@1.3.14' })); return '';
    }
    if (args[0] === '--version') return '1.3.14';
    if (args[1] === 'build') {
      builds++; if (fail === 'build') throw new Error('build failed');
      await mkdir(join(cwd, 'apps/web/build/assets'), { recursive: true });
      await mkdir(join(cwd, 'packages/contracts/dist'), { recursive: true });
      await mkdir(join(cwd, 'apps/web/node_modules/@fontsource/noto-sans-sc'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(join(cwd, 'LICENSE'), 'App license');
      await writeFile(join(cwd, 'docs/IMPORTS.md'), 'App imports');
      await writeFile(join(cwd, 'apps/web/package.json'), '{}');
      await writeFile(join(cwd, 'apps/web/node_modules/@fontsource/noto-sans-sc/package.json'), '{}');
      await writeFile(join(cwd, 'apps/web/node_modules/@fontsource/noto-sans-sc/LICENSE'), 'Font license');
      await writeFile(join(cwd, 'apps/web/build/index.html'), revision);
      await writeFile(join(cwd, 'apps/web/build/assets/app.js'), `asset ${revision}`);
      await writeFile(join(cwd, 'packages/contracts/dist/index.js'), fail === 'contracts' ? 'changed' : 'contract');
    }
    return '';
  };
  const opts = { cache, execute, expectedContracts: contracts };
  try {
    const first = await prepareFrontend('latest', import.meta.url, opts);
    const f = await fixture(); const partner = await f.createPartner(); const app = createWebServer(partner, first);
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try {
      const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      assert.equal(await (await fetch(origin + '/')).text(), one);
      assert.equal(await (await fetch(origin + '/chat')).text(), one);
      assert.equal(await (await fetch(origin + '/assets/app.js')).text(), `asset ${one}`);
    } finally { await app.close(); await f.close(); }
    assert.equal(await prepareFrontend(one, import.meta.url, opts), first);
    assert.equal(builds, 1);
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
    assert.equal(await prepareFrontend(one, import.meta.url, opts), first);
    assert.equal(builds, 2);
    fail = 'resolve'; await assert.rejects(prepareFrontend('latest', import.meta.url, opts), /offline/);
    fail = 'download'; await assert.rejects(prepareFrontend(three, import.meta.url, opts), /download failed/);
    fail = 'build'; await assert.rejects(prepareFrontend(three, import.meta.url, opts), /build failed/);
    fail = 'contracts'; await assert.rejects(prepareFrontend(three, import.meta.url, opts), /contracts differ/);
    assert.equal((await readdir(cache)).some(name => name.startsWith('.stage-')), false);
    fail = ''; await writeFile(join(first, 'index.html'), 'corrupt');
    await assert.rejects(prepareFrontend(one, import.meta.url, opts), /integrity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build subprocess environment excludes service secrets and timeout reaps the child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-process-'));
  process.env.CFL_TEST_SECRET = 'must-not-leak';
  try {
    const output = await runFrontendCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({secret: process.env.CFL_TEST_SECRET, home: process.env.HOME}))'], root, root, 3000);
    assert.deepEqual(JSON.parse(output), { home: root });
    await assert.rejects(runFrontendCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], root, root, 100), /timed out/);
  } finally { delete process.env.CFL_TEST_SECRET; await rm(root, { recursive: true, force: true }); }
});

test('a signal between preparation steps prevents every subsequent subprocess', async () => {
  for (const stopAfter of [1, 2, 3, 4, 5, 6]) {
    const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-cancel-'));
    const calls: string[] = [];
    const execute = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.slice(0, 2).join(' ')}`);
      if (command === 'tar') await writeFile(join(args.at(-1)!, 'package.json'), JSON.stringify({ packageManager: 'bun@1.3.14' }));
      if (calls.length === stopAfter) process.emit(stopAfter % 2 ? 'SIGTERM' : 'SIGINT');
      if (command === 'curl' && args.at(-1)!.endsWith('/commits/main')) return JSON.stringify({ sha: one });
      if (command === 'bun' && args[0] === '--version') return '1.3.14';
      return '';
    };
    try {
      await assert.rejects(prepareFrontend('latest', import.meta.url, { cache: root, execute, expectedContracts: contracts }), /interrupted/);
      assert.equal(calls.length, stopAfter, `no command after step ${stopAfter}`);
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('shutdown terminates and reaps an active build child', async () => {
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
    const base = 'name = "Test"\npersona = "persona.md"\n';
    await writeFile(path, base); assert.equal((await loadConfig(path)).frontend, undefined);
    for (const selector of ['latest', one]) { await writeFile(path, `${base}frontend = "${selector}"\n`); assert.equal((await loadConfig(path)).frontend, selector); }
    for (const selector of ['main', 'abc', one.toUpperCase().replace('1', 'A')]) { await writeFile(path, `${base}frontend = "${selector}"\n`); await assert.rejects(loadConfig(path)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
