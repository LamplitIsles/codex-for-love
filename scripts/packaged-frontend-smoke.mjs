// Run only against a locally prepared tarball, with a fake app-server and test-owned state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fixture, eventually } from '../apps/partner/tests/fixture.ts';

const archive = resolve(process.argv[2]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'cfl-packaged-frontend-')));
const f = await fixture();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  execFileSync('tar', ['-xzf', archive, '-C', root]);
  const packageRoot = join(root, 'package');
  const deps = join(root, 'deps'); await mkdir(deps);
  // Install the packed runtime's declared dependencies; no native engine installation or invocation.
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  execFileSync('npm', ['install', '--ignore-scripts', '--prefix', deps, '--cache', join(root, 'npm-cache'), `sharp@${manifest.dependencies.sharp}`, `koffi@${manifest.dependencies.koffi}`], { env: { ...process.env, HOME: root }, stdio: 'inherit' });
  await symlink(join(deps, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const config = join(f.directory, 'partner.toml');
  await writeFile(config, `name = "Mica"\nprompts = { persona = ${JSON.stringify(f.config.prompts.persona)} }\nstate = ${JSON.stringify(f.directory)}\nworkspace = ${JSON.stringify(f.workspace)}\nport = ${port}\n[codex]\ncommand = ${JSON.stringify(f.config.codex.command)}\nmodel = "gpt-5.6-luna"\nhome = ${JSON.stringify(f.config.codex.home)}\n`);
  const runtime = spawn(process.execPath, [join(packageRoot, 'vendor/runtime/cli.mjs'), 'serve', config], { cwd: root, env: { PATH: process.env.PATH, HOME: f.directory, ...f.appServer.env, FAKE_HOOK_COMMAND: `${quote(process.execPath)} ${quote(join(packageRoot, 'vendor/runtime/session-start-hook.mjs'))} ${quote(join(f.workspace, '.lamplit/context-bootstrap.json'))}` }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(runtime, 'close'); let stderr = ''; runtime.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const origin = `http://127.0.0.1:${port}`;
    await eventually(async () => { if (runtime.exitCode !== null) throw new Error(stderr); try { return (await fetch(origin)).ok; } catch { return false; } }, 15000);
    const rootHtml = await (await fetch(origin)).text();
    assert.equal(await (await fetch(origin + '/chat')).text(), rootHtml);
    const source = JSON.parse(await readFile(join(packageRoot, 'vendor/source.json'), 'utf8'));
    let verified = 0;
    for (const [path, expected] of Object.entries(source.browser)) {
      const response = await fetch(`${origin}/${path}`); assert.equal(response.status, 200, path);
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), expected, path); verified++;
    }
    for (const path of ['/slice', '/slice/', '/management', '/assets/missing.js']) assert.equal((await fetch(origin + path)).status, 404);
    const session = await (await fetch(origin + '/api/session')).json(); assert.equal(session.name, 'Mica'); assert.ok(session.sessionId);
    const sharp = createRequire(join(deps, 'package.json'))('sharp');
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#cc8844' } }).png().toBuffer();
    await writeFile(join(f.workspace, 'package 图片%20.png'), image);
    const imageResponse = await fetch(`${origin}/api/chat/workspace-image?${new URLSearchParams({ path: 'package 图片%20.png' })}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.equal(imageResponse.headers.get('cache-control'), 'no-store');
    assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image);
    console.log(`Packaged CLI served ${verified} exact approved files, identical / and /chat, canonical 404 boundaries, actual fake-engine session and workspace image bytes from an isolated extraction.`);
  } finally {
    runtime.kill('SIGTERM');
    const [code] = await closed; assert.equal(code, 0, stderr);
  }
  // Exercise the actual bundled CLI with a fully manifested, test-owned cached
  // revision. This avoids network and builds while verifying package metadata.
  const source = JSON.parse(await readFile(join(packageRoot, 'vendor/source.json'), 'utf8'));
  const revision = '1'.repeat(40);
  const cache = join(root, 'cache', 'lamplitisles/codex-for-love/frontend', revision);
  await mkdir(cache, { recursive: true });
  await cp(join(packageRoot, 'vendor/build'), join(cache, 'browser'), { recursive: true });
  await cp(join(import.meta.dirname, '../.generated/shared-app/contracts/dist'), join(cache, 'contracts/dist'), { recursive: true });
  await cp(join(import.meta.dirname, '../.generated/shared-app/licenses'), join(cache, 'licenses'), { recursive: true });
  await writeFile(join(cache, 'manifest.json'), JSON.stringify({ revision, browser: source.browser, contracts: Object.fromEntries(Object.entries(source.contracts).filter(([key]) => key.startsWith('dist/'))), licenses: source.licenses }));
  await writeFile(config, `frontend = "${revision}"\n` + await readFile(config, 'utf8'));
  const selected = spawn(process.execPath, [join(packageRoot, 'vendor/runtime/cli.mjs'), 'serve', config], { cwd: root, env: { PATH: process.env.PATH, HOME: f.directory, XDG_CACHE_HOME: join(root, 'cache'), ...f.appServer.env, FAKE_HOOK_COMMAND: `${quote(process.execPath)} ${quote(join(packageRoot, 'vendor/runtime/session-start-hook.mjs'))} ${quote(join(f.workspace, '.lamplit/context-bootstrap.json'))}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  const selectedClosed = once(selected, 'close'); let selectedOut = ''; let selectedErr = '';
  selected.stdout.on('data', chunk => { selectedOut += chunk; }); selected.stderr.on('data', chunk => { selectedErr += chunk; });
  try {
    const origin = `http://127.0.0.1:${port}`;
    await eventually(async () => { if (selected.exitCode !== null) throw new Error(selectedErr); try { return (await fetch(origin)).ok; } catch { return false; } }, 15000);
    assert.match(selectedOut, new RegExp(`Frontend App ${revision}`));
    assert.equal(await (await fetch(origin + '/')).text(), await (await fetch(origin + '/chat')).text());
    console.log(`Packaged CLI selected and verified cached App ${revision} using bundled contract metadata.`);
  } finally { selected.kill('SIGTERM'); const [code] = await selectedClosed; assert.equal(code, 0, selectedErr); }
} finally { await f.close(); await rm(root, { recursive: true, force: true }); }
