import { execFileSync } from 'node:child_process';
import { cp, rm, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepared, verifyPrepared, hashes, cflIdentity } from './shared-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRequire = createRequire(import.meta.url);
const mainPackage = join(root, 'packages', 'codex-for-love');
const destination = process.argv[2];
if (!destination) throw new Error('Provide an absolute output directory for the verified main-package tarball.');
const output = resolve(destination);

const manifest = await verifyPrepared({ strict: process.argv.includes('--strict') });
const built = JSON.parse(await readFile(join(root, '.generated/build-source.json'), 'utf8'));
if (JSON.stringify(built) !== JSON.stringify(manifest) || JSON.stringify(await hashes(join(root, 'apps/partner/build'))) !== JSON.stringify(manifest.browser)) throw new Error('Build resources differ from prepared source; run pnpm build before packaging.');
manifest.cfl = cflIdentity();
await rm(join(mainPackage, 'vendor'), { recursive: true, force: true });
const vendor = join(mainPackage, 'vendor');
await Promise.all([
  cp(join(root, 'apps', 'partner', 'build'), join(vendor, 'build'), { recursive: true }),
  cp(join(root, 'apps', 'partner', 'config.example.toml'), join(vendor, 'config.example.toml')),
  cp(join(root, 'apps', 'partner', 'ecosystem-mcp.example.toml'), join(vendor, 'ecosystem-mcp.example.toml')),
  cp(join(root, 'apps', 'partner', 'persona.example.md'), join(vendor, 'persona.example.md')),
  cp(join(root, 'docs', 'IMPORTS.md'), join(vendor, 'IMPORTS.md')),
]);
const rolldownPackage = releaseRequire.resolve('rolldown/package.json');
const rolldownManifest = JSON.parse(await readFile(rolldownPackage, 'utf8'));
const rolldown = join(dirname(rolldownPackage), rolldownManifest.bin.rolldown);
for (const [entry, output] of [['cli.ts', 'cli.mjs'], ['companion-mcp.ts', 'companion-mcp.mjs']]) {
  execFileSync(process.execPath, [rolldown, join(root, 'apps', 'partner', 'runtime', entry), '--platform=node', '--format=esm', '--external', 'sharp', '--file', join(vendor, 'runtime', output)], { cwd: root, stdio: 'inherit' });
}
await cp(join(root, 'apps', 'partner', 'runtime', 'session-start-hook.mjs'), join(vendor, 'runtime', 'session-start-hook.mjs'));
await writeFile(join(vendor, 'package.json'), '{"type":"module"}\n');
await cp(join(root, 'LICENSE'), join(mainPackage, 'LICENSE'));
await cp(join(root, 'licenses'), join(vendor, 'licenses'), { recursive: true });
await cp(join(prepared, 'licenses'), join(vendor, 'licenses'), { recursive: true });
await writeFile(join(vendor, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
const packed = Object.values(JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: mainPackage, encoding: 'utf8' })))[0];
console.log(JSON.stringify({ artifact: join(output, packed.filename), mainPackage, version: packed.version }, null, 2));
