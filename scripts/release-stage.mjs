import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { versionFromTag } from './release-shared.mjs';

const [directory, tag] = process.argv.slice(2);
if (!directory || !tag) throw new Error('Usage: release-stage.mjs <disposable-source-directory> <vsemver-tag>');
const root = resolve(directory);
const version = versionFromTag(tag);
const manifestPath = join(root, 'packages', 'codex-for-love', 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.name !== '@lamplitisles/codex-for-love') throw new Error('Disposable release manifest has the wrong package name.');
manifest.version = version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ root, version, nativeVersion: manifest.optionalDependencies?.['@lamplitisles/codex-for-love-linux-x64'] }, null, 2));
