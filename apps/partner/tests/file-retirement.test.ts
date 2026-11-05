import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, type StagedFiles } from '../runtime/store.ts';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cfl-retirement-'));
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
  const candidate = (await store.expiredFileReservations(Date.now() + 1000)).find(item => item.reservation.manifest.operationId === operationId)!;
  const files = [{ path, digest, size: 1, device: '1', inode: '2' }];
  return { operationId, ownerId, sessionId, manifest, staged, candidate, files, key };
}

test('one Store holds the private file journal owner lock until close', async () => {
  const f = await setup(); let closed = false;
  try {
    await f.store.expiredFileReservations(Date.now());
    assert.throws(() => new Store(f.path), /locked/i);
    await f.store.close(); closed = true;
    const reopened = new Store(f.path); await reopened.close();
  } finally { if (!closed) await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('unbound directory files cannot acquire image, file, failure or retry references', async () => {
  const f = await setup();
  try {
    const operationId = crypto.randomUUID(), key = crypto.randomUUID().replaceAll('-', ''), digest = 'a'.repeat(64), attachmentId = 'b'.repeat(64);
    const manifest = { operationId, sessionId: 'session', files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
    const path = `/test/.file-operations/${key}/p0-${digest}.file`;
    await f.store.reserveFiles(manifest, 'owner', key);
    const imageId = crypto.randomUUID();
    await assert.rejects(f.store.stageImages(imageId, 'session', 'hash', { images: [{ id: 'image', operation_id: imageId, name: 'image', media_type: 'image/png', path }], refs: [], variants: [] }), /different content/);
    const file = { id: attachmentId, operation_id: imageId, owner_id: 'owner', session_id: 'session', position: 0, name: 'f', media_type: '', size: 1, path };
    const ref = { attachmentId, name: 'f', mediaType: '', size: 1, availability: 'available' as const };
    await assert.rejects(f.store.stageFiles(imageId, 'owner', 'session', 'hash', { files: [file], refs: [ref] }), /different content/);
    await assert.rejects(f.store.failSubmission({ operationId: imageId, text: 'late', files: [ref] }, 'session', 'error'), /different content/);
    await assert.rejects(f.store.retryAttempt(imageId, 'session', operationId, true), /different content/);
  } finally { await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('retirement checks shared paths and retry/failure references atomically', async () => {
  const f = await setup();
  try {
    const shared = await complete(f.store);
    const aliased = { files: shared.staged.files.map(file => ({ ...file, id: 'd'.repeat(64), path: file.path.replace('/test/', '/test/../test/') })), refs: shared.staged.refs.map(ref => ({ ...ref, attachmentId: 'd'.repeat(64) })) };
    await f.store.stageFiles(crypto.randomUUID(), shared.ownerId, shared.sessionId, 'hash', aliased);
    assert.equal(await f.store.beginFileRetirement(shared.candidate, Date.now() + 1000), false);
    const retry = await complete(f.store);
    await f.store.retryAttempt(crypto.randomUUID(), retry.sessionId, retry.operationId, true);
    assert.equal(await f.store.beginFileRetirement(retry.candidate, Date.now() + 1000), false);
    const failed = await complete(f.store);
    await f.store.failSubmission({ operationId: failed.operationId, text: 'failed', files: failed.staged.refs }, failed.sessionId, 'error');
    await f.store.deleteFailed(failed.operationId, failed.sessionId);
    assert.equal(await f.store.beginFileRetirement(failed.candidate, Date.now() + 1000), false);
    const source = await complete(f.store);
    await f.store.failSubmission({ operationId: crypto.randomUUID(), text: 'replacement', replacementSourceIds: [source.operationId] }, source.sessionId, 'error');
    assert.equal(await f.store.beginFileRetirement(source.candidate, Date.now() + 1000), false);
    const imageReferenced = await complete(f.store), imageId = crypto.randomUUID();
    await f.store.stageImages(imageId, imageReferenced.sessionId, 'hash', { images: [{ id: 'image', operation_id: imageId, name: 'image', media_type: 'image/png', path: imageReferenced.files[0]!.path }], refs: [], variants: [] });
    assert.equal(await f.store.beginFileRetirement(imageReferenced.candidate, Date.now() + 1000), false);
  } finally { await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('image stage and admission serialize against mixed retirement and overlapping paths', async () => {
  const f = await setup();
  try {
    for (const retirementFirst of [false, true]) {
      const x = await complete(f.store);
      const image = { id: 'image', operation_id: x.operationId, name: 'image', media_type: 'image/png' as const, path: x.files[0]!.path };
      const stage = () => f.store.stageImages(x.operationId, x.sessionId, 'hash', { images: [image], refs: [], variants: [] });
      const retire = () => f.store.beginFileRetirement(x.candidate, Date.now() + 1000);
      const result = await Promise.allSettled(retirementFirst ? [retire(), stage()] : [stage(), retire()]);
      if (retirementFirst) { assert.equal((result[0] as PromiseFulfilledResult<boolean>).value, true); assert.equal(result[1]!.status, 'rejected'); }
      else { assert.equal(result[0]!.status, 'fulfilled'); assert.equal((result[1] as PromiseFulfilledResult<boolean>).value, false); }
    }
    for (const retirementFirst of [false, true]) {
      const x = await complete(f.store);
      const image = { id: 'image', operation_id: x.operationId, name: 'image', media_type: 'image/png' as const, path: `/images/${x.operationId}.png` };
      await f.store.stageImages(x.operationId, x.sessionId, 'hash', { images: [image], refs: [], variants: [] });
      const input = { operationId: x.operationId, text: 'message', files: x.staged.refs };
      const admit = () => f.store.admit(x.operationId, input.text, [image], { sessionId: x.sessionId, input }, undefined, undefined, { ownerId: x.ownerId, sessionId: x.sessionId, files: x.staged.files });
      const retire = () => f.store.beginFileRetirement(x.candidate, Date.now() + 1000);
      const result = await Promise.allSettled(retirementFirst ? [retire(), admit()] : [admit(), retire()]);
      if (retirementFirst) { assert.equal((result[0] as PromiseFulfilledResult<boolean>).value, true); assert.equal(result[1]!.status, 'rejected'); await assert.rejects(f.store.assertImageStageActive(x.operationId), /different content/); }
      else { assert.equal(result[0]!.status, 'fulfilled'); assert.equal((result[1] as PromiseFulfilledResult<boolean>).value, false); }
      assert.deepEqual((await f.store.stagedImages(x.operationId, x.sessionId))?.images, [image]);
    }
  } finally { await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('retirement fences late admission, failure, retry and shared path across reopen', async () => {
  const f = await setup(); let store = f.store;
  try {
    const x = await complete(store);
    assert.equal(await store.beginFileRetirement(x.candidate, Date.now() + 1000), true);
    assert.equal(await store.fileReservation(x.operationId, 'other', x.sessionId), undefined);
    await assert.rejects(store.reserveFiles({ ...x.manifest, sessionId: 'other-session' }, 'other', x.key), /not found/);
    await assert.rejects(store.fileReservation(x.operationId, x.ownerId, x.sessionId), /retired/);
    await assert.rejects(store.stageFiles(crypto.randomUUID(), x.ownerId, x.sessionId, 'hash', x.staged), /different content/);
    await assert.rejects(store.stageFiles(crypto.randomUUID(), x.ownerId, x.sessionId, 'hash', { ...x.staged, files: x.staged.files.map(file => ({ ...file, path: file.path.replace('/test/', '/test/../test/') })) }), /different content/);
    await assert.rejects(store.admit(x.operationId, 'late'), /different content/);
    await assert.rejects(store.ensureMessage(x.operationId, Date.now(), 'late'), /different content/);
    await assert.rejects(store.failSubmission({ operationId: x.operationId, text: 'late' }, x.sessionId, 'error'), /different content/);
    await assert.rejects(store.retryAttempt(crypto.randomUUID(), x.sessionId, x.operationId, true), /different content/);
    await store.close(); store = new Store(f.path);
    assert.deepEqual(await store.pendingFileRetirements(), [{ operationId: x.operationId, dirKey: x.key }]);
    assert.equal(await store.retirementSafe(x.operationId, x.key), true);
    await assert.rejects(store.failSubmission({ operationId: crypto.randomUUID(), text: 'late', files: x.staged.refs }, x.sessionId, 'error'), /different content/);
    await assert.rejects(store.failSubmission({ operationId: crypto.randomUUID(), text: 'late', replacementSourceIds: [x.operationId] }, x.sessionId, 'error'), /different content/);
    await store.finishFileRetirement(x.operationId, x.key);
    assert.deepEqual(await store.pendingFileRetirements(), []);
    await assert.rejects(store.stageFiles(crypto.randomUUID(), x.ownerId, x.sessionId, 'hash', x.staged), /different content/);
    await assert.rejects(store.failSubmission({ operationId: crypto.randomUUID(), text: 'late', files: x.staged.refs }, x.sessionId, 'error'), /different content/);
    await assert.rejects(store.reserveFiles(x.manifest, x.ownerId, x.key), /retired/);
    await assert.rejects(store.admit(x.operationId, 'late'), /different content/);
  } finally { await store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('the admission transaction and retirement fence serialize both winners', async () => {
  const f = await setup();
  try {
    for (const retirementFirst of [false, true]) {
      const x = await complete(f.store);
      const input = { operationId: x.operationId, text: 'message', files: x.staged.refs };
      const admit = () => f.store.admit(x.operationId, input.text, [], { sessionId: x.sessionId, input }, undefined, undefined, { ownerId: x.ownerId, sessionId: x.sessionId, files: x.staged.files });
      const retire = () => f.store.beginFileRetirement(x.candidate, Date.now() + 1000);
      const result = await Promise.allSettled(retirementFirst ? [retire(), admit()] : [admit(), retire()]);
      if (retirementFirst) { assert.equal(result[0]!.status, 'fulfilled'); assert.equal((result[0] as PromiseFulfilledResult<boolean>).value, true); assert.equal(result[1]!.status, 'rejected'); }
      else { assert.equal(result[0]!.status, 'fulfilled'); assert.equal(result[1]!.status, 'fulfilled'); assert.equal((result[1] as PromiseFulfilledResult<boolean>).value, false); }
    }
  } finally { await f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});
