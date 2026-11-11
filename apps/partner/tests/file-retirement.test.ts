import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, type StagedFiles } from '../runtime/store.ts';
import type { DatabaseSync } from 'node:sqlite';

// Historical rows only: retirement is never written now, but identities that
// were already retired must keep their fence.
function rawDb(store: Store) { return (store as unknown as { db: DatabaseSync }).db; }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cfl-retention-'));
  const path = join(dir, 'session.sqlite');
  const store = new Store(path);
  return { dir, path, store };
}

async function complete(store: Store) {
  const operationId = crypto.randomUUID(), ownerId = 'owner', sessionId = 'session';
  const manifest = { operationId, sessionId, files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
  const digest = 'a'.repeat(64), attachmentId = operationId.replaceAll('-', '').repeat(2), key = crypto.randomUUID().replaceAll('-', ''), path = `/test/.file-operations/${key}/p0-${digest}.file`;
  const file = { id: attachmentId, operation_id: operationId, owner_id: ownerId, session_id: sessionId, position: 0, name: 'f', media_type: '', size: 1, path };
  const staged: StagedFiles = { files: [file], refs: [{ attachmentId, name: 'f', mediaType: '', size: 1, availability: 'available' }] };
  await store.reserveFiles(manifest, ownerId, key);
  await store.recordFileUpload(manifest, ownerId, 'f', { digest, path, attachmentId });
  await store.completeFileReservation(manifest, ownerId, staged);
  return { operationId, ownerId, sessionId, manifest, staged, key, path };
}

test('one Store holds the private file journal owner lock until close', async () => {
  const f = await setup(); let closed = false;
  try {
    assert.equal(await f.store.fileReservation(crypto.randomUUID(), 'owner', 'session'), undefined);
    assert.throws(() => new Store(f.path), /locked/i);
    await f.store.close(); closed = true;
    const reopened = new Store(f.path); await reopened.close();
  } finally { if (!closed) await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('unbound directory files cannot acquire image or file references', async () => {
  const f = await setup();
  try {
    const operationId = crypto.randomUUID(), key = crypto.randomUUID().replaceAll('-', ''), digest = 'a'.repeat(64), attachmentId = 'b'.repeat(64);
    const manifest = { operationId, sessionId: 'session', files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
    const path = `/test/.file-operations/${key}/p0-${digest}.file`;
    await f.store.reserveFiles(manifest, 'owner', key);
    const aliasId = crypto.randomUUID();
    await assert.rejects(f.store.stageImages(aliasId, 'session', 'hash', { images: [{ id: 'image', operation_id: aliasId, name: 'image', media_type: 'image/png', path }], refs: [], variants: [] }), /different content/);
    const file = { id: attachmentId, operation_id: aliasId, owner_id: 'owner', session_id: 'session', position: 0, name: 'f', media_type: '', size: 1, path };
    const ref = { attachmentId, name: 'f', mediaType: '', size: 1, availability: 'available' as const };
    await assert.rejects(f.store.stageFiles(aliasId, 'owner', 'session', 'hash', { files: [file], refs: [ref] }), /different content/);
  } finally { await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

for (const state of ['retired', 'cleanup_pending'] as const) test(`a historical ${state} operation keeps its identity and path fence`, async () => {
  const f = await setup();
  try {
    const x = await complete(f.store);
    rawDb(f.store).prepare('INSERT INTO file_upload_retirements(operation_id,owner_id,session_id,reason,state,retired_at) VALUES(?,?,?,?,?,?)').run(x.operationId, x.ownerId, x.sessionId, 'abandoned_complete', state, Date.now());
    await assert.rejects(f.store.fileReservation(x.operationId, x.ownerId, x.sessionId), /File operation retired/);
    assert.equal(await f.store.fileReservation(x.operationId, 'other-owner', x.sessionId), undefined);
    await assert.rejects(f.store.reserveFiles({ ...x.manifest, operationId: x.operationId }, x.ownerId, x.key), /retired/);
    await assert.rejects(f.store.reserveFiles({ ...x.manifest, operationId: x.operationId }, 'other-owner', crypto.randomUUID().replaceAll('-', '')), /not found/);
    await assert.rejects(f.store.stageFiles(crypto.randomUUID(), x.ownerId, x.sessionId, 'hash', x.staged), /different content/);
    await assert.rejects(f.store.stageImages(crypto.randomUUID(), x.sessionId, 'hash', { images: [{ id: 'image', operation_id: crypto.randomUUID(), name: 'image', media_type: 'image/png', path: x.path }], refs: [], variants: [] }), /different content/);
    await assert.rejects(f.store.admit(x.operationId, 'late'), /different content/);
    await assert.rejects(f.store.ensureMessage(x.operationId, Date.now(), 'late'), /different content/);
    await assert.rejects(f.store.reserveNativeDelivery({ operationId: x.operationId, text: 'late' }, x.sessionId, x.ownerId), /different content/);
    assert.equal(rawDb(f.store).prepare('SELECT count(*) AS count FROM file_upload_retirements').get()?.count, 1);
  } finally { await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('abandoned staging is never retired and keeps its recorded state', async () => {
  const f = await setup();
  try {
    const x = await complete(f.store);
    assert.deepEqual(await f.store.stagedFiles(x.operationId, x.ownerId, x.sessionId), x.staged);
    const reservation = await f.store.fileReservation(x.operationId, x.ownerId, x.sessionId);
    assert.equal(reservation?.status, 'complete');
    assert.deepEqual(reservation?.staged, x.staged);
    assert.deepEqual((await f.store.reserveFiles(x.manifest, x.ownerId, x.key)).staged, x.staged);
    assert.equal((await f.store.fileReservation(x.operationId, x.ownerId, x.sessionId))?.status, 'complete');
    assert.equal(rawDb(f.store).prepare('SELECT count(*) AS count FROM file_upload_retirements').get()?.count, 0);
  } finally { await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});
