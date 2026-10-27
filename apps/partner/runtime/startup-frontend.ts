import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Hashes = Record<string, string>;
type Manifest = { revision: string; browser: Hashes; contracts: Hashes; licenses: Hashes };
type Run = (command: string, args: string[], cwd: string, home: string, timeout: number) => Promise<string>;
const sha = /^[a-f0-9]{40}$/u;
const timeout = 10 * 60_000;

// Never forward Partner's credentials, workspace or arbitrary service environment to App code.
function buildEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_CACHE_HOME: join(home, 'cache'), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export const runFrontendCommand: Run = (command, args, cwd, home, limit) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env: buildEnvironment(home), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errorOutput = ''; let stopped = '';
  child.stdout.on('data', data => { output = (output + data).slice(-1024 * 1024); });
  child.stderr.on('data', data => { errorOutput = (errorOutput + data).slice(-8192); });
  const signal = (reason: string) => {
    if (stopped) return;
    stopped = reason;
    try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already exited */ }
    killTimer = setTimeout(() => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } }, 2000);
  };
  const onInt = () => signal('interrupted'); const onTerm = () => signal('shutdown');
  let killTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => signal('timed out'), limit);
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  child.once('error', error => { errorOutput += error.message; });
  child.once('close', code => {
    if (stopped && child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
    }
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    if (code === 0 && !stopped) resolve(output);
    else reject(new Error(`${command} ${stopped || `failed (${code})`}: ${(errorOutput || output.slice(-8192)).trim()}`));
  });
});

async function hashes(directory: string, relative = ''): Promise<Hashes> {
  const result: Hashes = {};
  for (const item of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(relative, item.name);
    if (item.isDirectory()) Object.assign(result, await hashes(directory, path));
    else if (item.isFile()) result[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
    else throw new Error(`Unexpected non-file frontend resource: ${path}`);
  }
  return result;
}

function same(a: Hashes, b: Hashes): boolean {
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => a[key] === b[key]);
}

async function runtimeContracts(runtimeUrl: string): Promise<Hashes> {
  // Bundled runtime is vendor/runtime; source runtime is apps/partner/runtime.
  const bundled = fileURLToPath(new URL('../source.json', runtimeUrl));
  const source = fileURLToPath(new URL('../../../.generated/shared-app/source.json', runtimeUrl));
  let path = bundled;
  try { await access(path); } catch { path = source; }
  const metadata = JSON.parse(await readFile(path, 'utf8')) as { contracts: Hashes };
  const compiled = Object.fromEntries(Object.entries(metadata.contracts).filter(([name]) => name.startsWith('dist/')));
  if (!Object.keys(compiled).length) throw new Error(`Compiled runtime contracts missing in ${path}`);
  return compiled;
}

async function verify(directory: string, revision: string, expected: Hashes): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.revision !== revision || !manifest.browser || !manifest.contracts || !manifest.licenses) throw new Error('Frontend cache manifest has invalid revision or resources');
  const browser = await hashes(join(directory, 'browser'));
  if (!browser['index.html'] || !same(browser, manifest.browser)) throw new Error('Frontend browser integrity mismatch');
  const contracts = await hashes(join(directory, 'contracts'));
  if (!same(contracts, manifest.contracts)) throw new Error('Frontend contracts integrity mismatch');
  if (!same(await hashes(join(directory, 'licenses')), manifest.licenses)) throw new Error('Frontend licenses integrity mismatch');
  if (!same(contracts, expected)) throw new Error('Frontend compiled public contracts differ from this CFL runtime');
}

/** Test seams are passed directly by callers; production always uses canonical URLs and fixed cache. */
export async function prepareFrontend(selector: string, runtimeUrl: string, options: { cache?: string; execute?: Run; expectedContracts?: Hashes } = {}): Promise<string> {
  if (selector !== 'latest' && !sha.test(selector)) throw new Error('Frontend must be latest or a full lowercase commit SHA');
  const cache = options.cache ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'lamplitisles', 'codex-for-love', 'frontend');
  const expected = options.expectedContracts ?? await runtimeContracts(runtimeUrl);
  console.log(`Preparing frontend App ${selector}`);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(cache, '.stage-'));
  const home = join(stage, 'home');
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  const checkInterrupted = () => { if (interrupted) throw new Error('Frontend preparation interrupted'); };
  const execute: Run = (...args) => {
    checkInterrupted();
    return (options.execute ?? runFrontendCommand)(...args);
  };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    await mkdir(home, { mode: 0o700 });
    checkInterrupted();
    let revision = selector;
    if (selector === 'latest') {
      const data = await execute('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60', '-H', 'Accept: application/vnd.github+json', 'https://api.github.com/repos/LamplitIsles/lamplit-app/commits/main'], stage, home, 65_000);
      revision = (JSON.parse(data) as { sha: string }).sha;
      if (!sha.test(revision)) throw new Error('Canonical App main did not resolve to a full commit SHA');
    }
    checkInterrupted();
    console.log(`Resolved frontend App ${revision} (${selector})`);
    const candidate = join(cache, revision);
    let exists = true;
    try { await access(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
    if (!exists) {
      const archive = join(stage, 'source.tar.gz');
      await execute('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '120', '--output', archive, `https://codeload.github.com/LamplitIsles/lamplit-app/tar.gz/${revision}`], stage, home, 125_000);
      const source = join(stage, 'source'); await mkdir(source);
      await execute('tar', ['-xzf', archive, '--strip-components=1', '-C', source], stage, home, 60_000);
      const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { packageManager: string };
      if (pkg.packageManager !== 'bun@1.3.14' || (await execute('bun', ['--version'], source, home, 10_000)).trim() !== '1.3.14') throw new Error('App preparation requires Bun 1.3.14');
      for (const args of [['install', '--frozen-lockfile'], ['run', '--cwd', 'apps/web', 'paraglide-js', 'compile', '--project', './project.inlang', '--outdir', './src/lib/paraglide', '--emit-ts-declarations', '--strategy', 'globalVariable', 'preferredLanguage', 'baseLocale', '--silent'], ['run', 'build']]) await execute('bun', args, source, home, timeout);
      checkInterrupted();
      const built = join(stage, 'candidate'); await mkdir(built);
      await cp(join(source, 'apps/web/build'), join(built, 'browser'), { recursive: true });
      await cp(join(source, 'packages/contracts/dist'), join(built, 'contracts/dist'), { recursive: true });
      await mkdir(join(built, 'licenses'));
      await cp(join(source, 'LICENSE'), join(built, 'licenses', 'lamplit-app-Apache-2.0.txt'));
      await cp(join(source, 'docs/IMPORTS.md'), join(built, 'licenses', 'lamplit-app-IMPORTS.md'));
      const appRequire = createRequire(join(source, 'apps/web/package.json'));
      await cp(join(dirname(appRequire.resolve('@fontsource/noto-sans-sc/package.json')), 'LICENSE'), join(built, 'licenses', 'NotoSansSC-OFL-1.1.txt'));
      const manifest: Manifest = { revision, browser: await hashes(join(built, 'browser')), contracts: await hashes(join(built, 'contracts')), licenses: await hashes(join(built, 'licenses')) };
      await writeFile(join(built, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      await verify(built, revision, expected);
      checkInterrupted();
      try { await rename(built, candidate); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    await verify(candidate, revision, expected);
    checkInterrupted();
    console.log(`Frontend App ${revision} (${selector})`);
    return join(candidate, 'browser');
  } catch (error) {
    throw new Error(`Frontend startup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    await rm(stage, { recursive: true, force: true });
  }
}
