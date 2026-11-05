import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';
import { createFileOperations } from '../runtime/file-operations.ts';
import { retryStoredFiles } from '../runtime/files.ts';

const owner = { ownerId: 'owner', sessionId: 'session' }, guard = { check: async () => {}, commit: () => {} };
const make = () => ({ sessionId: owner.sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] });
const bytes = async function* () { yield Buffer.from('x'); };

test('repeated expiry scans progress past shared paths without deleting referenced files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-expiry-progress-')), attachments = join(root, 'workspace', '.lamplit', 'attachments');
  await mkdir(attachments, { recursive: true, mode: 0o700 });
  const store = new Store(join(root, 'session.sqlite')), ops = createFileOperations(store, attachments), realNow = Date.now;
  try {
    const protectedFiles: Array<{ operationId: string; path: string }> = [];
    for (let index = 0; index < 33; index++) {
      const source = make(); await ops.reserve(source, owner, guard); await ops.receive(source.operationId, 'f', bytes(), owner, guard); await ops.complete(source.operationId, owner, guard);
      const original = (await store.stagedFiles(source.operationId, owner.ownerId, owner.sessionId))!;
      const aliasId = crypto.randomUUID(), alias = await retryStoredFiles(original.files, aliasId, attachments);
      await store.stageFiles(aliasId, owner.ownerId, owner.sessionId, 'hash', alias);
      const input = { operationId: aliasId, text: 'historical reference', files: alias.refs };
      await store.admit(aliasId, input.text, [], { sessionId: owner.sessionId, input }, undefined, undefined, { ...owner, files: alias.files });
      protectedFiles.push({ operationId: source.operationId, path: original.files[0]!.path });
    }
    const idle: string[] = [];
    for (let index = 0; index < 16; index++) {
      const source = make(); idle.push(source.operationId); await ops.reserve(source, owner, guard); await ops.receive(source.operationId, 'f', bytes(), owner, guard); await ops.complete(source.operationId, owner, guard);
    }
    await assert.rejects(ops.reserve(make(), owner, guard), /quota/);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await assert.rejects(ops.reserve(make(), owner, guard), /quota/);
    await ops.reserve(make(), owner, guard);
    for (const id of idle) await assert.rejects(ops.status(id, owner), /retired/);
    for (const file of protectedFiles) { assert.ok((await ops.status(file.operationId, owner))?.result); assert.equal(await readFile(file.path, 'utf8'), 'x'); }
  } finally { Date.now = realNow; await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('expiry scan wraps to reservations that become old after the cursor passes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-expiry-wrap-')), store = new Store(join(root, 'session.sqlite'));
  const realNow = Date.now, base = realNow();
  try {
    const recent = make(), older = make();
    Date.now = () => base + 1000;
    await store.reserveFiles(recent, owner.ownerId, crypto.randomUUID().replaceAll('-', ''));
    Date.now = () => base;
    await store.reserveFiles(older, owner.ownerId, crypto.randomUUID().replaceAll('-', ''));
    assert.deepEqual((await store.expiredFileReservations(base + 500)).map(candidate => candidate.reservation.manifest.operationId), [older.operationId]);
    assert.ok((await store.expiredFileReservations(base + 1500)).some(candidate => candidate.reservation.manifest.operationId === recent.operationId));
  } finally { Date.now = realNow; await store.close(); await rm(root, { recursive: true, force: true }); }
});
