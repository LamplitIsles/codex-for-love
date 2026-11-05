import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store, type FileManifest, type StagedFiles } from '../runtime/store.ts';

const owner = 'owner', sessionId = 'session';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directory = () => randomUUID().replaceAll('-', '');
const manifest = (sizes: number[]): FileManifest => ({ sessionId, operationId: randomUUID(), files: sizes.map((size, index) => ({ id: `f${index}`, name: `file${index}`, mediaType: '', size })) });

async function sourceFailure(store: Store, sizes = [1, 2], fail = true) {
  const input = manifest(sizes), key = directory();
  await store.reserveFiles(input, owner, key);
  const files = input.files.map((file, position) => {
    const digest = hash(`digest${position}`), id = hash(`${input.operationId}:${position}`);
    return { id, operation_id: input.operationId, owner_id: owner, session_id: sessionId, position, name: file.name, media_type: file.mediaType, size: file.size, path: join('/fake/.file-operations', key, `p${position}-${digest}.file`), digest };
  });
  for (const [position, file] of files.entries()) await store.recordFileUpload(input, owner, input.files[position]!.id, { digest: file.digest, path: file.path, attachmentId: file.id });
  const staged: StagedFiles = { files: files.map(({ digest: _digest, ...file }) => file), refs: files.map(file => ({ attachmentId: file.id, name: file.name, mediaType: file.media_type, size: file.size, availability: 'available' as const })) };
  await store.completeFileReservation(input, owner, staged);
  if (fail) await store.failSubmission({ operationId: input.operationId, text: 'retry', files: staged.refs }, sessionId, 'failure');
  return { input, staged };
}

async function retry(store: Store, sourceId: string, staged: StagedFiles, state: 'created' | 'bound' | 'failed' | 'admitted') {
  const id = randomUUID();
  await store.retryAttempt(id, sessionId, sourceId, true);
  if (state === 'created') return { id, staged };
  const files = staged.files.map((file, index) => ({ ...file, id: hash(`${id}:${index}`), operation_id: id }));
  const refs = files.map(file => ({ attachmentId: file.id, name: file.name, mediaType: file.media_type, size: file.size, availability: 'available' as const }));
  const next = { files, refs }, submission = { operationId: id, text: 'retry', files: refs, replacementSourceIds: [sourceId] };
  await store.stageFiles(id, owner, sessionId, 'fake', next);
  await store.bindRetry(submission);
  if (state === 'failed') await store.failSubmission(submission, sessionId, 'failure');
  if (state === 'admitted') await store.admit(id, submission.text, [], { sessionId, input: submission }, undefined, undefined, { ownerId: owner, sessionId, files });
  return { id, staged: next };
}

async function fillCount(store: Store) {
  for (let index = 0; index < 15; index++) await store.reserveFiles(manifest([0]), owner, directory());
}
async function rejectedAtQuota(store: Store) {
  await assert.rejects(store.reserveFiles(manifest([0]), owner, directory()), /quota/);
}

