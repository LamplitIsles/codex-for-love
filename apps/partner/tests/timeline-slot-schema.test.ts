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

test('legacy timeline slots migrate atomically without losing positions or constraints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-timeline-ui-'));
  const path = join(directory, 'session.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE chat_timeline_slots (
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('user','text','image','voice')),
      position INTEGER NOT NULL CHECK(position >= 0),
      PRIMARY KEY(session_id,turn_id,item_id), UNIQUE(session_id,turn_id,position)
    );
    INSERT INTO chat_timeline_slots VALUES ('s','t','old','voice',3);
    CREATE INDEX timeline_test_kind ON chat_timeline_slots(kind);`);
    db.close();
    const store = new Store(path);
    assert.deepEqual(await store.timelineSlots('s', 't'), [{ itemId: 'old', kind: 'voice', position: 3 }]);
    await store.recordTimelineSlot('s', 't', 'new', 'ui');
    assert.deepEqual(await store.timelineSlots('s', 't'), [{ itemId: 'old', kind: 'voice', position: 3 }, { itemId: 'new', kind: 'ui', position: 4 }]);
    await assert.rejects(store.recordTimelineSlot('s', 't', 'old', 'ui'));
    await store.close();
    const reopened = new Store(path);
    assert.equal((await reopened.timelineSlots('s', 't'))[1]?.kind, 'ui');
    await reopened.close();
    const check = new DatabaseSync(path);
    assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='timeline_test_kind'").get());
    assert.throws(() => check.prepare('INSERT INTO chat_timeline_slots VALUES (?,?,?,?,?)').run('s', 't', 'bad', 'other', 5));
    check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unrecognized timeline schemas are retained rather than rebuilt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-timeline-ui-unknown-'));
  const path = join(directory, 'session.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE chat_timeline_slots (session_id TEXT, extra TEXT); INSERT INTO chat_timeline_slots VALUES ('preserved','value')");
    db.close();
    assert.throws(() => new Store(path), /Unrecognized chat_timeline_slots schema/u);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare('SELECT extra FROM chat_timeline_slots').get()?.extra, 'value');
    check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
