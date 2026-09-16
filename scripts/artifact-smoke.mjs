import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'cfl-artifact-smoke-')));
const mainPackageName = '@lamplitisles/codex-for-love';
const mac = process.platform === 'darwin' && process.arch === 'arm64';
if (!mac && (process.platform !== 'linux' || process.arch !== 'x64')) throw new Error('Artifact smoke supports Linux x64 and macOS ARM64 only.');
const nativePackageName = mac ? '@lamplitisles/codex-for-love-darwin-arm64' : '@lamplitisles/codex-for-love-linux-x64';

function archiveManifest(archive) {
  return JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
}

async function waitForServer(url, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged runtime exited before listening (${child.exitCode}): ${stderr()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Packaged runtime did not serve its bundled web assets.');
}

try {
  const publicRegistry = process.env.CFL_PUBLIC_SMOKE === '1';
  const artifacts = process.env.CFL_ARTIFACT_DIR ? resolve(process.env.CFL_ARTIFACT_DIR) : join(temporary, 'artifacts');
  if (!process.env.CFL_ARTIFACT_DIR && !publicRegistry) {
    execFileSync('mkdir', ['-p', artifacts]);
    for (const directory of ['packages/codex-for-love']) {
      execFileSync('npm', ['pack', '--json', '--pack-destination', artifacts], { cwd: join(root, directory), stdio: 'inherit' });
    }
  }
  const tarballs = publicRegistry ? [] : (await readdir(artifacts)).filter(name => name.endsWith('.tgz'));
  const sourceManifest = JSON.parse(await readFile(join(root, 'packages', 'codex-for-love', 'package.json'), 'utf8'));
  const releaseVersion = process.env.CFL_RELEASE_VERSION ?? sourceManifest.version;
  const main = publicRegistry ? `${mainPackageName}@${releaseVersion}` : tarballs.find((name) => archiveManifest(join(artifacts, name)).name === mainPackageName);
  if (!main) throw new Error('Expected one main tarball.');
  const mainManifest = publicRegistry ? sourceManifest : archiveManifest(join(artifacts, main));
  const nativeVersion = mainManifest.optionalDependencies?.[nativePackageName];
  if (typeof nativeVersion !== 'string') throw new Error('Main package does not pin an exact native package version.');
  const nativeArchive = publicRegistry ? undefined : tarballs.find((name) => archiveManifest(join(artifacts, name)).name === nativePackageName);
  const native = nativeArchive ? join(artifacts, nativeArchive) : `${nativePackageName}@${nativeVersion}`;
  const prefix = join(temporary, 'prefix');
  const installInputs = [native, publicRegistry ? main : join(artifacts, main)];
  execFileSync('npm', ['install', '--global', '--ignore-scripts', '--prefer-online', '--prefix', prefix, ...installInputs], { stdio: 'inherit', timeout: 120_000 });
  execFileSync(join(prefix, 'bin', 'codex-for-love'), ['--help'], { stdio: 'inherit', env: { ...process.env, HOME: join(temporary, 'home') } });
  const nativeRoot = join(prefix, 'lib', 'node_modules', '@lamplitisles', mac ? 'codex-for-love-darwin-arm64' : 'codex-for-love-linux-x64');
  const mainRoot = join(prefix, 'lib', 'node_modules', '@lamplitisles', 'codex-for-love');
  execFileSync(join(nativeRoot, 'bin', 'codex-app-server'), ['--version'], { stdio: 'inherit' });
  execFileSync(join(nativeRoot, 'bin', 'codex-code-mode-host'), ['--help'], { stdio: 'ignore' });

  const fakeServer = join(root, 'apps', 'partner', 'tests', 'fake-app-server-entry.mjs');
  const fakeExecutable = join(nativeRoot, 'bin', 'codex-app-server');
  const fakeHelper = join(nativeRoot, 'bin', 'codex-code-mode-host');
  await writeFile(fakeExecutable, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fakeServer).href)};\n`, { mode: 0o755 });
  await writeFile(fakeHelper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
  await writeFile(join(nativeRoot, 'provenance.json'), `${JSON.stringify({
    schemaVersion: 1,
    forkRepository: 'https://github.com/lamplitisles/codex',
    sourceRevision: mac ? 'c1139f7b2793e94c14243689d756b09c0186708d' : '445477b6a83514611ac206d2ab04b79374555a4c',
    releaseTag: mac ? 'cfl/v0.154.0-app-server-darwin.1' : 'cfl/v0.154.0-app-server-musl.1',
    codexVersion: '0.154.0',
    target: mac ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-musl',
    executables: {
      'bin/codex-app-server': await hash(fakeExecutable),
      'bin/codex-code-mode-host': await hash(fakeHelper),
    },
  })}\n`);
  const fixture = join(temporary, 'fixture');
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'persona.md'), 'You are Mica.');
  await writeFile(join(fixture, 'control.json'), '{}');
  const port = 31982;
  await writeFile(join(fixture, 'partner.toml'), `name = "Mica"\npersona = "./persona.md"\nstate = "./state"\nworkspace = "./workspace"\nport = ${port}\n[codex]\nmodel = "gpt-5.6-luna"\n`);
  const workspace = join(fixture, 'workspace');
  const runtime = spawn(join(prefix, 'bin', 'codex-for-love'), ['serve', join(fixture, 'partner.toml')], {
    detached: true,
    env: { ...process.env, HOME: join(temporary, 'home'), FAKE_SERVER_ROOT: fixture, FAKE_SERVER_STATE: join(fixture, 'fake-state.json'), FAKE_SERVER_REQUESTS: join(fixture, 'requests.jsonl'), FAKE_SERVER_CONTROL: join(fixture, 'control.json'), FAKE_HOOK_COMMAND: `'${process.execPath}' '${join(mainRoot, 'vendor', 'runtime', 'session-start-hook.mjs')}' '${join(workspace, '.lamplit', 'context-bootstrap.json')}'`, FAKE_CONFIG_PATH: join(workspace, '.codex', 'config.toml') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = once(runtime, 'close');
  let stderr = '';
  runtime.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, runtime, () => stderr);
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
  console.log(JSON.stringify({ prefix, native: nativeArchive ?? native, main, nativeVersion }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
