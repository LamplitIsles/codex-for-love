// Run only against a locally prepared tarball, with a fake app-server and test-owned state.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, eventually } from '../apps/partner/tests/fixture.ts';
import { seedSmokeFrontend, smokeHtml, smokeRevision } from './smoke-frontend.mjs';

const archive = resolve(process.argv[2]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'cfl-packaged-frontend-')));
let f;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  f = await fixture();
  execFileSync('tar', ['-xzf', archive, '-C', root]);
  const packageRoot = join(root, 'package');
  const source = await seedSmokeFrontend(join(root, 'cache'));
  // Reuse the checkout's installed runtime dependencies; this does not test a fresh install.
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const dependencies = join(import.meta.dirname, '../apps/partner/node_modules');
  const partnerRequire = createRequire(join(import.meta.dirname, '../apps/partner/package.json'));
  if (partnerRequire('sharp/package.json').version !== manifest.dependencies.sharp || partnerRequire('koffi').version !== manifest.dependencies.koffi) throw new Error('Packaged runtime dependencies differ from the existing checkout dependencies.');
  await symlink(dependencies, join(packageRoot, 'node_modules'), 'dir');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const marker = `CFL_SMOKE_HTTP_OK_${randomUUID()}`;
  const config = join(f.directory, 'partner.toml');
  await writeFile(config, `name = "Mica"\nfrontend = "${smokeRevision}"\nprompts = { persona = ${JSON.stringify(f.config.prompts.persona)} }\nstate = ${JSON.stringify(f.directory)}\nworkspace = ${JSON.stringify(f.workspace)}\nport = ${port}\n[codex]\ncommand = ${JSON.stringify(f.config.codex.command)}\nmodel = "gpt-5.6-luna"\nhome = ${JSON.stringify(f.config.codex.home)}\n${f.config.codex.socket_path ? `socket_path = ${JSON.stringify(f.config.codex.socket_path)}\n` : ''}`);
  const runtime = spawn(process.execPath, [join(packageRoot, 'vendor/runtime/cli.mjs'), 'serve', config], { cwd: root, env: { PATH: process.env.PATH, HOME: f.directory, XDG_CACHE_HOME: join(root, 'cache'), ...f.appServer.env, NODE_OPTIONS: `--import=${pathToFileURL(join(import.meta.dirname, 'artifact-smoke-probe.mjs')).href}`, CFL_SMOKE_PROBE_PORT: String(port), CFL_SMOKE_PROBE_MARKER: marker, CFL_SMOKE_PROBE_HTML: smokeHtml, CFL_SMOKE_PROBE_MODULE: pathToFileURL(join(import.meta.dirname, 'packaged-frontend-probe.mjs')).href, CFL_SMOKE_BROWSER_MANIFEST: JSON.stringify(source.browser), CFL_SMOKE_CONFIG: config, CFL_SMOKE_WORKSPACE: f.workspace, FAKE_HOOK_COMMAND: `${quote(process.execPath)} ${quote(join(packageRoot, 'vendor/runtime/session-start-hook.mjs'))} ${quote(join(f.workspace, '.lamplit/context-bootstrap.json'))}` }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(runtime, 'close'); let stderr = ''; let stdout = ''; let verified = false;
  runtime.stderr.on('data', chunk => { stderr += chunk; });
  runtime.stdout.on('data', chunk => { stdout += chunk; if (stdout.split('\n').includes(marker)) verified = true; });
  try {
    await eventually(async () => { if (runtime.exitCode !== null || runtime.signalCode !== null) throw new Error(stderr); return verified; }, 30000);
  } finally {
    runtime.kill('SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-runtime.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 10000);
    try { const [code] = await closed; assert.equal(code, 0, stderr); } finally { clearTimeout(timer); }
  }
} finally { try { await f?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
