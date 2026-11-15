import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vault } from '../runtime/vault.ts';
import { migrateVoiceSecrets } from '../runtime/vault-migration.ts';

const privateJson = (path: string, data: unknown) => writeFile(path, JSON.stringify(data), { mode: 0o600 });
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const tts = { provider: 'alibaba', voices: { alibaba: 'synthetic-voice' }, speeds: {}, keys: { alibaba: 'synthetic-override' } };
async function fixture() {
  const state = await mkdtemp(join(tmpdir(), 'cfl-secret-migration-'));
  await privateJson(join(state, 'voice-settings.json'), { region: 'beijing', apiKey: 'synthetic-input' });
  await privateJson(join(state, 'tts-settings.json'), tts);
  await privateJson(join(state, 'credentials.json'), { speech: 'synthetic-speech', tts: 'synthetic-tts', post: 'synthetic-post' });
  return state;
}

test('migrates independent fallbacks and TTS override, sanitizing only voice credentials', async () => {
  const state = await fixture();
  try {
    const vault = await Vault.open(state);
    await migrateVoiceSecrets(state, vault);
    assert.deepEqual(JSON.parse(vault.get('tts.settings')!), tts);
    assert.equal(vault.get('cli.speech'), 'synthetic-speech');
    assert.equal(vault.get('cli.tts'), 'synthetic-tts');
    assert.equal(JSON.parse(vault.get('legacy.voice-input')!).apiKey, 'synthetic-input');
    assert.deepEqual(await readJson(join(state, 'voice-settings.json')), { region: 'beijing' });
    assert.deepEqual(await readJson(join(state, 'tts-settings.json')), { ...tts, keys: {} });
    assert.deepEqual(await readJson(join(state, 'credentials.json')), { post: 'synthetic-post' });
    assert.equal(vault.get('migration.credentials-source'), undefined);
    assert.equal(vault.transaction(tx => tx.getMigration('voice-secrets-v1'))?.phase, 'complete');
    await migrateVoiceSecrets(state, vault);
    vault.close();
    const db = await readFile(join(state, 'vault.sqlite'));
    assert.equal(db.includes(Buffer.from('synthetic-speech')), false);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('resumes after each file replacement without resurrecting a cleared value', async () => {
  for (const point of ['voice', 'tts', 'credentials'] as const) {
    const state = await fixture();
    try {
      let vault = await Vault.open(state);
      vault.clear('cli.speech');
      await assert.rejects(migrateVoiceSecrets(state, vault, { fault(stage, kind) { if (stage === 'after-replace' && kind === point) throw new Error('simulated crash'); } }), /vault_migration_unavailable/);
      vault.close();
      vault = await Vault.open(state);
      await migrateVoiceSecrets(state, vault);
      assert.equal(vault.get('cli.speech'), undefined);
      assert.equal(vault.get('cli.tts'), 'synthetic-tts');
      assert.deepEqual(await readJson(join(state, 'credentials.json')), { post: 'synthetic-post' });
      vault.close();
    } finally { await rm(state, { recursive: true, force: true }); }
  }
});

test('refuses changed legacy secrets and unsafe files, retaining encrypted recovery data', async () => {
  const state = await fixture();
  try {
    const vault = await Vault.open(state);
    await assert.rejects(migrateVoiceSecrets(state, vault, { fault(stage) { if (stage === 'after-replace') throw new Error('interrupted'); } }));
    await privateJson(join(state, 'tts-settings.json'), { ...tts, keys: { alibaba: 'changed' } });
    await assert.rejects(migrateVoiceSecrets(state, vault), /vault_migration_unavailable/);
    assert.equal(JSON.parse(vault.get('migration.tts-source')!).keys.alibaba, 'synthetic-override');
    assert.equal((await readJson(join(state, 'tts-settings.json'))).keys.alibaba, 'changed');
    vault.close();
  } finally { await rm(state, { recursive: true, force: true }); }
  const unsafe = await fixture();
  try {
    const vault = await Vault.open(unsafe);
    await chmod(join(unsafe, 'tts-settings.json'), 0o644);
    await assert.rejects(migrateVoiceSecrets(unsafe, vault), /vault_migration_unavailable/);
    assert.equal(vault.get('tts.settings'), undefined);
    await rm(join(unsafe, 'tts-settings.json'));
    await symlink(join(unsafe, 'voice-settings.json'), join(unsafe, 'tts-settings.json'));
    await assert.rejects(migrateVoiceSecrets(unsafe, vault), /vault_migration_unavailable/);
    vault.close();
  } finally { await rm(unsafe, { recursive: true, force: true }); }
});

test('empty initial migration does not invent settings', async () => {
  const state = await mkdtemp(join(tmpdir(), 'cfl-empty-migration-'));
  try {
    const vault = await Vault.open(state);
    await migrateVoiceSecrets(state, vault);
    assert.equal(vault.get('tts.settings'), undefined);
    assert.equal(vault.get('cli.speech'), undefined);
    vault.close();
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('retry syncs the directory before completion after an interrupted rename', async () => {
  for (const point of ['voice', 'tts', 'credentials'] as const) {
    const state = await fixture();
    try {
      let vault = await Vault.open(state);
      await assert.rejects(migrateVoiceSecrets(state, vault, { fault(stage, kind) { if (stage === 'after-rename' && kind === point) throw new Error('synthetic directory sync failure'); } }), /vault_migration_unavailable/);
      assert.equal(vault.transaction(tx => tx.getMigration('voice-secrets-v1'))?.phase, 'cleaning');
      vault.close();
      vault = await Vault.open(state);
      let completionSyncAttempted = false;
      await assert.rejects(migrateVoiceSecrets(state, vault, { fault(stage) { if (stage === 'before-completion-sync') { completionSyncAttempted = true; throw new Error('synthetic directory sync failure'); } } }), /vault_migration_unavailable/);
      assert.equal(completionSyncAttempted, true);
      assert.equal(vault.transaction(tx => tx.getMigration('voice-secrets-v1'))?.phase, 'cleaning');
      vault.close();
      vault = await Vault.open(state);
      await migrateVoiceSecrets(state, vault);
      assert.equal(vault.transaction(tx => tx.getMigration('voice-secrets-v1'))?.phase, 'complete');
      assert.equal(vault.get('cli.speech'), 'synthetic-speech');
      vault.close();
    } finally { await rm(state, { recursive: true, force: true }); }
  }
});

test('existing input archive must match before the legacy source can be sanitized', async () => {
  for (const prior of ['different', 'deleted', 'matching'] as const) {
    const state = await fixture();
    try {
      const vault = await Vault.open(state);
      if (prior === 'deleted') vault.clear('legacy.voice-input');
      else vault.put('legacy.voice-input', JSON.stringify({ region: 'beijing', apiKey: prior === 'matching' ? 'synthetic-input' : 'different-input' }));
      if (prior === 'matching') {
        await migrateVoiceSecrets(state, vault);
        assert.deepEqual(await readJson(join(state, 'voice-settings.json')), { region: 'beijing' });
      } else {
        await assert.rejects(migrateVoiceSecrets(state, vault), /vault_migration_unavailable/);
        assert.deepEqual(await readJson(join(state, 'voice-settings.json')), { region: 'beijing', apiKey: 'synthetic-input' });
        assert.equal(vault.transaction(tx => tx.getMigration('voice-secrets-v1')), undefined);
        assert.equal(vault.get('migration.voice-source'), undefined);
      }
      vault.close();
    } finally { await rm(state, { recursive: true, force: true }); }
  }
});

test('migration resumes after import, file write or completion transaction failure', async () => {
  for (const point of ['after-import', 'before-file-sync', 'before-completion-commit'] as const) {
    const state = await fixture();
    try {
      let vault = await Vault.open(state);
      await assert.rejects(migrateVoiceSecrets(state, vault, { fault(stage) { if (stage === point) throw new Error('injected failure'); } }), /vault_migration_unavailable/);
      assert.notEqual(vault.transaction(tx => tx.getMigration('voice-secrets-v1'))?.phase, 'complete');
      assert.notEqual(vault.get('migration.voice-source'), undefined, 'staging survives transaction rollback');
      vault.close();
      vault = await Vault.open(state);
      await migrateVoiceSecrets(state, vault);
      assert.equal(vault.transaction(tx => tx.getMigration('voice-secrets-v1'))?.phase, 'complete');
      assert.equal(vault.get('cli.speech'), 'synthetic-speech');
      assert.deepEqual(await readJson(join(state, 'credentials.json')), { post: 'synthetic-post' });
      vault.close();
    } finally { await rm(state, { recursive: true, force: true }); }
  }
});
