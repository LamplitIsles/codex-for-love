// Apply only the manifest staged by the Git-verified caller, after checks complete.
import { deepStrictEqual } from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { snapshotManifest } from './snapshot-publish.mjs';

const [stagedPath, sha] = process.argv.slice(2);
if (!stagedPath) throw new Error('Provide the staged manifest and full CFL commit SHA');
const path = 'packages/codex-for-love/package.json';
const original = JSON.parse(await readFile(path, 'utf8'));
const staged = JSON.parse(await readFile(stagedPath, 'utf8'));
deepStrictEqual(staged, snapshotManifest(original, sha), 'Staged manifest differs from the Git-verified source');
await writeFile(path, `${JSON.stringify(staged, null, 2)}\n`);
