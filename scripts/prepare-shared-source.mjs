import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { root, source, prepared, readPin, identity, cflIdentity, requirePinned, hashes } from './shared-source.mjs';

const pin = await readPin();
const app = identity();
if (process.argv.includes('--strict')) requirePinned(app, pin);
const packageJson = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (packageJson.packageManager !== 'bun@1.3.14' || execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim() !== '1.3.14') throw new Error('App preparation requires pinned Bun 1.3.14.');
for (const args of [['install', '--frozen-lockfile'], ['run', '--cwd', 'apps/web', 'paraglide-js', 'compile', '--project', './project.inlang', '--outdir', './src/lib/paraglide', '--emit-ts-declarations', '--strategy', 'globalVariable', 'preferredLanguage', 'baseLocale', '--silent'], ['run', 'check'], ['run', 'build'], ['run', 'test']]) execFileSync('bun', args, { cwd: source, stdio: 'inherit' });
if (JSON.stringify(identity()) !== JSON.stringify(app)) throw new Error('App source changed during preparation.');
const contracts = JSON.parse(await readFile(join(source, 'packages/contracts/package.json'), 'utf8'));
for (const exported of Object.values(contracts.exports)) for (const path of Object.values(exported)) {
  try { await readFile(join(source, 'packages/contracts', path)); }
  catch { throw new Error(`Compiled public contracts missing: ${path}; App build must complete before CFL installation.`); }
}
await rm(prepared, { recursive: true, force: true });
await mkdir(prepared, { recursive: true });
await cp(join(source, 'apps/web/build'), join(prepared, 'browser'), { recursive: true });
await mkdir(join(prepared, 'contracts'));
for (const path of ['package.json', 'dist', 'LICENSE']) await cp(join(source, 'packages/contracts', path), join(prepared, 'contracts', path), { recursive: true });
await mkdir(join(prepared, 'licenses'));
for (const [path, name] of [['LICENSE', 'lamplit-app-Apache-2.0.txt'], ['docs/IMPORTS.md', 'lamplit-app-IMPORTS.md']]) await cp(join(source, path), join(prepared, 'licenses', name));
const appRequire = createRequire(join(source, 'apps/web/package.json'));
await cp(join(dirname(appRequire.resolve('@fontsource/noto-sans-sc/package.json')), 'LICENSE'), join(prepared, 'licenses', 'NotoSansSC-OFL-1.1.txt'));
const manifest = { pin, app, cfl: cflIdentity(), browser: await hashes(join(prepared, 'browser')), contracts: await hashes(join(prepared, 'contracts')), licenses: await hashes(join(prepared, 'licenses')) };
await writeFile(join(prepared, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared App ${app.sha}${app.dirty ? ' (local edits)' : ''} and public contracts.`);
