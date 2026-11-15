import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeVaultSchema } from '../runtime/vault-schema.ts';

test('vault schema initializes idempotently and enforces record identity and encrypted shape', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeVaultSchema(db);
    initializeVaultSchema(db);
    const insert = db.prepare('INSERT INTO vault_values VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('owner', 'bark', 'key-1', 1, 0, Buffer.alloc(12), Buffer.from('ciphertext'), Buffer.alloc(16));
    assert.throws(() => insert.run('owner', 'bark', 'key-1', 1, 0, Buffer.alloc(12), Buffer.from('ciphertext'), Buffer.alloc(16)));
    assert.throws(() => insert.run('owner', 'tts', 'key-1', 1, 0, Buffer.alloc(11), Buffer.from('ciphertext'), Buffer.alloc(16)));
    assert.throws(() => insert.run('owner', 'tts', 'key-1', 1, 0, null, Buffer.from('ciphertext'), null));
    assert.throws(() => insert.run('owner', 'tts', 'key-1', 1, 1, Buffer.alloc(12), Buffer.from('ciphertext'), Buffer.alloc(16)));
    insert.run('owner', 'tts', 'key-1', 1, 1, null, null, null);
    const notification = db.prepare('INSERT INTO notification_attempts VALUES (?, ?, ?)');
    notification.run('thread', 'turn', 1);
    assert.throws(() => notification.run('thread', 'turn', 2));
  } finally { db.close(); }
});

test('vault schema rejects unknown databases and versions without modifying them', () => {
  const foreign = new DatabaseSync(':memory:');
  const future = new DatabaseSync(':memory:');
  try {
    foreign.exec('CREATE TABLE unrelated (value TEXT)');
    assert.throws(() => initializeVaultSchema(foreign), /Unrecognized vault database/);
    assert.equal((foreign.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
    future.exec('PRAGMA user_version = 2');
    assert.throws(() => initializeVaultSchema(future), /Unsupported vault schema version/);
    assert.equal((future.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  } finally { foreign.close(); future.close(); }
});
