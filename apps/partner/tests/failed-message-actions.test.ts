import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { fixture } from './fixture.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';

test('native finalization fences late text admission and retains proof after deletion and reopen', async () => {
  const f = await fixture();
  let partner = await f.createPartner();
  try {
    let backend = createCodexChatBackend(partner);
    const sessionId = (await backend.read()).sessionId;
    const submission = { operationId: crypto.randomUUID(), text: 'late original' };
    const input = { sessionId, submission };
    assert.equal((await backend.finalizeSubmission(input))?.state, 'failed');
    assert.equal((await backend.submit(submission)).state, 'failed');
    await assert.rejects(backend.submit({ ...submission, text: 'changed' }));
    assert.deepEqual(await backend.deleteFailed({ sessionId, operationId: submission.operationId }), { sessionId, operationId: submission.operationId, deleted: true });
    assert.equal((await backend.read()).recovery.length, 0);
    await partner.close(); partner = await f.createPartner(); backend = createCodexChatBackend(partner);
    assert.equal((await backend.submit(submission)).state, 'failed');
    assert.equal((await backend.read()).recovery.length, 0);
    assert.equal((await backend.read()).messages.length, 0);
    const accepted = { operationId: crypto.randomUUID(), text: 'accepted' };
    assert.equal((await backend.submit(accepted)).state, 'submitted');
    assert.equal((await backend.finalizeSubmission({ sessionId, submission: accepted }))?.state, 'submitted');
    assert.equal((await backend.deleteFailed({ sessionId, operationId: accepted.operationId })).deleted, false);
  } finally { await partner.close(); await f.close(); }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('authorization gate orders original admission against finalization without timeout inference', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const entered = gate(), held = gate(); let valid = true;
  const backend = createCodexChatBackend(partner, async () => { entered.release(); await held.promise; return valid; });
  try {
    const sessionId = (await backend.read()).sessionId;
    const submission = { operationId: crypto.randomUUID(), text: 'held before admission' };
    const sending = backend.submit(submission);
    await entered.promise;
    const finalizing = partner.finalizeSubmission({ sessionId, submission });
    assert.equal(await partner.chatReceipt(submission.operationId), null);
    held.release();
    assert.equal((await sending).state, 'submitted');
    assert.equal((await finalizing)?.state, 'submitted');
    valid = false;
    await assert.rejects(backend.finalizeSubmission({ sessionId, submission: { operationId: crypto.randomUUID(), text: 'unauthorized' } }));
    await assert.rejects(partner.finalizeSubmission({ sessionId: 'foreign', submission }));
    await assert.rejects(partner.finalizeSubmission({ sessionId, submission: { ...submission, text: 'changed' } }));
    assert.equal(await partner.finalizeSubmission({ sessionId, retry: { sessionId, operationId: submission.operationId, attemptId: crypto.randomUUID() } }), null);
  } finally { held.release(); await partner.close(); await f.close(); }
});

test('failed image retry uses exact server originals with new ownership, deduplicates and survives reopen', async () => {
  const { fixtureImage } = await import('./panels-seed.ts');
  const { readFile } = await import('node:fs/promises');
  const { imagePath } = await import('../runtime/images.ts');
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  try {
    let backend = createCodexChatBackend(partner);
    const sessionId = (await backend.read()).sessionId;
    const operationId = crypto.randomUUID();
    const staged = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: Buffer.from([255,216,255,217]).toString('base64'), model: Buffer.from([255,216,255,217]).toString('base64') }] });
    const submission = { operationId, text: 'original image caption', images: staged.images };
    assert.equal((await backend.finalizeSubmission({ sessionId, submission }))?.state, 'failed');
    await partner.close(); partner = await f.createPartner(); backend = createCodexChatBackend(partner);
    const retry = { sessionId, operationId, attemptId: crypto.randomUUID() };
    const [a,b] = await Promise.all([backend.retryFailed(retry), backend.retryFailed(retry)]);
    assert.equal(a.state, 'submitted'); assert.equal(b.state, 'submitted');
    const view = await backend.read();
    const message = view.messages.find(m => m.operationId === retry.attemptId)!;
    assert.equal(message.text, submission.text);
    const newId = message.images![0]!.attachmentId;
    assert.notEqual(newId, staged.images[0]!.attachmentId);
    assert.deepEqual((await partner.sharedMedia(newId, 'original'))?.bytes, fixtureImage);
    assert.deepEqual(await readFile(imagePath(f.workspace, { id: newId, media_type: 'image/png' })), fixtureImage);
    assert.equal((await backend.finalizeSubmission({ sessionId, retry }))?.operationId, retry.attemptId);
    await assert.rejects(backend.retryFailed({ ...retry, operationId: crypto.randomUUID() }));
    await assert.rejects(backend.finalizeSubmission({ sessionId, retry: { ...retry, sessionId: 'foreign' } }));
    assert.equal((await backend.deleteFailed({ sessionId, operationId })).deleted, false, 'accepted retry retired its failed source');
    assert.deepEqual((await partner.sharedMedia(newId, 'original'))?.bytes, fixtureImage);
  } finally { await partner.close(); await f.close(); }
});

