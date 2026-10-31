import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeAuthSchema } from '../runtime/auth-schema.ts';

test('initializing authentication storage again preserves the owner and active session', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeAuthSchema(db);
    const owner = db.prepare('SELECT credential_epoch, user_id FROM auth_metadata WHERE id = 1').get();
    assert.ok(owner);
    assert.equal(owner.credential_epoch, 0);
    assert.equal((owner.user_id as Uint8Array).length, 32);
    db.prepare('INSERT INTO auth_sessions(token_hash, expires_at) VALUES (?, ?)').run(Buffer.alloc(32, 1), 100);
    db.prepare('UPDATE auth_metadata SET credential_epoch = 1 WHERE id = 1').run();

    initializeAuthSchema(db);

    const after = db.prepare('SELECT credential_epoch, user_id FROM auth_metadata WHERE id = 1').get();
    assert.equal(after?.credential_epoch, 1);
    assert.deepEqual(after?.user_id, owner.user_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()?.count, 1);
  } finally {
    db.close();
  }
});
