import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fixture, eventually } from './fixture.ts';
import { fixtureImage } from './panels-seed.ts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { imagePath, imageLimits } from '../runtime/images.ts';
import { MAX_UPLOAD_BODY_BYTES, type ImageUpload } from '@lamplit/contracts';

const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
function upload(sessionId: string, operationId = crypto.randomUUID()): ImageUpload {
  return { sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] };
}

test('bounded authenticated HTTP staging is immutable, operation-owned and separate from admission; originals reach start/steer', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner(); let authorized = true;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async req => authorized && req.headers.authorization === 'fixture-owner' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { origin, authorization: 'fixture-owner', 'content-type': 'application/json' };
  const post = (value: unknown, extra = {}) => fetch(origin + '/api/chat/images', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  try {
    const input = upload((await partner.snapshot()).sessionId);
    assert.equal((await post(input, { authorization: 'another-owner' })).status, 401);
    assert.equal((await post(input, { origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await post(input, { origin: origin.replace('http:', 'https:'), authorization: 'another-owner' })).status, 401);
    assert.equal((await post(input, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post(input, { origin: origin.replace('http:', 'https:'), 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await fetch(origin + '/api/chat/images', { method: 'POST', headers: { authorization: headers.authorization, 'content-type': headers['content-type'] }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await post({ ...input, sessionId: 'wrong-session' })).status, 403);
    for (const patch of [{ name: 'x'.repeat(161) }, { name: '../path.png' }, { original: jpeg }, { preview: fixtureImage.toString('base64') }, { original: 'iVBORw0KGgo=!!' }, { order: 1 }, { id: '../escape' }, { original: Buffer.alloc(imageLimits.maxImageBytes + 1).toString('base64') }]) {
      assert.equal((await post({ ...input, images: [{ ...input.images[0], ...patch }] })).status, 400);
    }
    const excessive = { ...input, images: Array.from({ length: 6 }, (_, i) => ({ ...input.images[0], id: `image${i}`, order: i })) };
    assert.equal((await post(excessive)).status, 400);
    assert.equal((await fetch(origin + '/api/chat/images', { method: 'POST', headers, body: JSON.stringify({ padding: 'x'.repeat(MAX_UPLOAD_BODY_BYTES) }) })).status, 413);
    const response = await post(input); assert.equal(response.status, 200);
    const result = await response.json();
    const httpsResponse = await post(input, { origin: origin.replace('http:', 'https:') });
    assert.equal(httpsResponse.status, 200); assert.deepEqual(await httpsResponse.json(), result);
    const id = result.images[0].attachmentId;
    assert.equal((await partner.snapshot()).messages.length, 0);
    assert.equal((await partner.conversationImages()).images.length, 0);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 0);
    assert.deepEqual((await (await post(input)).json()), result);
    assert.deepEqual((await (await post({ images: input.images, operationId: input.operationId, sessionId: input.sessionId })).json()), result);
    assert.equal((await post({ ...input, images: [{ ...input.images[0], model: Buffer.from([255, 216, 255, 1]).toString('base64') }] })).status, 400);
    const media = `/api/chat/media/${id}/original`;
    assert.equal((await fetch(origin + media)).status, 401);
    assert.deepEqual(Buffer.from(await (await fetch(origin + media, { headers })).arrayBuffer()), fixtureImage);
    assert.equal((await fetch(origin + `/api/chat/media/${id}/../original`, { headers })).status, 400);
    assert.equal((await fetch(origin + `/api/chat/media/${id}/preview`, { headers })).headers.get('content-type'), 'image/jpeg');
    const submission = { operationId: input.operationId, text: '', images: result.images };
    await assert.rejects(partner.submitShared({ ...submission, operationId: crypto.randomUUID() }));
    assert.equal((await partner.snapshot()).messages.length, 0);
    await partner.submitShared(submission); await partner.submitShared(submission);
    await partner.submitShared({ ...submission, images: submission.images.map(({ name, mediaType, attachmentId, availability }: typeof submission.images[number]) => ({ availability, mediaType, name, attachmentId })) });
    await assert.rejects(partner.submitShared({ ...submission, text: 'changed' }));
    const steer = upload(input.sessionId); const uploadedSteer = await partner.uploadImages(steer);
    await partner.submitShared({ operationId: steer.operationId, text: 'steer', images: uploadedSteer.images });
    await eventually(async () => (await partner.chatReceipt(steer.operationId)).state === 'consumed');
    const requests = (await f.requests()).filter(r => r.method === 'turn/start' || r.method === 'turn/steer');
    assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
    for (const request of requests) {
      const params = request.params as { input: Array<{ type: string; path?: string }> };
      const image = params.input.find(item => item.type === 'localImage')!;
      assert.deepEqual(await readFile(image.path!), fixtureImage);
    }
    const view = await createCodexChatBackend(partner).read();
    assert.equal(view.messages.find(m => m.id === input.operationId)?.images?.[0]?.attachmentId, id);
    assert.equal(view.messages.find(m => m.id === input.operationId)?.text, '');
    assert.equal(view.recovery.length, 0);
    const changed = upload(input.sessionId); const changedRefs = await partner.uploadImages(changed);
    await writeFile(imagePath(f.workspace, { id: changedRefs.images[0]!.attachmentId, media_type: 'image/png' }), Buffer.concat([fixtureImage, Buffer.from('changed')]));
    await assert.rejects(partner.submitShared({ operationId: changed.operationId, text: '', images: changedRefs.images }));
    const incomplete = upload(input.sessionId); incomplete.images.push({ ...incomplete.images[0]!, id: 'second', order: 1 });
    const incompleteRefs = await partner.uploadImages(incomplete);
    await assert.rejects(partner.submitShared({ operationId: incomplete.operationId, text: '', images: incompleteRefs.images.slice(0, 1) }));
    const nativeMax = Buffer.concat([fixtureImage, Buffer.alloc(imageLimits.maxImageBytes - fixtureImage.length)]).toString('base64');
    assert.equal((await post({ ...upload(input.sessionId), images: Array.from({ length: 5 }, (_, i) => ({ ...input.images[0], id: `total${i}`, order: i, original: nativeMax })) })).status, 400);
    let remaining = MAX_UPLOAD_BODY_BYTES + 1;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (!remaining) { controller.close(); return; } const size = Math.min(remaining, 1024 * 1024); remaining -= size; controller.enqueue(new Uint8Array(size)); } });
    assert.equal((await fetch(origin + '/api/chat/images', { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit)).status, 413);
    authorized = false;
    assert.equal((await fetch(origin + media, { headers })).status, 401);
  } finally { await app.close(); await f.close(); }
});

test('verified native rejection permits atomic edited replacement; uncertainty, forged sources and consumed/replaced inputs never restore', async () => {
  const f = await fixture();
  f.appServer.env.FAKE_IMAGES_FIXTURE = 'true';
  const setMode = (mode: string) => writeFile(f.appServer.env.FAKE_SERVER_CONTROL!, JSON.stringify({ hold: true, mode }));
  await setMode('rejected');
  let partner = await f.createPartner();
  try {
    const nativeId = crypto.randomUUID();
    await assert.rejects(partner.submit(nativeId, 'native original', [{ type: 'image', name: 'native.png', mediaType: 'image/png', data: fixtureImage.toString('base64') }]));
    const recovery = await partner.sharedRecovery();
    assert.equal(recovery[0]?.sourceId, nativeId); assert.equal(recovery[0]?.replacementEligible, true);
    const unavailable = recovery[0]!.images[0]!;
    await rm(imagePath(f.workspace, { id: unavailable.attachmentId, media_type: unavailable.mediaType }));
    assert.equal((await partner.sharedRecovery())[0]?.images[0]?.availability, 'missing');
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.sharedRecovery())[0]?.replacementEligible, true);
    const replacement = { operationId: crypto.randomUUID(), text: 'edited without missing image', replacementSourceIds: [nativeId] };
    await assert.rejects(partner.submitShared({ ...replacement, replacementSourceIds: [crypto.randomUUID()] }));
    assert.equal((await partner.snapshot()).messages.length, 1);
    await setMode('consumed'); await partner.submitShared(replacement);
    await eventually(async () => (await partner.chatReceipt(replacement.operationId)).state === 'consumed');
    await partner.submitShared(replacement); // reconcile before evaluating the now replaced source
    await assert.rejects(partner.submitShared({ ...replacement, text: 'mutated' }));
    await assert.rejects(partner.submitShared({ ...replacement, operationId: crypto.randomUUID() }));
    assert.equal((await partner.sharedRecovery()).length, 0);
    await assert.rejects(partner.submitShared({ operationId: crypto.randomUUID(), text: 'consume again', replacementSourceIds: [replacement.operationId] }));
    await partner.chatStop((await partner.snapshot()).cancellable[0]!);
    await setMode('uncertain');
    const uncertain = { operationId: crypto.randomUUID(), text: 'unknown' };
    await partner.submitShared(uncertain);
    await eventually(async () => (await partner.sharedRecovery()).some(r => r.sourceId === uncertain.operationId));
    assert.equal((await partner.sharedRecovery())[0]?.state, 'uncertain');
    assert.equal((await partner.sharedRecovery())[0]?.replacementEligible, false);
    await assert.rejects(partner.submitShared({ operationId: crypto.randomUUID(), text: 'never blind replay', replacementSourceIds: [uncertain.operationId] }));
    const starts = (await f.requests()).filter(r => r.method === 'turn/start').length;
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.sharedRecovery())[0]?.state, 'uncertain');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, starts);
    assert.equal((await partner.sharedRecovery()).some(r => r.sourceId === nativeId), false);
  } finally { await partner.close(); await f.close(); }
});


