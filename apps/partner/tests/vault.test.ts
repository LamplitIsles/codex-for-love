import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Vault, type VaultTransaction } from '../runtime/vault.ts';
import { initializeVaultSchema } from '../runtime/vault-schema.ts';

async function workspace() { return mkdtemp(join(tmpdir(), 'cfl-vault-')); }

test('encrypted slots preserve scope, tombstones and atomic authorization', async () => {
  const state = await workspace();
  try {
    const vault = await Vault.open(state);
    vault.put('cli.speech', 'synthetic-alibaba-secret');
    vault.transaction(tx => { tx.put('tts.settings', '{"provider":"alibaba"}'); tx.put('bark.settings', '{"enabled":true}'); });
    assert.equal(vault.get('cli.speech'), 'synthetic-alibaba-secret');
    assert.throws(() => vault.transaction(tx => { tx.put('cli.speech', 'later'); tx.clear('tts.settings'); }, () => false), { code: 'vault_unauthorized' });
    assert.equal(vault.get('cli.speech'), 'synthetic-alibaba-secret');
    assert.equal(vault.get('tts.settings'), '{"provider":"alibaba"}');
    vault.clear('cli.speech');
    assert.equal(vault.transaction(tx => tx.putIfAbsent('cli.speech', 'obsolete')), false);
    assert.equal(vault.get('cli.speech'), undefined);
    assert.equal(vault.transaction(tx => tx.putIfAbsent('legacy.voice-input', '{"key":"old"}')), true);
    let escaped: VaultTransaction | undefined;
    vault.transaction(tx => { escaped = tx; });
    assert.throws(() => escaped!.put('cli.speech', 'late'), { code: 'vault_invalid_value' });
    assert.throws(() => vault.put('other' as never, 'no'), { code: 'vault_invalid_value' });
    vault.close();
    const dbBytes = await readFile(join(state, 'vault.sqlite'));
    assert.equal(dbBytes.includes(Buffer.from('synthetic-alibaba-secret')), false);
    assert.equal(dbBytes.includes(Buffer.from('{"key":"old"}')), false);
    const reopened = await Vault.open(state);
    assert.equal(reopened.get('legacy.voice-input'), '{"key":"old"}');
    reopened.close();
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('wrong, missing or damaged master key fails without replacing data; backup restores access', async () => {
  const state = await workspace();
  try {
    const keyPath = join(state, 'vault-key');
    const vault = await Vault.open(state);
    vault.put('cli.tts', 'synthetic-byte-secret'); vault.close();
    await rename(keyPath, `${keyPath}.backup`);
    await assert.rejects(Vault.open(state), { code: 'vault_unavailable' });
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    await assert.rejects(Vault.open(state), { code: 'vault_unavailable' });
    await rm(keyPath); await rename(`${keyPath}.backup`, keyPath);
    const restored = await Vault.open(state);
    assert.equal(restored.get('cli.tts'), 'synthetic-byte-secret'); restored.close();
    await writeFile(keyPath, Buffer.alloc(2));
    await assert.rejects(Vault.open(state), { code: 'vault_unavailable' });
    assert.equal((await readFile(keyPath)).length, 2);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('tampered or moved ciphertext fails closed and cannot be overwritten or cleared', async () => {
  const state = await workspace();
  try {
    const vault = await Vault.open(state);
    vault.put('cli.speech', 'alpha'); vault.put('cli.tts', 'bravo'); vault.close();
    const db = new DatabaseSync(join(state, 'vault.sqlite'));
    db.prepare("UPDATE vault_values SET nonce=(SELECT nonce FROM vault_values WHERE purpose='cli.speech'), ciphertext=(SELECT ciphertext FROM vault_values WHERE purpose='cli.speech'), tag=(SELECT tag FROM vault_values WHERE purpose='cli.speech') WHERE purpose='cli.tts'").run();
    db.close();
    const reopened = await Vault.open(state);
    assert.throws(() => reopened.get('cli.tts'), { code: 'vault_unavailable' });
    assert.throws(() => reopened.put('cli.tts', 'replacement'), { code: 'vault_unavailable' });
    assert.throws(() => reopened.clear('cli.tts'), { code: 'vault_unavailable' });
    assert.equal(reopened.get('cli.speech'), 'alpha'); reopened.close();
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('migration source slots are encrypted and bound to their individual purposes', async () => {
  const state = await workspace();
  const purposes = ['migration.voice-source', 'migration.tts-source', 'migration.credentials-source'] as const;
  try {
    const vault = await Vault.open(state);
    for (const [index, purpose] of purposes.entries()) vault.put(purpose, `synthetic-source-${index}`);
    vault.close();
    const db = new DatabaseSync(join(state, 'vault.sqlite'));
    const read = db.prepare('SELECT nonce,ciphertext,tag FROM vault_values WHERE owner_id=? AND purpose=?');
    const write = db.prepare('UPDATE vault_values SET nonce=?,ciphertext=?,tag=? WHERE owner_id=? AND purpose=?');
    const records = purposes.map(purpose => read.get('owner', purpose) as { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array });
    for (const [index, purpose] of purposes.entries()) {
      const other = purposes[(index + 1) % purposes.length]!;
      const original = records[(index + 1) % purposes.length]!;
      const source = records[index]!;
      write.run(source.nonce, source.ciphertext, source.tag, 'owner', other);
      const probe = await Vault.open(state);
      assert.equal(probe.get(purpose), `synthetic-source-${index}`);
      assert.throws(() => probe.get(other), { code: 'vault_unavailable' });
      probe.close();
      write.run(original.nonce, original.ciphertext, original.tag, 'owner', other);
    }
    db.close();
    const reopened = await Vault.open(state);
    for (const [index, purpose] of purposes.entries()) {
      assert.equal(reopened.get(purpose), `synthetic-source-${index}`);
      reopened.clear(purpose);
      assert.equal(reopened.transaction(tx => tx.putIfAbsent(purpose, 'obsolete')), false);
    }
    reopened.close();
    assert.equal((await readFile(join(state, 'vault.sqlite'))).includes(Buffer.from('synthetic-source-')), false);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('initialization resumes when the durable key exists before its metadata commit', async () => {
  const state = await workspace();
  try {
    // Match Vault.open's private creation mode regardless of the process umask.
    await writeFile(join(state, 'vault.sqlite'), '', { flag: 'wx', mode: 0o600 });
    const db = new DatabaseSync(join(state, 'vault.sqlite'));
    initializeVaultSchema(db); db.close();
    const key = randomBytes(32);
    await writeFile(join(state, 'vault-key'), key, { mode: 0o600 });
    await chmod(join(state, 'vault.sqlite'), 0o644);
    await assert.rejects(Vault.open(state), { code: 'vault_unavailable' });
    await chmod(join(state, 'vault.sqlite'), 0o600);
    const vault = await Vault.open(state);
    vault.put('cli.speech', 'kept'); vault.close();
    assert.deepEqual(await readFile(join(state, 'vault-key')), key);
    const reopened = await Vault.open(state); assert.equal(reopened.get('cli.speech'), 'kept'); reopened.close();
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('synthetic directory sync failures after key publication cannot bind metadata', async () => {
  const state = await workspace();
  const module = new URL('../runtime/vault.ts', import.meta.url).href;
  const source = `import { Vault } from ${JSON.stringify(module)};
    const [state, point, fail] = process.argv.slice(1);
    let observed = false;
    try {
      const vault = await Vault.open(state, { beforeDirectorySync(actual) {
        if (actual !== point) throw new Error('unexpected sync point');
        observed = true;
        if (fail === 'yes') throw new Error('synthetic directory sync failure');
      } });
      if (fail === 'yes') throw new Error('expected initialization failure');
      vault.put('cli.speech', 'synthetic-recovered-secret');
      vault.close();
    } catch (error) {
      if (fail !== 'yes' || error.code !== 'vault_unavailable') throw error;
    }
    if (!observed) throw new Error('directory sync point was skipped');`;
  const run = (point: string, fail: boolean) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, state, point, fail ? 'yes' : 'no'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
  });
  const assertUnbound = () => {
    const db = new DatabaseSync(join(state, 'vault.sqlite'), { readOnly: true });
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM vault_meta').get() as {n: number}).n, 0);
      assert.equal((db.prepare('SELECT count(*) AS n FROM vault_values').get() as {n: number}).n, 0);
    } finally { db.close(); }
  };
  try {
    // Each attempt runs in a fresh process; this injects failures and does not
    // simulate an actual power loss or prove filesystem hardware behavior.
    await run('key-published', true);
    const originalKey = await readFile(join(state, 'vault-key'));
    assertUnbound();
    await run('key-recovered', true);
    assert.deepEqual(await readFile(join(state, 'vault-key')), originalKey);
    assertUnbound();
    await run('key-recovered', false);
    assert.deepEqual(await readFile(join(state, 'vault-key')), originalKey);
    const reopened = await Vault.open(state);
    assert.equal(reopened.get('cli.speech'), 'synthetic-recovered-secret'); reopened.close();
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('unbound data and unsafe key paths are never silently initialized', async () => {
  const state = await workspace();
  try {
    const db = new DatabaseSync(join(state, 'vault.sqlite'));
    initializeVaultSchema(db);
    db.prepare('INSERT INTO vault_values VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)').run('owner', 'cli.speech', 'old', 1, 1);
    db.close();
    await assert.rejects(Vault.open(state), { code: 'vault_unavailable' });
    await assert.rejects(readFile(join(state, 'vault-key')), { code: 'ENOENT' });
  } finally { await rm(state, { recursive: true, force: true }); }
  const other = await workspace();
  try {
    const vault = await Vault.open(other); vault.close();
    const key = join(other, 'vault-key');
    await chmod(key, 0o644);
    await assert.rejects(Vault.open(other), { code: 'vault_unavailable' });
    await chmod(key, 0o600); await rename(key, `${key}.backup`);
    await symlink(`${key}.backup`, key);
    await assert.rejects(Vault.open(other), { code: 'vault_unavailable' });
  } finally { await rm(other, { recursive: true, force: true }); }
});

test('bounded migration markers commit with slots, roll back and survive restart', async () => {
  const state = await workspace();
  try {
    const vault = await Vault.open(state);
    const marker = Buffer.from('{"voice":"pending"}');
    assert.throws(() => vault.transaction(tx => {
      tx.putIfAbsent('legacy.voice-input', 'synthetic-old-input');
      tx.setMigration('voice-secrets-v1', { phase: 'imported', marker });
      throw new Error('injected failure');
    }), /injected failure/);
    assert.equal(vault.get('legacy.voice-input'), undefined);
    assert.equal(vault.transaction(tx => tx.getMigration('voice-secrets-v1')), undefined);
    vault.transaction(tx => {
      assert.equal(tx.putIfAbsent('legacy.voice-input', 'synthetic-old-input'), true);
      tx.setMigration('voice-secrets-v1', { phase: 'imported', marker });
    });
    assert.throws(() => vault.transaction(tx => {
      tx.setMigration('voice-secrets-v1', { phase: 'cleaning', marker: Buffer.from('next') });
      tx.clear('legacy.voice-input');
    }, () => false), { code: 'vault_unauthorized' });
    assert.throws(() => vault.transaction(tx => tx.setMigration('unknown' as never, { phase: 'imported', marker })), { code: 'vault_invalid_value' });
    assert.throws(() => vault.transaction(tx => tx.setMigration('voice-secrets-v1', { phase: 'other' as never, marker })), { code: 'vault_invalid_value' });
    assert.throws(() => vault.transaction(tx => tx.setMigration('voice-secrets-v1', { phase: 'cleaning', marker: Buffer.alloc(4097) })), { code: 'vault_invalid_value' });
    vault.close();
    const restarted = await Vault.open(state);
    assert.equal(restarted.get('legacy.voice-input'), 'synthetic-old-input');
    const saved = restarted.transaction(tx => tx.getMigration('voice-secrets-v1'));
    assert.equal(saved?.phase, 'imported'); assert.deepEqual(saved?.marker, new Uint8Array(marker));
    restarted.transaction(tx => tx.setMigration('voice-secrets-v1', { phase: 'complete', marker: Buffer.from('{}') }));
    assert.throws(() => restarted.transaction(tx => tx.setMigration('voice-secrets-v1', { phase: 'imported', marker })), { code: 'vault_invalid_value' });
    restarted.close();
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('independent processes share initialization and serialize read-modify-write transactions', async () => {
  const state = await workspace();
  try {
    const module = new URL('../runtime/vault.ts', import.meta.url).href;
    const source = `import { Vault } from ${JSON.stringify(module)};
      const v = await Vault.open(process.argv[1]);
      for (let i=0;i<20;i++) v.transaction(t => t.put('tts.settings', String(Number(t.get('tts.settings') ?? '0') + 1)));
      v.close();`;
    const child = () => new Promise<void>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', source, state], { stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; proc.stderr.on('data', chunk => { errors += chunk; });
      proc.once('error', reject); proc.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
    });
    await Promise.all([child(), child(), child()]);
    const vault = await Vault.open(state);
    assert.equal(vault.get('tts.settings'), '60'); vault.close();
  } finally { await rm(state, { recursive: true, force: true }); }
});
