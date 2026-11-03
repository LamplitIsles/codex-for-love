import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';

test('timeline slot identities and positions remain scoped and durable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-timeline-schema-'));
  const path = join(directory, 'session.sqlite');
  try {
    const store = new Store(path);
    await store.close();
    let db = new DatabaseSync(path);
    try {
      const insert = db.prepare('INSERT INTO chat_timeline_slots(session_id,turn_id,item_id,kind,position) VALUES(?,?,?,?,?)');
      insert.run('session', 'turn', 'image', 'image', 0);
      insert.run('session', 'turn', 'steer', 'user', 1);
      insert.run('session', 'turn', 'voice', 'voice', 2);
      insert.run('session', 'other-turn', 'image', 'text', 0);
      insert.run('other-session', 'turn', 'image', 'image', 0);
      assert.throws(() => insert.run('session', 'turn', 'image', 'text', 3));
      assert.throws(() => insert.run('session', 'turn', 'other', 'text', 0));
      assert.throws(() => insert.run('session', 'turn', 'negative', 'text', -1));
      assert.throws(() => insert.run('session', 'turn', 'unknown', 'other', 4));
    } finally { db.close(); }

    const reopened = new Store(path);
    await reopened.close();
    db = new DatabaseSync(path);
    try {
      const rows = db.prepare('SELECT item_id,kind,position FROM chat_timeline_slots WHERE session_id=? AND turn_id=? ORDER BY position').all('session', 'turn');
      assert.deepEqual(rows.map(row => ({ ...row })), [
        { item_id: 'image', kind: 'image', position: 0 },
        { item_id: 'steer', kind: 'user', position: 1 },
        { item_id: 'voice', kind: 'voice', position: 2 },
      ]);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
