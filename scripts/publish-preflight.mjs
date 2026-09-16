import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubOutput, mainManifest, npmDistTag, readJson, versionFromTag } from './release-shared.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nativePackage = '@lamplitisles/codex-for-love-linux-x64';
const nativePlatforms = [
  { name: nativePackage, os: 'linux', cpu: 'x64', identity: 'codex-artifact.json' },
  { name: '@lamplitisles/codex-for-love-darwin-arm64', os: 'darwin', cpu: 'arm64', identity: 'codex-artifact-darwin-arm64.json' },
];
const mainPackage = '@lamplitisles/codex-for-love';
const registry = 'https://registry.npmjs.org';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function registryDocument(name) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`npm registry lookup for ${name} failed: HTTP ${response.status}`);
  return response.json();
}

async function verifyNative(manifest, platform) {
  const nativePackage = platform.name;
  const version = manifest.optionalDependencies?.[nativePackage];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Main package must pin an exact ${nativePackage} version.`);
  }
  const document = await registryDocument(nativePackage);
  const published = document.versions?.[version];
  if (!published?.dist?.tarball) throw new Error(`${nativePackage}@${version} is not publicly available; publish and verify native bytes before a main release.`);
  const response = await fetch(published.dist.tarball, { cache: 'no-store', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download ${nativePackage}@${version}: HTTP ${response.status}`);
  const archive = await response.arrayBuffer();
  if (published.dist.integrity && integrity(Buffer.from(archive)) !== published.dist.integrity) throw new Error(`${nativePackage}@${version} download integrity differs from npm metadata.`);
  const temporary = await mkdtemp(join(tmpdir(), 'cfl-native-preflight-'));
  try {
    const tarball = join(temporary, 'native.tgz');
    await writeFile(tarball, Buffer.from(archive));
    const nativeManifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    if (nativeManifest.name !== nativePackage || nativeManifest.version !== version || nativeManifest.os?.join(',') !== platform.os || nativeManifest.cpu?.join(',') !== platform.cpu) throw new Error(`Published native package metadata is incompatible with ${nativePackage}.`);
    if (Object.keys(nativeManifest.scripts ?? {}).some((name) => /^(pre|post)?install$/u.test(name))) throw new Error('Published native package must not contain an install hook.');
    const expected = readJson(join(root, 'release', platform.identity));
    execFileSync('tar', ['-xzf', tarball, '-C', temporary, 'package/provenance.json', ...Object.keys(expected.executables).map((path) => `package/${path}`)]);
    const provenance = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/provenance.json'], { encoding: 'utf8' }));
    const { archiveSha256, ...identity } = expected;
    for (const [key, value] of Object.entries(identity)) {
      if (JSON.stringify(provenance[key]) !== JSON.stringify(value)) throw new Error(`Published native provenance mismatches ${key}.`);
    }
    for (const [path, hash] of Object.entries(expected.executables)) {
      const bytes = await readFile(join(temporary, 'package', path));
      if (sha256(bytes) !== hash) throw new Error(`Published native executable hash mismatches ${path}.`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`Verified ${nativePackage}@${version}: provenance and both executable hashes.`);
  return version;
}

const [tag, archive] = process.argv.slice(2);
if (!tag) throw new Error('Usage: publish-preflight.mjs <vsemver-tag> [verified-main-tarball]');
const version = versionFromTag(tag);
const channel = npmDistTag(tag);
const manifest = mainManifest(root);
if (manifest.name !== mainPackage) throw new Error('Main release manifest has the wrong package name.');
if (archive && manifest.version !== version) throw new Error(`Staged main manifest version ${manifest.version} does not match ${tag}.`);
const nativeVersions = {};
for (const platform of nativePlatforms) nativeVersions[platform.name] = await verifyNative(manifest, platform);
const nativeVersion = nativeVersions[nativePackage];
const document = await registryDocument(mainPackage);
const published = document.versions?.[version];
let skip = false;
let artifactIntegrity = '';
if (archive) {
  const bytes = await readFile(archive);
  artifactIntegrity = integrity(bytes);
  const packed = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
  if (packed.name !== mainPackage || packed.version !== version || nativePlatforms.some(({ name }) => packed.optionalDependencies?.[name] !== nativeVersions[name])) throw new Error('Verified main tarball does not preserve the staged release identity and native pins.');
  if (published) {
    if (published.dist?.integrity !== artifactIntegrity) throw new Error(`${mainPackage}@${version} already exists with different immutable bytes.`);
    skip = true;
  }
} else if (published) {
  console.log(`${mainPackage}@${version} already exists; its immutable tarball will be compared after packaging.`);
}
if (published && document['dist-tags']?.[channel] !== version) throw new Error(`${mainPackage}@${version} exists but is not selected by the ${channel} dist-tag.`);
githubOutput({ channel, skip, integrity: artifactIntegrity, native_version: nativeVersion });
console.log(JSON.stringify({ package: mainPackage, version, channel, nativeVersions, skip }, null, 2));