for (const state of ['created', 'bound', 'failed'] as const) test(`retry ${state} without durable admission remains charged`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-quota-')); const store = new Store(join(root, 'store.sqlite'));
  try {
    const source = await sourceFailure(store); await fillCount(store);
    await retry(store, source.input.operationId, source.staged, state);
    await rejectedAtQuota(store);
    assert.deepEqual(await store.stagedFiles(source.input.operationId, owner, sessionId), source.staged);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('independent history references release quota without resolving an unknown retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-quota-')), path = join(root, 'store.sqlite'); let store = new Store(path);
  try {
    const source = await sourceFailure(store); await fillCount(store);
    const accepted = await retry(store, source.input.operationId, source.staged, 'admitted');
    const unknown = randomUUID(); await store.retryAttempt(unknown, sessionId, source.input.operationId, true);
    await store.close();
    const db = new DatabaseSync(path), second = randomUUID();
    try {
      db.prepare('INSERT INTO message_meta(id,created) VALUES(?,?)').run(second, Date.now());
      db.prepare('INSERT INTO shared_submissions(operation_id,session_id,fingerprint) VALUES(?,?,?)').run(second, sessionId, 'fake');
      db.prepare('UPDATE input_files SET operation_id=? WHERE operation_id=? AND position=1').run(second, accepted.id);
      db.prepare('DELETE FROM retry_attempts WHERE attempt_id=?').run(accepted.id);
    } finally { db.close(); }
    store = new Store(path);
    await store.reserveFiles(manifest([0]), owner, directory());
    assert.equal((await store.retryBinding(unknown, sessionId))?.input, null);
    assert.equal(await store.messageMeta(unknown), undefined);
    assert.deepEqual(await store.stagedFiles(source.input.operationId, owner, sessionId), source.staged);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('directly admitted files free their reservation quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-quota-')); const store = new Store(join(root, 'store.sqlite'));
  try {
    const source = await sourceFailure(store, [1, 2], false); await fillCount(store);
    const submission = { operationId: source.input.operationId, text: 'retry', files: source.staged.refs };
    await store.admit(source.input.operationId, submission.text, [], { sessionId, input: submission }, undefined, undefined, { ownerId: owner, sessionId, files: source.staged.files });
    await store.reserveFiles(manifest([0]), owner, directory());
    assert.deepEqual((await store.inputFiles(source.input.operationId, owner, sessionId)).map(file => file.path), source.staged.files.map(file => file.path));
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('unrelated same-ID message metadata alone does not release quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-quota-')); const store = new Store(join(root, 'store.sqlite'));
  try {
    const source = await sourceFailure(store, [1, 2], false); await fillCount(store);
    await store.ensureMessage(source.input.operationId, Date.now(), 'independent message');
    await rejectedAtQuota(store);
    assert.deepEqual(await store.stagedFiles(source.input.operationId, owner, sessionId), source.staged);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('multi-file shared paths release byte quota after explicit retry, including a prior failed attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-quota-')); const store = new Store(join(root, 'store.sqlite'));
  try {
    const source = await sourceFailure(store, [100_000_000, 100_000_000]);
    for (let index = 0; index < 3; index++) await store.reserveFiles(manifest([100_000_000, 100_000_000]), owner, directory());
    await assert.rejects(store.reserveFiles(manifest([1]), owner, directory()), /quota/);
    const failed = await retry(store, source.input.operationId, source.staged, 'failed');
    await assert.rejects(store.reserveFiles(manifest([1]), owner, directory()), /quota/);
    const admitted = await retry(store, failed.id, failed.staged, 'admitted');
    await store.reserveFiles(manifest([1]), owner, directory());
    assert.deepEqual(admitted.staged.files.map(file => file.path), source.staged.files.map(file => file.path));
    assert.deepEqual(await store.stagedFiles(source.input.operationId, owner, sessionId), source.staged);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

const corruptions: Array<[string, (db: DatabaseSync, sourceId: string, attemptId: string) => void]> = [
  ['missing admitted file', (db, _source, attempt) => { db.prepare('DELETE FROM input_files WHERE operation_id=? AND position=1').run(attempt); }],
  ['different shared path', (db, _source, attempt) => { db.prepare("UPDATE input_files SET path='/fake/unrelated' WHERE operation_id=? AND position=1").run(attempt); }],
  ['different file owner', (db, _source, attempt) => { db.prepare("UPDATE input_files SET owner_id='other' WHERE operation_id=? AND position=1").run(attempt); }],
  ['different file session', (db, _source, attempt) => { db.prepare("UPDATE input_files SET session_id='other' WHERE operation_id=? AND position=1").run(attempt); }],
  ['missing admission record', (db, _source, attempt) => { db.prepare('DELETE FROM shared_submissions WHERE operation_id=?').run(attempt); }],
  ['missing message metadata', (db, _source, attempt) => { db.prepare('DELETE FROM message_meta WHERE id=?').run(attempt); }],
  ['different admitted file position', (db, _source, attempt) => { db.prepare('UPDATE input_files SET position=2 WHERE operation_id=? AND position=1').run(attempt); }],
  ['different admitted file size', (db, _source, attempt) => { db.prepare('UPDATE input_files SET size=3 WHERE operation_id=? AND position=1').run(attempt); }],
  ['missing source file', (db, source) => { db.prepare('DELETE FROM file_upload_files WHERE operation_id=? AND position=1').run(source); }],
  ['inconsistent source metadata', (db, source) => { db.prepare('UPDATE file_upload_files SET size=3 WHERE operation_id=? AND position=1').run(source); }],
  ['unbound source file', (db, source) => { db.prepare('UPDATE file_upload_files SET digest=NULL,path=NULL,attachment_id=NULL,uploaded_at=NULL WHERE operation_id=? AND position=1').run(source); }],
  ['unfinished retirement', (db, source) => { db.prepare("INSERT INTO file_upload_retirements(operation_id,owner_id,session_id,reason,state,retired_at) VALUES(?, 'owner','session','abandoned_complete','cleanup_pending',0)").run(source); }],
];
for (const [label, corrupt] of corruptions) test(`incomplete retry evidence stays charged: ${label}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-quota-')), path = join(root, 'store.sqlite'); let store = new Store(path);
  try {
    const source = await sourceFailure(store); await fillCount(store);
    const attempt = await retry(store, source.input.operationId, source.staged, 'admitted');
    await store.close();
    const db = new DatabaseSync(path); try { corrupt(db, source.input.operationId, attempt.id); } finally { db.close(); }
    store = new Store(path); await rejectedAtQuota(store);
    assert.deepEqual(await store.stagedFiles(source.input.operationId, owner, sessionId), source.staged);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
