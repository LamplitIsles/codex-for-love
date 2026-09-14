import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadCredentials } from './config.ts';
import { convertDshSession } from './dsh-session-import.ts';
import { createPartner } from './partner.ts';
import { createWebServer } from './server.ts';

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
if (cliArgs[1] === '--') cliArgs.splice(1, 1);
const dryRun = cliArgs.includes('--dry-run');
const positionalArgs = cliArgs.filter((argument) => argument !== '--dry-run');
const [command, configPath, name, companionStatePath, attachmentRoot, destinationPath, dshSettingsPath] = positionalArgs;
if (!configPath) throw new Error('Usage: cli.ts <serve|credential|import-session> <config.toml> [speech|log destination]');
const config = await loadConfig(resolve(configPath));
if (command === 'credential') {
  if (name !== 'speech') throw new Error('Only the speech credential is managed by this runtime');
  if (process.stdin.isTTY) throw new Error('Supply the credential through stdin, not command arguments');
  let value = '';
  for await (const chunk of process.stdin) { value += chunk; if (value.length > 16384) throw new Error('Credential too large'); }
  value = value.trim(); if (!value) throw new Error('Credential is empty');
  await mkdir(config.state, { recursive: true, mode: 0o700 });
  const path = join(config.state, 'credentials.json');
  let previous: Record<string, string>;
  try { previous = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; previous = {}; }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...previous, [name]: value }), { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  console.log('Credential saved. Restart the runtime to apply it.');
} else if (command === 'serve') {
  const assets = fileURLToPath(new URL('../build/', import.meta.url));
  await access(join(assets, 'index.html'));
  const credentials = await loadCredentials(config.state);
  const partner = await createPartner(config, credentials);
  let app: ReturnType<typeof createWebServer>;
  try { app = createWebServer(partner, assets); }
  catch (error) { await partner.close(); throw error; }
  app.server.on('error', async (error) => { console.error(error.message); await partner.close(); process.exitCode = 1; });
  app.server.listen(config.port, '127.0.0.1', () => console.log(`Companion: http://127.0.0.1:${config.port}`));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else if (command === 'import-session') {
  if (!name || !companionStatePath || !attachmentRoot || !destinationPath) throw new Error('Usage: cli.ts import-session <config.toml> <session.jsonl[.zstd]> <state.jsonl> <attachments/v1> <new-workspace> [dsh-settings.yaml] [--dry-run]');
  const result = await convertDshSession(config, name, companionStatePath, attachmentRoot, destinationPath, {}, { dryRun, dshSettingsPath });
  console.log(JSON.stringify(result, null, 2));
} else throw new Error('Unknown command');
