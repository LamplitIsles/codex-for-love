import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { requireAuthMarker } from './frontend-contract.ts';

type Hashes = Record<string, string>;
type Manifest = { revision: string; browser: Hashes; contracts: Hashes; licenses: Hashes };
type Run = (command: string, args: string[], cwd: string, home: string, timeout: number) => Promise<string>;
const sha = /^[a-f0-9]{40}$/u;

// Never forward Partner's credentials, workspace or arbitrary service environment to download commands.
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

export async function verifyFrontend(directory: string, revision: string, expected: Hashes): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.revision !== revision || !manifest.browser || !manifest.contracts || !manifest.licenses) throw new Error('Frontend cache manifest has invalid revision or resources');
  const browser = await hashes(join(directory, 'browser'));
  if (!browser['index.html'] || !same(browser, manifest.browser)) throw new Error('Frontend browser integrity mismatch');
  const contracts = await hashes(join(directory, 'contracts'));
  if (!same(contracts, manifest.contracts)) throw new Error('Frontend contracts integrity mismatch');
  requireAuthMarker(contracts, 'Selected frontend contracts');
  const licenses = await hashes(join(directory, 'licenses'));
  if (!same(licenses, manifest.licenses)) throw new Error('Frontend licenses integrity mismatch');
  for (const notice of ['lamplit-app-Apache-2.0.txt', 'lamplit-app-IMPORTS.md', 'NotoSansSC-OFL-1.1.txt']) {
    if (!Object.hasOwn(licenses, notice)) throw new Error(`Frontend required license notice missing: ${notice}`);
  }
  if (!same(contracts, expected)) throw new Error('Frontend compiled public contracts differ from this CFL runtime');
}

// Read archive entries ourselves so neither links nor tar path extensions can escape
// the private staging directory. Only regular files and directories are resources.
async function extractFrontend(archive: string, destination: string): Promise<void> {
  const data = gunzipSync(await readFile(archive), { maxOutputLength: 512 * 1024 * 1024 });
  const seen = new Set<string>();
  let offset = 0; let ended = false;
  const field = (block: Buffer, start: number, length: number) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
  const parseOctalField = (value: string) => {
    const trimmed = value.trim();
    if (!/^[0-7]*$/u.test(trimmed)) throw new Error('Invalid frontend archive number');
    return trimmed ? parseInt(trimmed, 8) : 0;
  };
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { ended = true; break; }
    const checksum = parseOctalField(field(header, 148, 8));
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i]!;
    if (checksum !== actual) throw new Error('Invalid frontend archive checksum');
    const size = parseOctalField(field(header, 124, 12));
    if (!Number.isSafeInteger(size) || offset + size > data.length) throw new Error('Truncated frontend archive');
    const contents = data.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (field(header, 257, 6) !== 'ustar') throw new Error('Frontend archive must use POSIX ustar format');
    const prefix = field(header, 345, 155);
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const path = name.replace(/\/$/u, '');
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || !['manifest.json', 'browser', 'contracts', 'licenses'].includes(path.split('/')[0]!)) throw new Error(`Unsafe frontend archive path: ${name}`);
    if (seen.has(path)) throw new Error(`Duplicate frontend archive path: ${path}`);
    seen.add(path);
    const target = join(destination, path);
    if (type === '5') { if (size) throw new Error('Invalid frontend archive directory'); await mkdir(target, { recursive: true }); }
    else if (type === '0') { await mkdir(dirname(target), { recursive: true }); await writeFile(target, contents, { flag: 'wx', mode: 0o600 }); }
    else throw new Error(`Unsupported frontend archive entry: ${name}`);
  }
  if (!ended) throw new Error('Incomplete frontend archive');
}

/** Test seams are passed directly by callers; production always uses canonical URLs and fixed cache. */
export async function prepareFrontend(selector: string, runtimeUrl: string, options: { cache?: string; execute?: Run; expectedContracts?: Hashes } = {}): Promise<string> {
  if (selector !== 'latest' && !sha.test(selector)) throw new Error('Frontend must be latest or a full lowercase commit SHA');
  const cache = options.cache ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'lamplitisles', 'codex-for-love', 'frontend');
  const expected = options.expectedContracts ?? await runtimeContracts(runtimeUrl);
  requireAuthMarker(expected, 'CFL runtime contracts');
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
      const archive = join(stage, 'frontend.tar.gz');
      const url = `https://github.com/LamplitIsles/lamplit-app/releases/download/app-${revision}/lamplit-app-${revision}.tar.gz`;
      try {
        await execute('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '120', '--max-filesize', '134217728', '--output', archive, url], stage, home, 125_000);
      } catch (error) {
        throw new Error(`Cannot download App ${revision} from ${url}; its release may still be publishing. Retry when available. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      checkInterrupted();
      const built = join(stage, 'candidate'); await mkdir(built);
      await extractFrontend(archive, built);
      await verifyFrontend(built, revision, expected);
      checkInterrupted();
      try { await rename(built, candidate); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    await verifyFrontend(candidate, revision, expected);
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
