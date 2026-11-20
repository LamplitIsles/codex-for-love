import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { acquirePrivateFileLock } from './private-file-lock.ts';
import { runFrontendCommand } from './startup-frontend.ts';

const release = 'v0.170.0-cfl.1';
const url = `https://forgejo.n5.guion.io/LamplitIsles/codex-build/releases/download/${release}/codex-linux-x64-musl.tar.gz`;
const digest = 'f687ee0ccc12e0a4c4c45d974408936b47d970cd3276550eb0f44c71894f1397';
const files: Record<string, string> = {
  'bin/codex-app-server': '7cccd29bf2a83c3e162fb78fc9404f893ec2d21d547bc341e882698a7af05427',
  'bin/codex-code-mode-host': 'ffc1ad7023864bfc209c408887d6834a8f644201eff4432fb9558b7f1c40e9dc',
  'licenses/LICENSE': 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc',
  'licenses/NOTICE': '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915',
  'provenance.json': '1670563b2239a4b1515deb615f3b574c08a67cad5e6cc510bd3a04bba40fa128',
};
type Pin = { release: string; version: string; url: string; digest: string; files: Record<string, string> };
const pin: Pin = { release, version: '0.170.0', url, digest, files };
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function verify(directory: string, expected: Pin) {
  const root = await lstat(directory);
  if (!root.isDirectory() || (process.getuid && root.uid !== process.getuid()) || (root.mode & 0o077)) throw new Error('Invalid Codex cache directory');
  const found: string[] = [];
  async function walk(relative = ''): Promise<void> {
    for (const name of await readdir(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(directory, path));
      if (info.isDirectory()) { if (path !== 'bin' && path !== 'licenses') throw new Error(`Unexpected cache directory ${path}`); await walk(path); }
      else if (info.isFile()) {
        if (!Object.hasOwn(expected.files, path) || (path.startsWith('bin/') && (info.mode & 0o100) === 0) || await hashFile(join(directory, path)) !== expected.files[path]) throw new Error(`Invalid cached Codex file ${path}`);
        found.push(path);
      } else throw new Error(`Unexpected cache entry ${path}`);
    }
  }
  await walk();
  if (found.length !== Object.keys(expected.files).length) throw new Error('Incomplete Codex cache');
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8')) as { release?: string; upstream_tag?: string; target?: string };
  if (provenance.release !== expected.release || provenance.upstream_tag !== `rust-v${expected.version}` || provenance.target !== 'x86_64-unknown-linux-musl') throw new Error('Codex release provenance mismatch');
}
async function extract(archive: Buffer, destination: string, expected: Pin) {
  if (sha(archive) !== expected.digest) throw new Error('Codex archive SHA-256 mismatch');
  const data = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  let offset = 0, ended = false;
  const seen = new Set<string>();
  const field = (block: Buffer, start: number, length: number) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
  const octal = (value: string) => { const s = value.trim(); if (!/^[0-7]*$/u.test(s)) throw new Error('Invalid Codex archive number'); return s ? parseInt(s, 8) : 0; };
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512); offset += 512;
    if (header.every(b => b === 0)) { ended = true; break; }
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (checksum !== octal(field(header, 148, 8))) throw new Error('Invalid Codex archive checksum');
    const size = octal(field(header, 124, 12));
    if (!Number.isSafeInteger(size) || offset + size > data.length) throw new Error('Truncated Codex archive');
    const content = data.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const prefix = field(header, 345, 155), name = field(header, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    if (!Object.hasOwn(expected.files, path) || seen.has(path) || !['0', '\0'].includes(String.fromCharCode(header[156]!))) throw new Error(`Unexpected Codex archive entry ${path}`);
    if (sha(content) !== expected.files[path]) throw new Error(`Invalid Codex archive file ${path}`);
    seen.add(path); await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(destination, path), content, { flag: 'wx', mode: path.startsWith('bin/') ? 0o700 : 0o600 });
  }
  if (!ended || data.subarray(offset).some(byte => byte !== 0) || seen.size !== Object.keys(expected.files).length) throw new Error('Incomplete or unexpected Codex archive content');
}

/** Pin and download overrides are test seams; packaged startup uses the fixed release. */
export async function prepareCodex(options: { cache?: string; pin?: Pin; download?: (url: string, archive: string, stage: string) => Promise<void> } = {}): Promise<string> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error(`Unsupported Codex platform ${process.platform}-${process.arch}; only Linux x64 is available`);
  const selected = options.pin ?? pin;
  if (!/^v[0-9A-Za-z.-]+$/u.test(selected.release)) throw new Error('Invalid Codex release');
  const cache = options.cache ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'lamplitisles/codex-for-love/codex');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const cacheInfo = await lstat(cache);
  if (!cacheInfo.isDirectory() || (process.getuid && cacheInfo.uid !== process.getuid()) || (cacheInfo.mode & 0o077)) throw new Error('Codex cache must be a private directory owned by the current user');
  let lock: Awaited<ReturnType<typeof acquirePrivateFileLock>> = null;
  for (let i = 0; i < 600 && !lock; i++) { lock = await acquirePrivateFileLock(join(cache, '.lock')); if (!lock) await new Promise(resolve => setTimeout(resolve, 100)); }
  if (!lock) throw new Error('Timed out waiting for Codex cache lock');
  const candidate = join(cache, selected.release);
  let stage: string | undefined;
  try {
    try { await verify(candidate, selected); return candidate; } catch { /* Missing or corrupt cache is replaced only under the lock. */ }
    stage = await mkdtemp(join(cache, '.stage-'));
    const archive = join(stage, 'release.tar.gz');
    if (options.download) await options.download(selected.url, archive, stage);
    else await runFrontendCommand('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '180', '--max-filesize', '268435456', '--output', archive, selected.url], stage, stage, 185_000);
    const info = await lstat(archive);
    if (!info.isFile() || info.size > 268435456) throw new Error('Codex archive exceeds size limit');
    const built = join(stage, 'candidate'); await mkdir(built, { mode: 0o700 });
    await extract(await readFile(archive), built, selected); await verify(built, selected);
    await rm(candidate, { recursive: true, force: true }); await rename(built, candidate);
    return candidate;
  } catch (error) { throw new Error(`Codex ${selected.release} preparation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  finally { if (stage) await rm(stage, { recursive: true, force: true }); await lock.close(); }
}
