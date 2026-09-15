import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = 'packages/codex-for-love';
const name = '@lamplitisles/codex-for-love';
const partnerRequire = createRequire(join(root, 'apps', 'partner', 'package.json'));
const { parse } = partnerRequire('smol-toml');
const temporary = await mkdtemp(join(tmpdir(), 'cfl-pack-check-'));
try {
  const path = join(root, directory);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: path, encoding: 'utf8' }))[0];
  const files = new Set(packed.files.map((file) => file.path));
  const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  if (manifest.repository?.type !== 'git' || manifest.repository?.url !== 'git+https://github.com/LamplitIsles/codex-for-love.git') throw new Error(`${name} repository must match the case-sensitive GitHub provenance identity LamplitIsles/codex-for-love.`);
  if (manifest.name !== name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) throw new Error(`${name} has an unexpected identity.`);
  if (['install', 'preinstall', 'postinstall'].some((key) => key in (manifest.scripts ?? {}))) throw new Error(`${name} ships an install hook.`);
  if ([...files].some((file) => file.includes('.git') || file.endsWith('.tgz'))) throw new Error(`${name} contains a source-control or nested archive file.`);
  for (const file of ['bin/codex-for-love.mjs', 'vendor/runtime/cli.mjs', 'vendor/runtime/companion-mcp.mjs', 'vendor/runtime/session-start-hook.mjs', 'vendor/build/index.html', 'vendor/ecosystem-mcp.example.toml', 'vendor/licenses/NotoSansSC-OFL-1.1.txt', 'vendor/licenses/jaminzhou-codex-app-server-client-MIT.txt', 'vendor/licenses/openai-codex-generated-Apache-2.0.txt']) if (!files.has(file)) throw new Error(`${name} omits ${file}.`);
  const ecosystemServers = parse(await readFile(join(path, 'vendor', 'ecosystem-mcp.example.toml'), 'utf8')).mcp_servers;
  if (Object.keys(ecosystemServers ?? {}).sort().join(',') !== 'flicknote,web') throw new Error(`${name} has an unexpected ecosystem MCP template.`);
  if (JSON.stringify(manifest).includes('github:')) throw new Error(`${name} exposes a Git dependency.`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.optionalDependencies?.['@lamplitisles/codex-for-love-linux-x64'] ?? '')) throw new Error(`${name} does not pin its native package exactly.`);
  console.log(`${name}: ${packed.size} bytes, ${files.size} files`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
