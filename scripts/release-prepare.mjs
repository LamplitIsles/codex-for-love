import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepared, verifyPrepared, cflIdentity } from './shared-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRequire = createRequire(import.meta.url);
const mainPackage = join(root, 'packages', 'codex-for-love');
const destination = process.argv[2];
if (!destination) throw new Error('Provide an absolute output directory for the verified main-package tarball.');
const output = resolve(destination);

const manifest = await verifyPrepared({ strict: process.argv.includes('--strict') });
const built = JSON.parse(await readFile(join(root, '.generated/build-source.json'), 'utf8'));
if (JSON.stringify(built) !== JSON.stringify(manifest)) throw new Error('Build resources differ from prepared source; run pnpm build before packaging.');
manifest.cfl = cflIdentity();
await rm(join(mainPackage, 'vendor'), { recursive: true, force: true });
const vendor = join(mainPackage, 'vendor');
await Promise.all([
  cp(join(root, 'apps', 'partner', 'config.example.toml'), join(vendor, 'config.example.toml')),
  cp(join(root, 'apps', 'partner', 'ecosystem-mcp.example.toml'), join(vendor, 'ecosystem-mcp.example.toml')),
  cp(join(root, 'apps', 'partner', 'persona.example.md'), join(vendor, 'persona.example.md')),
  cp(join(root, 'docs', 'IMPORTS.md'), join(vendor, 'IMPORTS.md')),
]);
const rolldownPackage = releaseRequire.resolve('rolldown/package.json');
const rolldownManifest = JSON.parse(await readFile(rolldownPackage, 'utf8'));
const rolldown = join(dirname(rolldownPackage), rolldownManifest.bin.rolldown);
for (const [entry, output] of [['cli.ts', 'cli.mjs'], ['companion-mcp.ts', 'companion-mcp.mjs']]) {
  execFileSync(process.execPath, [rolldown, join(root, 'apps', 'partner', 'runtime', entry), '--platform=node', '--format=esm', '--no-codeSplitting', '--external', 'sharp', '--external', 'koffi', '--file', join(vendor, 'runtime', output)], { cwd: root, stdio: 'inherit' });
}
await cp(join(root, 'apps', 'partner', 'runtime', 'session-start-hook.mjs'), join(vendor, 'runtime', 'session-start-hook.mjs'));
await writeFile(join(vendor, 'package.json'), '{"type":"module"}\n');
await cp(join(root, 'LICENSE'), join(mainPackage, 'LICENSE'));
await cp(join(root, 'licenses'), join(vendor, 'licenses'), { recursive: true });
await cp(join(prepared, 'licenses'), join(vendor, 'licenses'), { recursive: true });
// Retain notices for bundled authentication and contract dependencies.
const visited = new Set();
async function copyDependencyLicenses(name, parent, category = 'auth') {
  const entry = createRequire(parent).resolve(name);
  let directory = dirname(entry), info;
  for (;;) {
    try { info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (info.name === name) break; } catch {}
    const next = dirname(directory);
    if (next === directory) throw new Error(`Cannot locate package metadata for ${name}`);
    directory = next;
  }
  const key = `${info.name}@${info.version}`;
  const visitKey = `${category}:${key}`;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);
  const names = (await readdir(directory)).filter(file => /^(license|licence|copying|notice)(\.|$)/iu.test(file));
  // tr46 0.0.3 declares MIT but its original npm tarball and tag omit a license file.
  if (!names.length && category === 'elevenlabs' && key === 'tr46@0.0.3') {
    const destination = join(vendor, 'licenses', category, key);
    await mkdir(destination, { recursive: true });
    await cp(join(root, 'licenses/tr46-0.0.3-MIT.txt'), join(destination, 'LICENSE'));
    return;
  }
  if (!names.length) throw new Error(`Missing license notice for ${key}`);
  const destination = join(vendor, 'licenses', category, key.replaceAll('/', '__'));
  await mkdir(destination, { recursive: true });
  await Promise.all(names.map(file => cp(join(directory, file), join(destination, file), { recursive: true })));
  for (const dependency of Object.keys(info.dependencies ?? {})) await copyDependencyLicenses(dependency, join(directory, 'package.json'), category);
}
for (const name of ['better-auth', '@better-auth/passkey', '@better-auth/oauth-provider']) {
  await copyDependencyLicenses(name, join(root, 'apps/partner/package.json'));
}
await copyDependencyLicenses('typebox', join(prepared, 'contracts/package.json'), 'contracts');
await copyDependencyLicenses('marked', join(prepared, 'contracts/package.json'), 'contracts');
await copyDependencyLicenses('@elevenlabs/elevenlabs-js', join(root, 'apps/partner/package.json'), 'elevenlabs');
for (const name of ['ajv', 'ws']) {
  await copyDependencyLicenses(name, join(root, 'packages/codex-app-server-client/package.json'), 'codex-sdk');
}
await writeFile(join(vendor, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
const packed = Object.values(JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: mainPackage, encoding: 'utf8' })))[0];
console.log(JSON.stringify({ artifact: join(output, packed.filename), mainPackage, version: packed.version }, null, 2));