test('rejected uppercase shared UUIDs retain their identity through recovery, read and atomic replacement', async () => {
  const f = await fixture(); f.appServer.env.FAKE_IMAGES_FIXTURE = 'true';
  const setMode = (mode: string) => writeFile(f.appServer.env.FAKE_SERVER_CONTROL!, JSON.stringify({ hold: true, mode }));
  await setMode('rejected');
  const partner = await f.createPartner();
  try {
    const operationId = 'ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345';
    assert.equal((await partner.submitShared({ operationId, text: 'uppercase original' })).state, 'rejected');
    const recovery = (await createCodexChatBackend(partner).read()).recovery;
    assert.equal(recovery.length, 1);
    assert.deepEqual(recovery[0], { sourceId: operationId, operationId, text: 'uppercase original', images: [], state: 'rejected', replacementEligible: true });
    assert.equal((await partner.snapshot()).messages[0]?.id, operationId);
    await assert.rejects(partner.submitShared({ operationId: 'A'.repeat(36), text: 'malformed' }));
    await assert.rejects(partner.submitShared({ operationId: crypto.randomUUID(), text: 'wrong case identity', replacementSourceIds: [operationId.toLowerCase()] }));
    await setMode('consumed');
    const replacement = { operationId: crypto.randomUUID(), text: 'edited uppercase original', replacementSourceIds: [operationId] };
    await partner.submitShared(replacement);
    await eventually(async () => (await partner.chatReceipt(replacement.operationId)).state === 'consumed');
    await partner.submitShared(replacement);
    assert.equal((await partner.sharedRecovery()).length, 0);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 2);
    await assert.rejects(partner.submitShared({ ...replacement, operationId: crypto.randomUUID() }));
  } finally { await partner.close(); await f.close(); }
});

test('existing 32 MiB native generated originals are readable independently of 5 MiB intake; native membership authorizes history and album', async () => {
  const f = await fixture(); f.appServer.env.FAKE_GENERATED_IMAGE_BYTES = String(32 * 1024 * 1024);
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await partner.submit(crypto.randomUUID(), 'generate image');
    await eventually(async () => (await partner.snapshot()).results.some(r => r.images.length === 1));
    const image = (await partner.snapshot()).results[0]!.images[0]!;
    const response = await fetch(origin + `/api/chat/media/${image.id}/original`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.arrayBuffer()).byteLength, 32 * 1024 * 1024);
    const backend = createCodexChatBackend(partner);
    const view = await backend.read(); assert.equal(view.messages.find(m => m.role === 'agent')?.images?.[0]?.attachmentId, image.id);
    assert.equal((await backend.album({ sessionId: view.sessionId, cursor: null })).images[0]?.origin, 'agent');
    assert.equal((await fetch(origin + `/api/chat/media/${image.id}/preview`)).status, 404);
  } finally { await app.close(); await f.close(); }
});
