import { execFileSync } from 'node:child_process';
import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const registry = 'https://forgejo.n5.guion.io/api/packages/LamplitIsles/npm/';
const name = '@lamplitisles/codex-for-love';
const manifestPath = 'packages/codex-for-love/package.json';
const shaPattern = /^[a-f0-9]{40}$/u;

export function snapshotVersion(base, sha) {
  if (!shaPattern.test(sha) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(base)) throw new Error('Invalid snapshot base version or commit SHA');
  return `${base}${base.includes('-') ? '.' : '-'}snapshot.g${sha}`;
}

export function snapshotManifest(manifest, sha) {
  if (manifest.name !== name) throw new Error('Unexpected snapshot package name');
  return { ...manifest, version: snapshotVersion(manifest.version, sha), publishConfig: { access: 'public', tag: 'latest', registry } };
}

// Only inspect the locally built package that the build and smoke have already verified.
export async function verifySnapshotArtifact(artifact, manifest, sha) {
  const readEntry = path => JSON.parse(execFileSync('tar', ['-xOzf', artifact, path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  const packaged = readEntry('package/package.json');
  const source = readEntry('package/vendor/source.json');
  if (!manifest.version.endsWith(`.snapshot.g${sha}`) && !manifest.version.endsWith(`-snapshot.g${sha}`)) throw new Error('Snapshot manifest does not match the commit');
  deepStrictEqual(packaged, manifest, 'Packed manifest differs from the staged manifest');
  if (source.cfl?.sha !== sha) throw new Error('Packed source revision differs from the commit');
}

export function registryDecision(metadata, version, integrity, sha, isAncestor) {
  const latest = metadata?.['dist-tags']?.latest;
  if (metadata && Object.keys(metadata.versions ?? {}).length && latest === undefined) throw new Error('Registry has versions but no latest tag; inspect before publishing');
  if (latest !== undefined) {
    const match = typeof latest === 'string' && /(?:-|\.)snapshot\.g([a-f0-9]{40})$/u.exec(latest);
    if (!match || !isAncestor(match[1], sha)) throw new Error('Registry latest is not a verified ancestor; inspect before publishing');
  }
  const existing = metadata?.versions?.[version];
  if (existing) {
    if (existing.dist?.integrity !== integrity) throw new Error('Snapshot version already exists with different integrity');
    if (latest !== version) throw new Error('Snapshot exists but is not latest; inspect registry before promotion');
    return 'skip';
  }
  return 'publish';
}

function verifyCheckout(sha) {
  if (!shaPattern.test(sha)) throw new Error('CI_COMMIT_SHA must be a full lowercase commit SHA');
  let head;
  try { head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('Cannot determine checked-out HEAD'); }
  if (head !== sha) throw new Error(`Checked-out HEAD ${head} does not match CI_COMMIT_SHA ${sha}`);
}

async function main() {
  const [action, artifact] = process.argv.slice(2);
  const sha = process.env.CI_COMMIT_SHA ?? '';
  verifyCheckout(sha);
  if (action === 'verify-head') { console.log(`Verified checkout ${sha}`); return; }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== name) throw new Error('Unexpected snapshot package name');
  if (action === 'stage' || action === 'stage-to') {
    const staged = snapshotManifest(manifest, sha);
    if (action === 'stage-to' && !artifact) throw new Error('Provide a destination for the staged manifest');
    await writeFile(action === 'stage' ? manifestPath : artifact, `${JSON.stringify(staged, null, 2)}\n`, action === 'stage-to' ? { flag: 'wx' } : undefined);
    console.log(`Staged ${name}@${staged.version}`);
    return;
  }
  if (action !== 'publish' || !artifact || !process.env.FORGEJO_PACKAGES_TOKEN || !shaPattern.test(sha) || !manifest.version.endsWith(`.snapshot.g${sha}`) && !manifest.version.endsWith(`-snapshot.g${sha}`)) throw new Error('Missing artifact, token, or matching snapshot identity');
  await verifySnapshotArtifact(artifact, manifest, sha);
  const integrity = `sha512-${createHash('sha512').update(await readFile(artifact)).digest('base64')}`;
  let response;
  try {
    const auth = await fetch('https://forgejo.n5.guion.io/api/v1/user', { headers: { Authorization: `Bearer ${process.env.FORGEJO_PACKAGES_TOKEN}` }, signal: AbortSignal.timeout(30000) });
    if (!auth.ok) throw new Error('Authentication failed');
    response = await fetch(`${registry}${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${process.env.FORGEJO_PACKAGES_TOKEN}` }, signal: AbortSignal.timeout(30000) });
  } catch { throw new Error('Cannot verify snapshot registry; inspect before retrying'); }
  if (!response.ok && response.status !== 404) throw new Error(`Cannot verify snapshot registry (HTTP ${response.status})`);
  const metadata = response.status === 404 ? null : await response.json();
  const decision = registryDecision(metadata, manifest.version, integrity, sha, (older, newer) => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', older, newer], { stdio: 'ignore' }); return true; } catch { return false; }
  });
  if (decision === 'skip') { console.log(`Existing snapshot ${manifest.version} has matching integrity and latest tag`); return; }
  try { execFileSync('npm', ['publish', artifact, '--registry', registry, '--tag', 'latest'], { stdio: 'ignore' }); }
  catch { throw new Error('Snapshot publication failed or outcome is unknown; inspect the registry before retrying'); }
  console.log(`Published snapshot ${manifest.version}; integrity ${integrity}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
