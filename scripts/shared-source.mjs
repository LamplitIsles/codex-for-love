import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const prepared = join(root, '.generated/shared-app');
export const source = join(root, '../lamplit-app');
export async function readPin(path = join(root, 'lamplit-app.sha')) {
  const pin = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/u.test(pin)) throw new Error('lamplit-app.sha must contain one full lowercase commit SHA.');
  return pin;
}
export function identity(directory = source) {
  let sha, status, diff, untracked;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: directory, encoding: 'utf8' });
    diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: directory, maxBuffer: 64 * 1024 * 1024 });
    untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: directory });
  } catch { throw new Error('Adjacent lamplit-app source is unavailable; checkout the recorded SHA next to CFL.'); }
  const fingerprint = createHash('sha256');
  const frame = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    fingerprint.update(`${bytes.length}:`).update(bytes);
  };
  frame(diff); frame(status);
  const paths = [];
  for (let start = 0, end; (end = untracked.indexOf(0, start)) !== -1; start = end + 1) paths.push(untracked.subarray(start, end));
  for (const path of paths.sort(Buffer.compare)) {
    const absolute = Buffer.concat([Buffer.from(directory + sep), path]);
    const kind = lstatSync(absolute);
    frame(path);
    if (kind.isFile()) { frame('file'); frame(readFileSync(absolute)); }
    else if (kind.isSymbolicLink()) { frame('symlink'); frame(readlinkSync(absolute, { encoding: 'buffer' })); }
    else throw new Error(`Unsupported untracked source entry: ${path.toString()}; use regular files or symlinks.`);
  }
  return { sha, dirty: Boolean(status), diffSha256: fingerprint.digest('hex') };
}

export function cflIdentity() {
  if (!process.env.CFL_SOURCE_SHA) return identity(root);
  if (!/^[a-f0-9]{40}$/u.test(process.env.CFL_SOURCE_SHA)) throw new Error('CFL_SOURCE_SHA must identify the full archived CFL commit.');
  return { sha: process.env.CFL_SOURCE_SHA };
}
export function requirePinned(actual, pin) {
  if (actual.sha !== pin || actual.dirty) throw new Error(`Formal source must be clean at ${pin}; found ${actual.sha}${actual.dirty ? ' with local changes' : ''}.`);
}
export async function hashes(directory, relative = '') {
  const result = {};
  for (const item of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    // pnpm adds runtime dependencies after preparation; only package resources are manifested.
    if (!relative && item.name === 'node_modules') continue;
    const path = join(relative, item.name);
    if (item.isDirectory()) Object.assign(result, await hashes(directory, path));
    else if (item.isFile()) result[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
    else throw new Error(`Unexpected non-file in prepared resources: ${path}`);
  }
  return result;
}
export async function verifyPrepared({ strict = false } = {}) {
  const pin = await readPin();
  let manifest;
  try { manifest = JSON.parse(await readFile(join(prepared, 'source.json'), 'utf8')); }
  catch { throw new Error('Prepared App resources are missing; run pnpm source:prepare before frozen installation.'); }
  if (manifest.pin !== pin) throw new Error('Prepared App pin differs; run pnpm source:prepare again.');
  if (strict) requirePinned(manifest.app, pin);
  if (JSON.stringify(identity()) !== JSON.stringify(manifest.app)) throw new Error('App source changed since preparation; run pnpm source:prepare again.');
  for (const [directory, expected] of [['browser', manifest.browser], ['contracts', manifest.contracts]]) {
    if (JSON.stringify(await hashes(join(prepared, directory))) !== JSON.stringify(expected)) throw new Error(`Prepared ${directory} changed; run pnpm source:prepare again.`);
  }
  return manifest;
}
