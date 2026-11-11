import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store, type FileManifest, type StagedFiles } from '../runtime/store.ts';

test('reservation and completion reject standalone durable submission identities, while allowing image staging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-operation-identity-'));
  const path = join(directory, 'session.sqlite');
  const make = (): FileManifest => ({ sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'file', name: 'file', mediaType: '', size: 0 }] });
  const key = (manifest: FileManifest) => manifest.operationId.replaceAll('-', '');
  const filePath = (manifest: FileManifest) => `/private/.file-operations/${key(manifest)}/p0-${'a'.repeat(64)}.file`;
  let store = new Store(path);
  try {
    const collisionAtReserve = [make()], collisionAtComplete = [make()], mixed = make();
    for (const manifest of collisionAtComplete) {
      await store.reserveFiles(manifest, 'owner', key(manifest));
      await store.recordFileUpload(manifest, 'owner', 'file', { digest: 'a'.repeat(64), path: filePath(manifest), attachmentId: 'b'.repeat(64) });
    }
    await store.stageImages(mixed.operationId, 'session', 'image-fingerprint', { images: [], refs: [], variants: [] });
    await store.reserveFiles(mixed, 'owner', key(mixed));
    await store.recordFileUpload(mixed, 'owner', 'file', { digest: 'a'.repeat(64), path: filePath(mixed), attachmentId: 'b'.repeat(64) });
    await store.close();
    const db = new DatabaseSync(path);
    try {
      for (const manifest of [...collisionAtReserve, ...collisionAtComplete]) db.prepare('INSERT INTO shared_submissions VALUES(?,?,?)').run(manifest.operationId, 'session', 'fingerprint');
    } finally { db.close(); }
    store = new Store(path);
    const payload = (manifest: FileManifest): StagedFiles => ({ files: [{ id: 'b'.repeat(64), operation_id: manifest.operationId, owner_id: 'owner', session_id: 'session', position: 0, name: 'file', media_type: '', size: 0, path: filePath(manifest) }], refs: [{ attachmentId: 'b'.repeat(64), name: 'file', mediaType: '', size: 0, availability: 'available' }] });
    for (const manifest of collisionAtReserve) await assert.rejects(store.reserveFiles(manifest, 'owner', key(manifest)), /different content/);
    for (const manifest of collisionAtComplete) {
      await assert.rejects(store.reserveFiles(manifest, 'owner', key(manifest)), /different content/);
      await assert.rejects(store.completeFileReservation(manifest, 'owner', payload(manifest)), /different content/);
      assert.equal(await store.stagedFiles(manifest.operationId, 'owner', 'session'), undefined);
    }
    assert.deepEqual(await store.completeFileReservation(mixed, 'owner', payload(mixed)), payload(mixed));
    assert.ok(await store.stagedImages(mixed.operationId, 'session'));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
