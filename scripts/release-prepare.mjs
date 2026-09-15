import { execFileSync } from 'node:child_process';
import { cp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const partnerRequire = createRequire(join(root, 'apps', 'partner', 'package.json'));
const mainPackage = join(root, 'packages', 'codex-for-love');
const destination = process.argv[2];
if (!destination) throw new Error('Provide an absolute output directory for the verified main-package tarball.');
const output = resolve(destination);

execFileSync('corepack', ['pnpm', '--filter', '@lamplitisles/partner', 'build'], {
  cwd: root,
  env: { ...process.env, CI: 'true', npm_config_confirmModulesPurge: 'false' },
  stdio: 'inherit',
});
await rm(join(mainPackage, 'vendor'), { recursive: true, force: true });
const vendor = join(mainPackage, 'vendor');
await Promise.all([
  cp(join(root, 'apps', 'partner', 'build'), join(vendor, 'build'), { recursive: true }),
  cp(join(root, 'apps', 'partner', 'config.example.toml'), join(vendor, 'config.example.toml')),
  cp(join(root, 'apps', 'partner', 'ecosystem-mcp.example.toml'), join(vendor, 'ecosystem-mcp.example.toml')),
  cp(join(root, 'apps', 'partner', 'persona.example.md'), join(vendor, 'persona.example.md')),
  cp(join(root, 'docs', 'IMPORTS.md'), join(vendor, 'IMPORTS.md')),
]);
const rolldown = execFileSync('find', [join(root, 'node_modules', '.pnpm'), '-path', '*/node_modules/rolldown/bin/cli.mjs', '-print', '-quit'], { encoding: 'utf8' }).trim();
if (!rolldown) throw new Error('The pinned Vite/Rolldown bundler is unavailable; run pnpm install before release preparation.');
for (const [entry, output] of [['cli.ts', 'cli.mjs'], ['companion-mcp.ts', 'companion-mcp.mjs']]) {
  execFileSync(process.execPath, [rolldown, join(root, 'apps', 'partner', 'runtime', entry), '--platform=node', '--format=esm', '--file', join(vendor, 'runtime', output)], { cwd: root, stdio: 'inherit' });
}
await cp(join(root, 'apps', 'partner', 'runtime', 'session-start-hook.mjs'), join(vendor, 'runtime', 'session-start-hook.mjs'));
await writeFile(join(vendor, 'package.json'), '{"type":"module"}\n');
await cp(join(root, 'LICENSE'), join(mainPackage, 'LICENSE'));
await cp(join(root, 'licenses'), join(vendor, 'licenses'), { recursive: true });
await cp(join(dirname(partnerRequire.resolve('@fontsource/noto-sans-sc/package.json')), 'LICENSE'), join(vendor, 'licenses', 'NotoSansSC-OFL-1.1.txt'));
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: mainPackage, encoding: 'utf8' }))[0];
console.log(JSON.stringify({ artifact: join(output, packed.filename), mainPackage, version: packed.version }, null, 2));
