import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      assert.throws(() => insert.run('oversized', 'op', 'owner', 'session', 2, 'invalid', '', 100000001, 'path'));
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


test('old file metadata migrates atomically without changing bytes or paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-migration-'));
  const path = join(directory, 'session.sqlite');
  try {
    const attachmentPath = join(directory, 'preserved-file');
    const bytes = Buffer.from([0, 1, 127, 255]);
    await writeFile(attachmentPath, bytes);
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE input_files (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 0 AND position < 6), name TEXT NOT NULL,
      media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0 AND size <= 8000000),
      path TEXT NOT NULL, UNIQUE(operation_id, position)
    ); CREATE INDEX input_files_session ON input_files(session_id);`);
    old.prepare('INSERT INTO input_files VALUES (?,?,?,?,?,?,?,?,?)').run('old-id','old-op','owner','session',0,'"old.bin"','"application/octet-stream"',8000000,attachmentPath);
    old.close();
    const store = new Store(path);
    await store.close();
    const db = new DatabaseSync(path);
    try {
      assert.deepEqual({ ...db.prepare('SELECT * FROM input_files WHERE id=?').get('old-id') }, {
        id: 'old-id', operation_id: 'old-op', owner_id: 'owner', session_id: 'session', position: 0,
        name: '"old.bin"', media_type: '"application/octet-stream"', size: 8000000, path: attachmentPath,
      });
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='input_files_session'").get());
      const insert = db.prepare('INSERT INTO input_files VALUES (?,?,?,?,?,?,?,?,?)');
      insert.run('new-id','new-op','owner','session',0,'"new.bin"','""',100000000,'new-path');
      assert.throws(() => insert.run('too-large','other-op','owner','session',0,'"x"','""',100000001,'path'));
      assert.throws(() => insert.run('duplicate','new-op','owner','session',0,'"x"','""',0,'path'));
    } finally { db.close(); }
    const reopened = new Store(path);
    await reopened.close();
    assert.deepEqual(await readFile(attachmentPath), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown legacy file schema is not rebuilt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-migration-unknown-'));
  const path = join(directory, 'session.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE input_files(id TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size >= 0 AND size <= 8000000), extra TEXT)');
    db.exec("INSERT INTO input_files VALUES('preserved',1,'custom')");
    db.close();
    assert.throws(() => new Store(path), /Unrecognized input_files schema/);
    const after = new DatabaseSync(path);
    try { assert.deepEqual({ ...after.prepare('SELECT * FROM input_files').get() }, { id: 'preserved', size: 1, extra: 'custom' }); }
    finally { after.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('custom constraints on a legacy file table are not discarded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-migration-custom-'));
  const path = join(directory, 'session.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE input_files (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 0 AND position < 6), name TEXT NOT NULL CHECK(length(name) <= 10),
      media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0 AND size <= 8000000),
      path TEXT NOT NULL, UNIQUE(operation_id, position)
    )`);
    db.close();
    assert.throws(() => new Store(path), /Unrecognized input_files schema/);
    const after = new DatabaseSync(path);
    try {
      assert.throws(() => after.prepare('INSERT INTO input_files VALUES (?,?,?,?,?,?,?,?,?)')
        .run('id','op','owner','session',0,'a'.repeat(11),'',0,'path'));
    } finally { after.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('stream reservation metadata is durable and rejects partial or conflicting upload records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-reservation-schema-'));
  const path = join(directory, 'session.sqlite');
  try {
    const store = new Store(path);
    await store.close();
    let db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const op = db.prepare('INSERT INTO file_upload_operations(operation_id,owner_id,session_id,manifest,status,created_at,updated_at,dir_key) VALUES (?,?,?,?,?,?,?,?)');
      op.run('op','owner','session','{}','uploading',10,10,'a'.repeat(32));
      assert.throws(() => op.run('op','another','session','{}','uploading',10,10,'b'.repeat(32)));
      assert.throws(() => op.run('bad','owner','session','{}','unknown',10,10,'b'.repeat(32)));
      const file = db.prepare('INSERT INTO file_upload_files VALUES (?,?,?,?,?,?,?,?,?,?)');
      file.run('op','file1',0,'"x"','""',100000000,null,null,null,null);
      assert.throws(() => file.run('op','file2',0,'"y"','""',0,null,null,null,null));
      assert.throws(() => file.run('op','file3',1,'"y"','""',100000001,null,null,null,null));
      assert.throws(() => file.run('missing','file1',0,'"y"','""',0,null,null,null,null));
      assert.throws(() => db.prepare('UPDATE file_upload_files SET digest=? WHERE file_id=?').run('a'.repeat(64),'file1'));
      assert.throws(() => db.prepare('UPDATE file_upload_files SET digest=?,path=?,attachment_id=?,uploaded_at=? WHERE file_id=?').run('z'.repeat(64),'path','a'.repeat(64),11,'file1'));
      db.prepare('UPDATE file_upload_files SET digest=?,path=?,attachment_id=?,uploaded_at=? WHERE file_id=?').run('b'.repeat(64),'published','a'.repeat(64),11,'file1');
    } finally { db.close(); }
    const reopened = new Store(path); await reopened.close();
    db = new DatabaseSync(path);
    try {
      const saved = db.prepare('SELECT digest,path,attachment_id,size FROM file_upload_files WHERE operation_id=? AND file_id=?').get('op','file1');
      assert.deepEqual({ ...saved }, { digest: 'b'.repeat(64), path: 'published', attachment_id: 'a'.repeat(64), size: 100000000 });
      db.exec('PRAGMA foreign_keys=ON');
      db.prepare('DELETE FROM file_upload_operations WHERE operation_id=?').run('op');
      assert.equal(db.prepare('SELECT count(*) AS count FROM file_upload_files').get()?.count, 0);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('upload directory key is unique, constrained and survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-directory-schema-'));
  const path = join(directory, 'session.sqlite');
  try {
    const store = new Store(path); await store.close();
    let db = new DatabaseSync(path);
    try {
      const insert = db.prepare('INSERT INTO file_upload_operations(operation_id,owner_id,session_id,manifest,status,created_at,updated_at,dir_key) VALUES(?,?,?,?,?,?,?,?)');
      insert.run('one','owner','session','{}','uploading',10,10,'a'.repeat(32));
      assert.throws(() => insert.run('missing','owner','session','{}','uploading',10,10,null));
      assert.throws(() => insert.run('duplicate','owner','session','{}','uploading',10,10,'a'.repeat(32)));
      assert.throws(() => insert.run('short','owner','session','{}','uploading',10,10,'a'.repeat(31)));
      assert.throws(() => insert.run('invalid','owner','session','{}','uploading',10,10,'z'.repeat(32)));
      db.prepare('INSERT INTO file_upload_retirements VALUES (?,?,?,?,?,?)').run('one','owner','session','expired_uploading','cleanup_pending',12);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='file_upload_operations_dir_key'").get());
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('file_upload_intents','file_upload_retirement_files')").get()?.count, 0);
    } finally { db.close(); }
    const reopened = new Store(path); await reopened.close();
    db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare('SELECT dir_key FROM file_upload_operations WHERE operation_id=?').get('one')?.dir_key, 'a'.repeat(32));
      assert.equal(db.prepare('SELECT state FROM file_upload_retirements WHERE operation_id=?').get('one')?.state, 'cleanup_pending');
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unreleased reservation schema is not migrated or deleted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-directory-migration-'));
  const path = join(directory, 'session.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE file_upload_operations (operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL, manifest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('uploading','complete')),
      created_at INTEGER NOT NULL CHECK(created_at >= 0), updated_at INTEGER NOT NULL CHECK(updated_at >= 0));
      INSERT INTO file_upload_operations VALUES('old','owner','session','{}','uploading',10,10);
      CREATE TABLE file_upload_intents (marker TEXT); INSERT INTO file_upload_intents VALUES('preserve');
      CREATE TABLE file_upload_retirement_files (marker TEXT); INSERT INTO file_upload_retirement_files VALUES('preserve');`);
    db.close();
    assert.throws(() => new Store(path), /Unrecognized file upload directory schema/);
    const after = new DatabaseSync(path);
    try {
      assert.deepEqual({ ...after.prepare('SELECT operation_id,status FROM file_upload_operations').get() }, { operation_id: 'old', status: 'uploading' });
      assert.equal(after.prepare('SELECT marker FROM file_upload_intents').get()?.marker, 'preserve');
      assert.equal(after.prepare('SELECT marker FROM file_upload_retirement_files').get()?.marker, 'preserve');
    } finally { after.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unrecognized directory key schema is not silently accepted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-file-directory-unknown-'));
  const path = join(directory, 'session.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE file_upload_operations (operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL, manifest TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dir_key INTEGER);
      INSERT INTO file_upload_operations VALUES('old','owner','session','{}','uploading',10,10,42);`);
    db.close();
    assert.throws(() => new Store(path), /Unrecognized file upload directory schema/);
    const after = new DatabaseSync(path);
    try { assert.equal(after.prepare('SELECT dir_key FROM file_upload_operations').get()?.dir_key, 42); }
    finally { after.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy recovery tables are not created and existing rows survive unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-legacy-recovery-schema-'));
  const legacyTables = ['failed_submissions', 'deleted_failures', 'retry_attempts'];
  const present = (db: DatabaseSync) => (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${legacyTables.map(() => '?').join(',')})`).all(...legacyTables) as Array<{ name: string }>).map(row => row.name).sort();
  try {
    const fresh = join(directory, 'fresh.sqlite');
    const store = new Store(fresh);
    await store.close();
    const created = new DatabaseSync(fresh);
    try {
      assert.deepEqual(present(created), []);
      assert.ok(created.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_meta'").get());
    } finally { created.close(); }

    const legacy = join(directory, 'legacy.sqlite');
    const payload = JSON.stringify({ operationId: 'legacy-op', text: '旧失败草稿 😀\r\nFiles (paths relative to workspace):\r\n[]', files: [{ attachmentId: 'a'.repeat(64), name: '旧.txt', mediaType: 'text/plain', size: 3, availability: 'available' }] });
    const old = new DatabaseSync(legacy);
    old.exec(`CREATE TABLE failed_submissions (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, error TEXT NOT NULL, replaced_by TEXT);
      CREATE TABLE deleted_failures (operation_id TEXT PRIMARY KEY);
      CREATE TABLE retry_attempts (attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_id TEXT NOT NULL, payload TEXT);`);
    old.prepare('INSERT INTO failed_submissions VALUES(?,?,?,?,?,?)').run('legacy-op', 'session', 'fingerprint', payload, 'definite failure', null);
    old.prepare('INSERT INTO deleted_failures VALUES(?)').run('legacy-discard');
    old.prepare('INSERT INTO retry_attempts VALUES(?,?,?,?)').run('legacy-attempt', 'session', 'legacy-op', null);
    old.close();

    const reopened = new Store(legacy);
    try {
      const messageId = crypto.randomUUID();
      assert.equal((await reopened.ensureMessage(messageId, Date.now(), 'a fresh message')).id, messageId);
      const operationId = crypto.randomUUID(), key = crypto.randomUUID().replaceAll('-', ''), digest = 'b'.repeat(64), attachmentId = 'c'.repeat(64);
      const manifest = { sessionId: 'session', operationId, files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
      const path = `/test/.file-operations/${key}/p0-${digest}.file`;
      const staged = { files: [{ id: attachmentId, operation_id: operationId, owner_id: 'owner', session_id: 'session', position: 0, name: 'f', media_type: '', size: 1, path }], refs: [{ attachmentId, name: 'f', mediaType: '', size: 1, availability: 'available' as const }] };
      await reopened.reserveFiles(manifest, 'owner', key);
      await reopened.recordFileUpload(manifest, 'owner', 'f', { digest, path, attachmentId });
      assert.deepEqual(await reopened.completeFileReservation(manifest, 'owner', staged), staged);
    } finally { await reopened.close(); }

    const after = new DatabaseSync(legacy);
    try {
      assert.deepEqual(present(after), [...legacyTables].sort());
      assert.deepEqual({ ...after.prepare('SELECT * FROM failed_submissions').get() }, { operation_id: 'legacy-op', session_id: 'session', fingerprint: 'fingerprint', payload, error: 'definite failure', replaced_by: null });
      assert.deepEqual({ ...after.prepare('SELECT * FROM retry_attempts').get() }, { attempt_id: 'legacy-attempt', session_id: 'session', source_id: 'legacy-op', payload: null });
      assert.deepEqual({ ...after.prepare('SELECT * FROM deleted_failures').get() }, { operation_id: 'legacy-discard' });
      assert.equal(after.prepare('SELECT count(*) AS count FROM message_meta').get()?.count, 1);
      assert.equal(after.prepare('SELECT count(*) AS count FROM staged_files').get()?.count, 1);
    } finally { after.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
