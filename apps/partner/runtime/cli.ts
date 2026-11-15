import { uploadPostAsset, savePostAsset } from './post-assets.ts';
import { StickerCatalog } from './sticker-catalog.ts';
import { readStickerDirectory } from './sticker-import.ts';
import { randomBytes } from 'node:crypto';
import { open, rename, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, loadCredentials } from './config.ts';
import { convertDshSession } from './dsh-session-import.ts';
import { createPartner } from './partner.ts';
import { createWebServer } from './server.ts';
import { createConversationSearch } from './conversation-search.ts';
import { migrateRelationshipJournal } from './migrate-relationship-journal.ts';
import { prepareFrontend } from './startup-frontend.ts';
import { AuthStore } from './auth.ts';
import { openMigratedVault } from './migrated-vault.ts';
import { acquirePrivateFileLock } from './private-file-lock.ts';

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
if (cliArgs[1] === '--') cliArgs.splice(1, 1);
const nativeRootIndex = cliArgs.indexOf('--native-package-root');
const nativePackageRoot = nativeRootIndex === -1 ? undefined : cliArgs[nativeRootIndex + 1];
if (nativeRootIndex !== -1) {
  if (!nativePackageRoot) throw new Error('--native-package-root requires a package root');
  cliArgs.splice(nativeRootIndex, 2);
}
if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  console.log('Usage: codex-for-love <serve|pair|credential|asset-fetch|asset-upload|import-session|import-stickers|migrate-relationship-journal> <config.toml>');
  process.exit(0);
}
const dryRun = cliArgs.includes('--dry-run');
const stdin = cliArgs.includes('--stdin');
const positionalArgs = cliArgs.filter((argument) => argument !== '--dry-run' && argument !== '--stdin');
const [command, configPath, name, companionStatePath, attachmentRoot, destinationPath, dshSettingsPath] = positionalArgs;
if (!configPath) throw new Error('Usage: cli.ts <serve|pair|credential|asset-fetch|asset-upload|import-session|import-stickers|migrate-relationship-journal> <config.toml>');
let config = await loadConfig(resolve(configPath));
if (nativePackageRoot) {
  const root = resolve(nativePackageRoot);
  config = {
    ...config,
    codex: {
      ...config.codex,
      command: join(root, 'bin', 'codex-app-server'),
    },
  };
}
if (command === 'import-stickers') {
  if (!name || companionStatePath) throw new Error('Usage: cli.ts import-stickers <config.toml> <directory>');
  const source = await readStickerDirectory(resolve(name));
  const catalog = await StickerCatalog.open(config.workspace!);
  try { const result = await catalog.importPack(source.manifest, source.files); console.log(JSON.stringify({ pack: await catalog.getPack(result.id), count: result.count })); }
  finally { catalog.close(); }
  process.exit(0);
}
if (command === 'asset-fetch' || command === 'asset-upload') {
  const credentials = await loadCredentials(config.state);
  if (!config.post || !credentials.post) throw new Error('Post is unavailable');
  try {
    if (command === 'asset-upload') {
      if (!name || !companionStatePath) throw new Error();
      console.log(JSON.stringify(await uploadPostAsset(config.post.endpoint,credentials.post,resolve(name),companionStatePath)));
    } else {
      if (!name || !companionStatePath || !attachmentRoot) throw new Error();
      await savePostAsset(config.post.endpoint,credentials.post,name,companionStatePath,resolve(attachmentRoot));
      console.log('Post asset saved');
    }
  } catch { throw new Error('Post asset transfer failed; use asset-upload <config> <file> <MIME> or asset-fetch <config> <asset-id> <MIME> <new-file>'); }
  process.exit(0);
}
if (command === 'pair') {
  const auth = new AuthStore(config.state, config.origin ?? `http://localhost:${config.port}`);
  try { await auth.initialize(); console.log(`Pairing code (valid for 10 minutes): ${auth.issuePairing()}`); }
  finally { auth.close(); }
} else if (command === 'credential') {
  if (name !== 'speech' && name !== 'tts' && name !== 'keet' && name !== 'keet_receiver' && name !== 'post' && name !== 'post_receiver') throw new Error('Credential name must be speech, tts, keet, keet_receiver, post, or post_receiver');
  if (!stdin) throw new Error('Use --stdin to supply the credential without exposing it in command arguments');
  if (process.stdin.isTTY) throw new Error('Supply the credential through stdin, not command arguments');
  let value = '';
  for await (const chunk of process.stdin) { value += chunk; if (value.length > 16384) throw new Error('Credential too large'); }
  value = value.trim(); if (!value) throw new Error('Credential is empty');
  const vault = await openMigratedVault(config.state);
  try {
    if (name === 'speech' || name === 'tts') vault.put(name === 'speech' ? 'cli.speech' : 'cli.tts', value);
    else {
      let lock: Awaited<ReturnType<typeof acquirePrivateFileLock>> = null;
      for (let i = 0; i < 500 && !lock; i++) { lock = await acquirePrivateFileLock(join(config.state, 'credentials.json.lock')); if (!lock) await new Promise(resolve => setTimeout(resolve, 10)); }
      if (!lock) throw new Error('Credentials unavailable');
      try {
        const { speech: _speech, tts: _tts, ...previous } = await loadCredentials(config.state);
        const path = join(config.state, 'credentials.json');
        const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify({ ...previous, [name]: value })); await file.sync(); } finally { await file.close(); }
          await rename(temporary, path);
          const directory = await open(config.state, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        } finally { await rm(temporary, { force: true }); }
      } finally { await lock.close(); }
    }
  } finally { vault.close(); }
  console.log('Credential saved. Restart the runtime to apply it.');
} else if (command === 'serve') {
  const assets = await prepareFrontend(config.frontend ?? 'latest', import.meta.url);
  await access(join(assets, 'index.html'));
  const credentials = await loadCredentials(config.state);
  if (credentials.keet_receiver && (credentials.keet_receiver === credentials.keet || credentials.keet_receiver === credentials.post || credentials.keet_receiver === credentials.post_receiver)) throw new Error('Keet receiver credential must differ from other integration credentials');
  if (config.keet?.endpoint && credentials.keet && !credentials.keet_receiver) throw new Error('Keet requires a separate keet_receiver credential');
  const auth = new AuthStore(config.state, config.origin ?? `http://localhost:${config.port}`);
  try { await auth.initialize(); } catch (error) { auth.close(); throw error; }
  let partner: Awaited<ReturnType<typeof createPartner>>;
  try { partner = await createPartner(config, credentials); } catch (error) { auth.close(); throw error; }
  let app: ReturnType<typeof createWebServer>;
  try { app = createWebServer(partner, assets, { auth, keetReceiver: credentials.keet_receiver, conversationSearch: createConversationSearch({ workspace: config.workspace! }) }); }
  catch (error) { auth.close(); await partner.close(); throw error; }
  app.server.on('error', async (error) => { console.error(error.message); await app.close(); process.exitCode = 1; });
  app.server.listen(config.port, config.listen_host, () => console.log(`Companion: ${auth.origin}`));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else if (command === 'import-session') {
  if (!name || !companionStatePath || !attachmentRoot || !destinationPath) throw new Error('Usage: cli.ts import-session <config.toml> <session.jsonl[.zstd]> <state.jsonl> <attachments/v1> <new-workspace> [dsh-settings.yaml] [--dry-run]');
  const result = await convertDshSession(config, name, companionStatePath, attachmentRoot, destinationPath, {}, { dryRun, dshSettingsPath });
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'migrate-relationship-journal') {
  console.log(JSON.stringify(await migrateRelationshipJournal(config.workspace!), null, 2));
} else throw new Error('Unknown command');
