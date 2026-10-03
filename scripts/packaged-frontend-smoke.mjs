// Run only against a locally prepared tarball, with a fake app-server and test-owned state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture, eventually } from '../apps/partner/tests/fixture.ts';

const archive = resolve(process.argv[2]);
const approved = resolve(process.argv[3]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'cfl-packaged-frontend-')));
const f = await fixture();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  execFileSync('tar', ['-xzf', archive, '-C', root]);
  const packageRoot = join(root, 'package');
  const deps = join(root, 'deps'); await mkdir(deps);
  // Install just the packed runtime's declared JS dependency; no native engine installation or invocation.
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  execFileSync('npm', ['install', '--ignore-scripts', '--prefix', deps, '--cache', join(root, 'npm-cache'), `sharp@${manifest.dependencies.sharp}`], { env: { ...process.env, HOME: root }, stdio: 'inherit' });
  await symlink(join(deps, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const config = join(f.directory, 'partner.toml');
  await writeFile(config, `name = "Mica"\npersona = ${JSON.stringify(f.config.persona)}\nstate = ${JSON.stringify(f.directory)}\nworkspace = ${JSON.stringify(f.workspace)}\nport = ${port}\n[codex]\ncommand = ${JSON.stringify(f.config.codex.command)}\nmodel = "gpt-5.6-luna"\nhome = ${JSON.stringify(f.config.codex.home)}\n`);
  const runtime = spawn(process.execPath, [join(packageRoot, 'vendor/runtime/cli.mjs'), 'serve', config], { cwd: root, env: { PATH: process.env.PATH, HOME: f.directory, ...f.appServer.env, FAKE_HOOK_COMMAND: `${quote(process.execPath)} ${quote(join(packageRoot, 'vendor/runtime/session-start-hook.mjs'))} ${quote(join(f.workspace, '.lamplit/context-bootstrap.json'))}` }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(runtime, 'close'); let stderr = ''; runtime.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const origin = `http://127.0.0.1:${port}`;
    await eventually(async () => { if (runtime.exitCode !== null) throw new Error(stderr); try { return (await fetch(origin)).ok; } catch { return false; } }, 15000);
    const rootHtml = await (await fetch(origin)).text();
    assert.equal(await (await fetch(origin + '/chat')).text(), rootHtml);
    const hashes = await readFile(join(approved, 'browser.sha256'), 'utf8');
    let verified = 0;
    for (const line of hashes.trim().split('\n')) {
      const [, expected, path] = /^(\w{64})  (.+)$/u.exec(line);
      const response = await fetch(`${origin}/${path}`); assert.equal(response.status, 200, path);
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), expected, path); verified++;
    }
    for (const path of ['/slice', '/slice/', '/management', '/assets/missing.js']) assert.equal((await fetch(origin + path)).status, 404);
    const session = await (await fetch(origin + '/api/session')).json(); assert.equal(session.name, 'Mica'); assert.ok(session.sessionId);
    console.log(`Packaged CLI served ${verified} exact approved files, identical / and /chat, canonical 404 boundaries and actual fake-engine session from an isolated extraction.`);
  } finally {
    runtime.kill('SIGTERM');
    const [code] = await closed; assert.equal(code, 0, stderr);
  }
} finally { await f.close(); await rm(root, { recursive: true, force: true }); }
