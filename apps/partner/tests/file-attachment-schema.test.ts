import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';

test('file staging and message metadata enforce ordering and survive reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-schema-'));
  const path = join(directory, 'session.sqlite');
  try {
    const store = new Store(path);
    await store.close();
    let db = new DatabaseSync(path);
    try {
      db.prepare('INSERT INTO staged_files VALUES (?,?,?,?,?)').run('op', 'owner', 'session', 'hash', '{}');
      const insert = db.prepare('INSERT INTO input_files(id,operation_id,owner_id,session_id,position,name,media_type,size,path) VALUES(?,?,?,?,?,?,?,?,?)');
      insert.run('first', 'op', 'owner', 'session', 0, 'empty', '', 0, 'first-path');
      insert.run('second', 'op', 'owner', 'session', 1, 'document', 'application/octet-stream', 10, 'second-path');
      assert.throws(() => insert.run('duplicate', 'op', 'owner', 'session', 1, 'same position', '', 0, 'path'));
      assert.throws(() => insert.run('negative', 'op', 'owner', 'session', -1, 'invalid', '', 0, 'path'));
      assert.throws(() => insert.run('oversized', 'op', 'owner', 'session', 2, 'invalid', '', 8000001, 'path'));
    } finally { db.close(); }
    const reopened = new Store(path);
    await reopened.close();
    db = new DatabaseSync(path);
    try {
      const rows = db.prepare('SELECT id,position,name,size FROM input_files WHERE operation_id=? ORDER BY position').all('op');
      assert.deepEqual(rows.map(row => ({ ...row })), [
        { id: 'first', position: 0, name: 'empty', size: 0 },
        { id: 'second', position: 1, name: 'document', size: 10 },
      ]);
      assert.equal(db.prepare('SELECT owner_id FROM staged_files WHERE operation_id=?').get('op')?.owner_id, 'owner');
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
