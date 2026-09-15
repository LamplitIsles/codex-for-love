import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+)?$/u;

export function versionFromTag(tag) {
  if (!tag.startsWith('v') || !semver.test(tag.slice(1))) {
    throw new Error('Release tags must be v<semver>, for example v0.1.0 or v0.1.0-beta.1.');
  }
  return tag.slice(1);
}

export function npmDistTag(tag) {
  return versionFromTag(tag).includes('-') ? 'beta' : 'latest';
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function mainManifest(root) {
  return readJson(join(root, 'packages', 'codex-for-love', 'package.json'));
}

export function githubOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(versionFromTag(process.argv[2] ?? ''));
}
