import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';

test('the history index is additive, session scoped, and durable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-history-index-'));
  const path = join(directory, 'session.sqlite');
  const prefix = Buffer.alloc(32, 1);
  try {
    const original = new DatabaseSync(path);
    try {
      original.exec(`
        CREATE TABLE message_meta (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          created INTEGER NOT NULL,
          fingerprint TEXT
        );
        INSERT INTO message_meta(id,created) VALUES ('original-input',1);
      `);
    } finally { original.close(); }

    const store = new Store(path);
    try {
      assert.deepEqual((await store.allMessages()).map(({ id }) => id), ['original-input']);
    } finally { await store.close(); }

    let db = new DatabaseSync(path);
    try {
      const generation = db.prepare('INSERT INTO chat_history_generations(session_id,history_id) VALUES(?,?)');
      const entry = db.prepare('INSERT INTO chat_history_entries(session_id,ordinal,message_id,turn_id,prefix_hash) VALUES(?,?,?,?,?)');
      generation.run('session', 'history');
      generation.run('other-session', 'other-history');
      entry.run('session', 1, 'input', 'turn', prefix);
      entry.run('session', 2, 'answer', 'turn', prefix);
      entry.run('session', 3, 'outside-turn', null, prefix);
      entry.run('other-session', 1, 'input', 'turn', prefix);
      assert.throws(() => entry.run('session', 1, 'different', null, prefix), /UNIQUE/u);
      assert.throws(() => entry.run('session', 4, 'answer', null, prefix), /UNIQUE/u);
      assert.throws(() => entry.run('session', 4.5, 'invalid-ordinal', null, prefix), /CHECK/u);
      assert.throws(() => entry.run('session', 4, 'invalid-prefix', null, Buffer.alloc(31)), /CHECK/u);
      assert.throws(() => entry.run('unknown-session', 1, 'orphan', null, prefix), /FOREIGN KEY/u);
    } finally { db.close(); }

    const reopened = new Store(path);
    await reopened.close();
    db = new DatabaseSync(path);
    try {
      const entries = db.prepare('SELECT message_id,ordinal,prefix_hash FROM chat_history_entries WHERE session_id=? AND turn_id=? ORDER BY ordinal');
      assert.deepEqual(entries.all('session', 'turn').map(row => ({ ...row })), [
        { message_id: 'input', ordinal: 1, prefix_hash: new Uint8Array(prefix) },
        { message_id: 'answer', ordinal: 2, prefix_hash: new Uint8Array(prefix) },
      ]);

      const deleteGeneration = db.prepare('DELETE FROM chat_history_generations WHERE session_id=?');
      db.exec('BEGIN IMMEDIATE');
      deleteGeneration.run('session');
      assert.deepEqual(entries.all('session', 'turn'), []);
      db.exec('ROLLBACK');
      assert.equal(entries.all('session', 'turn').length, 2);

      db.exec('BEGIN IMMEDIATE');
      deleteGeneration.run('session');
      db.prepare('INSERT INTO chat_history_generations(session_id,history_id) VALUES(?,?)').run('session', 'new-history');
      db.exec('COMMIT');
      assert.equal(db.prepare('SELECT count(*) AS count FROM chat_history_entries WHERE session_id=?').get('session')?.count, 0);
      assert.equal(entries.all('other-session', 'turn').length, 1);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