test('compiled App socket finalizes delayed originals and retries; deleted failures never re-admit', async () => {
  const { join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../runtime/store.ts');
  const { partnerPaths } = await import('../runtime/storage-paths.ts');
  const { createWebServer } = await import('../runtime/server.ts');
  const { openChat } = await import('@lamplit/contracts/client');
  const f = await fixture(); await f.holdProvider(true);
  const paths = partnerPaths(f.workspace); await mkdir(paths.managedRoot, { recursive: true });
  const seed = new Store(paths.database); await seed.close();
  const db = new DatabaseSync(paths.database);
  db.exec("CREATE TRIGGER reject_retry BEFORE INSERT ON pending_inputs WHEN NEW.input='retry rejected' BEGIN SELECT RAISE(ABORT, 'owned retry rejection'); END"); db.close();
  const partner = await f.createPartner();
  const realSubmit = partner.submitShared.bind(partner);
  const oldSubmitEntered = gate(), releaseOldSubmit = gate();
  partner.submitShared = async (input, authorize) => {
    if (input.text === 'socket delayed') { oldSubmitEntered.release(); await releaseOldSubmit.promise; }
    return realSubmit(input, authorize);
  };
  const app = createWebServer(partner, join(f.directory,'assets'));
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  let view: import('@lamplit/contracts').ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
  try {
    const { eventually } = await import('./fixture.ts');
    await eventually(async () => !!view);
    const sessionId = view!.sessionId;
    const submission = { operationId: crypto.randomUUID(), text: 'socket delayed' };
    const delayed = client.submit(submission); await oldSubmitEntered.promise;
    const receipt = await client.finalizeSubmission({ sessionId, submission });
    assert.equal(receipt?.state,'failed');
    await client.deleteFailed({ sessionId, operationId: submission.operationId });
    releaseOldSubmit.release(); assert.equal((await delayed).state,'failed');
    const failed = { operationId: crypto.randomUUID(), text: 'retry rejected' };
    await client.finalizeSubmission({ sessionId, submission: failed });
    const retry = { sessionId, operationId: failed.operationId, attemptId: crypto.randomUUID() };
    assert.equal((await client.retryFailed(retry)).state,'failed');
    assert.equal((await client.finalizeSubmission({ sessionId, retry }))?.operationId,retry.attemptId);
    assert.equal((await client.finalizeSubmission({ sessionId, retry }))?.state,'failed');
    assert.equal((await client.deleteFailed({ sessionId, operationId: retry.attemptId })).deleted,true);
    assert.equal((await client.retryFailed(retry)).state,'failed');
    assert.equal((await partner.sharedRecovery()).length,0);
    await assert.rejects(client.retryFailed({ ...retry, operationId: submission.operationId }));
    await assert.rejects(client.deleteFailed({ sessionId: 'another-session', operationId: failed.operationId }));
    assert.equal((await client.submit({ operationId: crypto.randomUUID(), text: 'ordinary chat still works' })).state,'submitted');
  } finally { releaseOldSubmit.release(); client.close(); await app.close(); await f.close(); }
});

test('missing original bytes block the entire retry, retain immutable source binding, and remain deletable', async () => {
  const { fixtureImage } = await import('./panels-seed.ts');
  const { unlink } = await import('node:fs/promises');
  const { imagePath } = await import('../runtime/images.ts');
  const f = await fixture(); const partner = await f.createPartner();
  try {
    const backend = createCodexChatBackend(partner);
    const sessionId = (await backend.read()).sessionId, operationId = crypto.randomUUID();
    const uploaded = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'owned.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: Buffer.from([255,216,255,217]).toString('base64'), model: Buffer.from([255,216,255,217]).toString('base64') }] });
    const submission = { operationId, text: 'text must not escape missing image', images: uploaded.images };
    await backend.finalizeSubmission({ sessionId, submission });
    await unlink(imagePath(f.workspace, { id: uploaded.images[0]!.attachmentId, media_type: 'image/png' }));
    const retry = { sessionId, operationId, attemptId: crypto.randomUUID() };
    await assert.rejects(backend.retryFailed(retry));
    assert.equal(await backend.lookup(retry.attemptId), null);
    assert.equal(await backend.finalizeSubmission({ sessionId, retry }), null);
    await assert.rejects(backend.retryFailed({ ...retry, operationId: crypto.randomUUID() }));
    // A reserved retry ID cannot be claimed as a different initial submission.
    await assert.rejects(backend.submit({ operationId: retry.attemptId, text: 'different initial payload' }));
    assert.equal((await backend.read()).messages.length, 0);
    assert.equal((await partner.conversationImages()).images.length, 0);
    assert.equal((await backend.deleteFailed({ sessionId, operationId })).deleted, true);
    assert.equal((await partner.sharedRecovery()).length, 0);
    await assert.rejects(backend.submit({ operationId: crypto.randomUUID(), text: 'late replacement', replacementSourceIds: [operationId] }));
    await assert.rejects(backend.retryFailed(retry));
  } finally { await partner.close(); await f.close(); }
});

test('retry admission rechecks owner after source reads; deletion wins a queued retry', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const entered = gate(), held = gate();
  try {
    const backend = createCodexChatBackend(partner), sessionId = (await backend.read()).sessionId;
    const submission = { operationId: crypto.randomUUID(), text: 'owner scoped retry' };
    await backend.finalizeSubmission({ sessionId, submission });
    let checks = 0;
    const denied = partner.retryFailed({ sessionId, operationId: submission.operationId, attemptId: crypto.randomUUID() }, async () => ++checks === 1);
    await assert.rejects(denied);
    assert.equal((await backend.read()).messages.length, 0);
    const removing = partner.deleteFailed({ sessionId, operationId: submission.operationId }, async () => { entered.release(); await held.promise; return true; });
    await entered.promise;
    const retry = backend.retryFailed({ sessionId, operationId: submission.operationId, attemptId: crypto.randomUUID() });
    const rejected = assert.rejects(retry);
    held.release(); assert.equal((await removing).deleted, true); await rejected;
    assert.equal((await partner.sharedRecovery()).length, 0);
    assert.equal((await backend.read()).messages.length, 0);
  } finally { held.release(); await partner.close(); await f.close(); }
});
