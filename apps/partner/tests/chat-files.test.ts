import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { readTestFile, stageTestFiles } from './file-fixture.ts';
import { fixtureImage } from './panels-seed.ts';

test('streamed files stay scoped, survive history and restart, and reach native as untrusted paths', async () => {
  const f = await fixture(); await f.holdProvider(true); let partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    const data = Buffer.from([0, 255, 10]);
    const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'file', name: '../untrusted', mediaType: '', bytes: data }]);
    const ref = staged.files[0]!.ref;
    assert.equal(await readTestFile(partner, ref.attachmentId, { ownerId: 'other', sessionId }), null);
    assert.equal(await readTestFile(partner, ref.attachmentId, { ownerId: 'owner', sessionId: 'other' }), null);
    assert.equal((await partner.submitShared({ operationId, text: 'file', files: [ref] })).state, 'submitted');
    await eventually(async () => (await f.requests()).some(item => item.method === 'turn/start' && (item.params as { clientUserMessageId?: string }).clientUserMessageId === operationId));
    const request = (await f.requests()).find(item => item.method === 'turn/start' && (item.params as { clientUserMessageId?: string }).clientUserMessageId === operationId)!;
    const context = (request.params as { additionalContext: Record<string, { kind: string; value: string }> }).additionalContext['codex-for-love.file-0']!;
    const metadata = JSON.parse(context.value) as { path: string; name: string };
    assert.equal(context.kind, 'untrusted'); assert.equal(metadata.name, '../untrusted');
    assert.equal(isAbsolute(metadata.path), false);
    assert.match(metadata.path, /^\.lamplit\/attachments\/\.file-operations\/[a-f0-9]{32}\/p0-[a-f0-9]{64}\.file$/u);
    assert.deepEqual(await readFile(join(f.workspace, metadata.path)), data);
    assert.deepEqual((await createCodexChatBackend(partner).read()).messages.find(message => message.operationId === operationId)?.files, [ref]);
    await partner.close(); partner = await f.createPartner();
    assert.deepEqual((await createCodexChatBackend(partner).read()).messages.find(message => message.operationId === operationId)?.files, [ref]);
    assert.deepEqual(await readTestFile(partner, ref.attachmentId, owner), data);
  } finally { await partner.close(); await f.close(); }
});

test('explicit failed retry reuses streamed bytes while unknown admission is never replayed', async () => {
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    const data = Buffer.from([0, 255, 10, 42]);
    const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'file', name: 'retry.bin', mediaType: '', bytes: data }]);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations');
    const directory = join(root, (await readdir(root))[0]!);
    const sourcePath = join(directory, (await readdir(directory)).find(name => name.startsWith('p0-'))!);
    const submission = { operationId, text: 'retry', files: staged.files.map(item => item.ref) };
    assert.equal((await partner.finalizeSubmission({ sessionId, submission }))?.state, 'failed');
    assert.equal((await partner.submitShared(submission)).state, 'failed');
    assert.ok(!(await f.requests()).some(item => item.method === 'turn/start' && (item.params as { clientUserMessageId?: string }).clientUserMessageId === operationId));
    const attemptId = crypto.randomUUID(), result = await partner.retryFailed({ sessionId, operationId, attemptId });
    assert.equal(result.state, 'submitted'); assert.equal(result.retryFiles?.files[0]?.sourceAttachmentId, staged.files[0]!.ref.attachmentId);
    assert.deepEqual(await readTestFile(partner, result.retryFiles!.files[0]!.ref.attachmentId, owner), data);
    await eventually(async () => (await f.requests()).some(item => item.method === 'turn/start' && (item.params as { clientUserMessageId?: string }).clientUserMessageId === attemptId));
    const request = (await f.requests()).find(item => item.method === 'turn/start' && (item.params as { clientUserMessageId?: string }).clientUserMessageId === attemptId)!;
    const context = (request.params as { additionalContext: Record<string, { kind: string; value: string }> }).additionalContext['codex-for-love.file-0']!;
    const metadata = JSON.parse(context.value) as { path: string; operationId: string };
    assert.equal(context.kind, 'untrusted'); assert.equal(metadata.operationId, attemptId);
    assert.equal(metadata.path, relative(f.workspace, sourcePath));
    assert.deepEqual(await readFile(join(f.workspace, metadata.path)), data);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'new', mediaType: '', size: 0 }] }, owner, async () => true, () => true);
    assert.deepEqual(await readTestFile(partner, staged.files[0]!.ref.attachmentId, owner), data);
    assert.deepEqual(await readTestFile(partner, result.retryFiles!.files[0]!.ref.attachmentId, owner), data);
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('an admitted mixed retry frees its source reservation quota without deleting shared files or images', async () => {
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const data = [Buffer.from('first'), Buffer.from('second')];
    const staged = await stageTestFiles(partner, sessionId, operationId, data.map((bytes, index) => ({ id: `f${index}`, name: `file${index}`, mediaType: '', bytes })));
    const image = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: Buffer.from([255, 216, 255, 217]).toString('base64'), model: Buffer.from([255, 216, 255, 217]).toString('base64') }] });
    const make = () => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'empty', mediaType: '', size: 0 }] });
    for (let index = 0; index < 15; index++) await partner.fileOperationReserve(make(), owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationReserve(make(), owner, async () => true, () => true), /quota/);
    const submission = { operationId, text: 'retry', files: staged.files.map(item => item.ref), images: image.images.map(item => item.ref) };
    assert.equal((await partner.finalizeSubmission({ sessionId, submission }))?.state, 'failed');
    const result = await partner.retryFailed({ sessionId, operationId, attemptId: crypto.randomUUID() });
    assert.equal(result.state, 'submitted');
    await partner.fileOperationReserve(make(), owner, async () => true, () => true);
    for (const [index, file] of staged.files.entries()) {
      assert.deepEqual(await readTestFile(partner, file.ref.attachmentId, owner), data[index]);
      assert.deepEqual(await readTestFile(partner, result.retryFiles!.files[index]!.ref.attachmentId, owner), data[index]);
    }
    assert.deepEqual((await partner.sharedMedia(image.images[0]!.ref.attachmentId, 'original'))?.bytes, fixtureImage);
    assert.deepEqual((await partner.sharedMedia(result.retryImages!.images[0]!.ref.attachmentId, 'original'))?.bytes, fixtureImage);
  } finally { await partner.close(); await f.close(); }
});
