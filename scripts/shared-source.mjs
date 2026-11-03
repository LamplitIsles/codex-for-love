import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { requireAuthMarker } from '../apps/partner/runtime/frontend-contract.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const prepared = join(root, '.generated/shared-app');
export async function readPin(path = join(root, 'lamplit-app.sha')) {
  const pin = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/u.test(pin)) throw new Error('lamplit-app.sha must contain one full lowercase commit SHA.');
  return pin;
}
export async function readDigest(path = join(root, 'lamplit-contracts.sha256')) {
  const digest = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('lamplit-contracts.sha256 must contain one lowercase SHA-256.');
  return digest;
}
export function identity(directory = root) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: directory, encoding: 'utf8' });
  const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: directory, maxBuffer: 64 * 1024 * 1024 });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: directory });
  const fingerprint = createHash('sha256');
  const frame = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); fingerprint.update(`${bytes.length}:`).update(bytes); };
  frame(diff); frame(status);
  const paths = [];
  for (let start = 0, end; (end = untracked.indexOf(0, start)) !== -1; start = end + 1) paths.push(untracked.subarray(start, end));
  for (const path of paths.sort(Buffer.compare)) {
    const absolute = Buffer.concat([Buffer.from(directory + sep), path]); const kind = lstatSync(absolute); frame(path);
    if (kind.isFile()) { frame('file'); frame(readFileSync(absolute)); }
    else if (kind.isSymbolicLink()) { frame('symlink'); frame(readlinkSync(absolute, { encoding: 'buffer' })); }
    else throw new Error(`Unsupported untracked source entry: ${path.toString()}`);
  }
  return { sha, dirty: Boolean(status), diffSha256: fingerprint.digest('hex') };
}
export function cflIdentity() {
  if (!process.env.CFL_SOURCE_SHA) return identity(root);
  if (!/^[a-f0-9]{40}$/u.test(process.env.CFL_SOURCE_SHA)) throw new Error('CFL_SOURCE_SHA must identify the full archived CFL commit.');
  return { sha: process.env.CFL_SOURCE_SHA };
}
export async function hashes(directory, relative = '') {
  const result = {};
  for (const item of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!relative && item.name === 'node_modules') continue;
    const path = join(relative, item.name);
    if (item.isDirectory()) Object.assign(result, await hashes(directory, path));
    else if (item.isFile()) result[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
    else throw new Error(`Unexpected non-file in prepared resources: ${path}`);
  }
  return result;
}

// A separately reviewed digest authenticates the archive before tar sees any bytes.
export async function unpackContracts(archive, destination, pin, digest) {
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (actual !== digest) throw new Error('App contracts archive SHA-256 mismatch');
  execFileSync('tar', ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions']);
  const pkg = join(destination, 'package');
  const source = JSON.parse(await readFile(join(pkg, 'lamplit-source.json'), 'utf8'));
  if (source.revision !== pin) throw new Error('App contracts source revision mismatch');
  const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  if (metadata.name !== '@lamplit/contracts' || !metadata.exports || !metadata.dependencies || metadata.license !== 'Apache-2.0') throw new Error('Invalid App contracts package metadata');
  for (const paths of Object.values(metadata.exports)) for (const path of Object.values(paths)) {
    if (typeof path !== 'string' || !/^\.\/dist\/[a-z0-9-]+\.(?:js|d\.ts)$/u.test(path)) throw new Error('Invalid public contract export');
    await readFile(join(pkg, path));
  }
  await readFile(join(pkg, 'LICENSE'));
  await readFile(join(pkg, 'licenses/chord-1.0.0-MIT.txt'));
  const contractHashes = await hashes(pkg);
  requireAuthMarker(contractHashes, 'Published App contracts');
  return contractHashes;
}
export async function verifyPrepared() {
  const pin = await readPin(); const digest = await readDigest();
  let manifest;
  try { manifest = JSON.parse(await readFile(join(prepared, 'source.json'), 'utf8')); }
  catch { throw new Error('Prepared App resources are missing; run pnpm source:prepare before frozen installation.'); }
  if (manifest.pin !== pin || manifest.app?.sha !== pin || manifest.archiveSha256 !== digest || 'browser' in manifest) throw new Error('Prepared App identity differs; run pnpm source:prepare again.');
  const temp = await mkdtemp(join(root, '.generated/verify-contracts-'));
  try {
    const expected = await unpackContracts(join(prepared, 'contracts.tar.gz'), temp, pin, digest);
    if (JSON.stringify(expected) !== JSON.stringify(manifest.contracts) || JSON.stringify(await hashes(join(prepared, 'contracts'))) !== JSON.stringify(expected)) throw new Error('Prepared contracts changed; run pnpm source:prepare again.');
    if (JSON.stringify(await hashes(join(prepared, 'licenses'))) !== JSON.stringify(manifest.licenses)) throw new Error('Prepared licenses changed; run pnpm source:prepare again.');
    for (const [name, path] of [['lamplit-app-Apache-2.0.txt', join(temp, 'package/LICENSE')], ['chord-1.0.0-MIT.txt', join(temp, 'package/licenses/chord-1.0.0-MIT.txt')], ['lamplit-app-IMPORTS.md', join(root, 'licenses/app/lamplit-app-IMPORTS.md')], ['NotoSansSC-OFL-1.1.txt', join(root, 'licenses/app/NotoSansSC-OFL-1.1.txt')]]) {
      if (!(await readFile(join(prepared, 'licenses', name))).equals(await readFile(path))) throw new Error(`Prepared license ${name} changed`);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  return manifest;
}
