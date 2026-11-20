import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareCodex } from '../apps/partner/runtime/startup-codex.ts';
import { SUPPORTED_CODEX_VERSION } from '../apps/partner/runtime/config.ts';
import { seedSmokeFrontend, smokeHtml, smokeRevision } from './smoke-frontend.mjs';

const root = resolve(import.meta.dirname, '..');
const mainPackageName = '@lamplitisles/codex-for-love';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Artifact smoke supports Linux x64 only.');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'cfl-artifact-smoke-')));

function archiveManifest(archive) {
  return JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
}

async function waitForServer(child, observed, stderr) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged runtime exited before listening (${child.exitCode}, ${child.signalCode}): ${stderr()}`);
    if (observed()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Packaged runtime did not serve the selected test frontend.');
}

try {
  const artifacts = process.env.CFL_ARTIFACT_DIR ? resolve(process.env.CFL_ARTIFACT_DIR) : join(temporary, 'artifacts');
  if (!process.env.CFL_ARTIFACT_DIR) {
    execFileSync('mkdir', ['-p', artifacts]);
    for (const directory of ['packages/codex-for-love']) {
      execFileSync('npm', ['pack', '--json', '--pack-destination', artifacts], { cwd: join(root, directory), stdio: 'inherit' });
    }
  }
  const tarballs = (await readdir(artifacts)).filter(name => name.endsWith('.tgz'));
  const main = tarballs.find((name) => archiveManifest(join(artifacts, name)).name === mainPackageName);
  if (!main) throw new Error('Expected one main tarball.');
  const prefix = join(temporary, 'prefix');
  const installInputs = [join(artifacts, main)];
  const isolatedEnv = { PATH: process.env.PATH, HOME: join(temporary, 'home'),
    CODEX_HOME: join(temporary, 'codex-home'), XDG_CONFIG_HOME: join(temporary, 'config'),
    XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'),
    npm_config_cache: join(temporary, 'npm-cache'), npm_config_userconfig: join(temporary, 'npmrc'),
    npm_config_globalconfig: join(temporary, 'global-npmrc') };
  await Promise.all([isolatedEnv.HOME, isolatedEnv.CODEX_HOME, isolatedEnv.XDG_CONFIG_HOME, isolatedEnv.XDG_DATA_HOME, isolatedEnv.XDG_CACHE_HOME].map(path => mkdir(path, { recursive: true })));
  execFileSync('npm', ['install', '--global', '--ignore-scripts', '--prefer-online', '--prefix', prefix, ...installInputs], { stdio: 'inherit', timeout: 120_000, env: isolatedEnv });
  execFileSync(join(prefix, 'bin', 'codex-for-love'), ['--help'], { stdio: 'inherit', env: isolatedEnv });
  const mainRoot = join(prefix, 'lib', 'node_modules', '@lamplitisles', 'codex-for-love');
  const nativeRoot = await prepareCodex({ cache: join(isolatedEnv.XDG_CACHE_HOME, 'lamplitisles/codex-for-love/codex'),
    ...(process.env.CFL_NATIVE_ARCHIVE ? { download: async (_url, destination) => { const { copyFile } = await import('node:fs/promises'); await copyFile(resolve(process.env.CFL_NATIVE_ARCHIVE), destination); } } : {}) });
  const reportedVersion = execFileSync(join(nativeRoot, 'bin', 'codex-app-server'), ['--version'], { encoding: 'utf8', env: isolatedEnv }).trim();
  if (reportedVersion !== `codex-app-server ${SUPPORTED_CODEX_VERSION}`) throw new Error(`Unsupported app-server: ${reportedVersion}`);
  console.log(reportedVersion);
  execFileSync(join(nativeRoot, 'bin', 'codex-code-mode-host'), ['--help'], { stdio: 'ignore', env: isolatedEnv });

  const fakeServer = join(root, 'apps', 'partner', 'tests', 'fake-app-server-entry.mjs');
  const fakeExecutable = join(temporary, 'fake-app-server.mjs');
  await writeFile(fakeExecutable, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fakeServer).href)};\n`, { mode: 0o755 });
  const fixture = join(temporary, 'fixture');
  await seedSmokeFrontend(isolatedEnv.XDG_CACHE_HOME);
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'persona.md'), 'You are Mica.');
  await writeFile(join(fixture, 'control.json'), '{}');
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const marker = `CFL_SMOKE_HTTP_OK_${randomUUID()}`;
  await writeFile(join(fixture, 'partner.toml'), `name = "Mica"\nfrontend = "${smokeRevision}"\nprompts = { persona = "./persona.md" }\nstate = "./state"\nworkspace = "./workspace"\nport = ${port}\n[codex]\ncommand = "${fakeExecutable}"\n`);
  const workspace = join(fixture, 'workspace');
  await writeFile(join(isolatedEnv.CODEX_HOME, 'config.toml'), `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n[features]\nplugins = false\n`);
  // The packaged launcher must consume the verified real archive from the isolated cache.
  const real = spawn(join(prefix, 'bin', 'codex-for-love'), ['serve', join(fixture, 'partner.toml')], {
    detached: true, env: { ...isolatedEnv, CODEX_DISABLE_FEEDBACK: '1', CODEX_DISABLE_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let realOutput = '';
  real.stderr.on('data', chunk => { realOutput = (realOutput + chunk).slice(-8000); });
  const realClosed = once(real, 'close');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 600; attempt++) {
      if (real.exitCode !== null || real.signalCode !== null) throw new Error(`Packaged real Codex startup failed: ${realOutput}`);
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error(`Packaged real Codex did not listen: ${realOutput}`);
    console.log('Packaged launcher served with the verified real Codex release.');
  } finally {
    real.kill('SIGTERM');
    let timer;
    try { await Promise.race([realClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged real runtime did not stop')), 10000); })]); }
    finally { clearTimeout(timer); try { process.kill(-real.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  // The behavioral probe uses a fresh fake-server workspace and sends no external messages.
  await rm(workspace, { recursive: true, force: true });
  await rm(join(fixture, 'state'), { recursive: true, force: true });
  const runtime = spawn(process.execPath, [join(mainRoot, 'vendor/runtime/cli.mjs'), 'serve', join(fixture, 'partner.toml')], {
    detached: true,
    env: { ...isolatedEnv, NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'scripts/artifact-smoke-probe.mjs')).href}`, CFL_SMOKE_PROBE_PORT: String(port), CFL_SMOKE_PROBE_MARKER: marker, CFL_SMOKE_PROBE_HTML: smokeHtml, FAKE_SERVER_ROOT: fixture, FAKE_SERVER_STATE: join(fixture, 'fake-state.json'), FAKE_SERVER_REQUESTS: join(fixture, 'requests.jsonl'), FAKE_SERVER_CONTROL: join(fixture, 'control.json'), FAKE_HOOK_COMMAND: `'${process.execPath}' '${join(mainRoot, 'vendor', 'runtime', 'session-start-hook.mjs')}' '${join(workspace, '.lamplit', 'context-bootstrap.json')}'`, FAKE_CONFIG_PATH: join(workspace, '.codex', 'config.toml') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(runtime, 'close');
  let stderr = ''; let stdout = ''; let verified = false;
  runtime.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  runtime.stdout.on('data', (chunk) => {
    const output = `${stdout}${chunk}`;
    if (output.split('\n').includes(marker)) verified = true;
    stdout = output.slice(-4000);
  });
  try {
    await waitForServer(runtime, () => verified, () => stderr);
  } finally {
    runtime.kill('SIGTERM');
    let timer;
    try {
      const [code, signal] = await Promise.race([
        closed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Installed runtime did not close within 10s after SIGTERM')), 10_000); }),
      ]);
      if (code !== 0 || signal) throw new Error(`Installed runtime stopped abnormally (${code}, ${signal}): ${stderr}`);
    } finally {
      clearTimeout(timer);
      // Kill only this test-owned process group if graceful cleanup failed.
      try { process.kill(-runtime.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  console.log(JSON.stringify({ prefix, main, codexVersion: SUPPORTED_CODEX_VERSION }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
