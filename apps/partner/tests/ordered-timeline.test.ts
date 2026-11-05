import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ChatMessage, ChatView } from '@lamplit/contracts';
import { fixture, eventually } from './fixture.ts';
import { fixtureImage } from './panels-seed.ts';
import { createWebServer } from './web-server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';

test('authenticated image upload echoes exact draft identities and rejects another session', async () => {
  const f = await fixture(), partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async request => request.headers.authorization === 'test-owner' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const sessionId = (await partner.snapshot()).sessionId;
  const input = { sessionId, operationId: crypto.randomUUID(), images: ['draft-a', 'draft-b'].map((id, order) => ({
    id, order, name: 'same.png', mediaType: 'image/png', original: fixtureImage.toString('base64'),
    preview: Buffer.from([255, 216, 255, 217]).toString('base64'), model: Buffer.from([255, 216, 255, 217]).toString('base64'),
  })) };
  const post = (body: unknown, authorization = 'test-owner') => fetch(`${origin}/api/chat/images`, { method: 'POST', headers: { origin, authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(input, 'foreign')).status, 401);
    assert.equal((await post({ ...input, sessionId: 'foreign' })).status, 403);
    assert.equal((await post({ ...input, images: [input.images[0], { ...input.images[1], id: input.images[0]!.id }] })).status, 400);
    const response = await post(input); assert.equal(response.status, 200);
    const result = await response.json() as { sessionId: string; operationId: string; images: Array<{ id: string; order: number; ref: { attachmentId: string } }> };
    assert.equal(result.sessionId, sessionId); assert.equal(result.operationId, input.operationId);
    assert.deepEqual(result.images.map(({ id, order }) => ({ id, order })), [{ id: 'draft-a', order: 0 }, { id: 'draft-b', order: 1 }]);
    assert.equal(new Set(result.images.map(item => item.ref.attachmentId)).size, 2);
    assert.equal((await partner.snapshot()).messages.length, 0);
  } finally { await app.close(); await f.close(); }
});

test('unfinished images stay hidden and explicit image failures survive restart', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  let partner = await f.createPartner();
  try {
    await partner.submit(crypto.randomUUID(), 'pending image');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    const image = { type: 'imageGeneration', id: 'unfinished-image', status: 'in_progress', revisedPrompt: 'fixture', result: '', failure: null, savedPath: null };
    const failed = { ...image, id: 'failed-image' };
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/started', item: image },
      { method: 'item/started', item: failed }, { method: 'item/completed', item: { ...failed, status: 'failed' } }] });
    await eventually(async () => (await partner.snapshot()).results.some(result => result.timeline.some(slot => slot.itemId === failed.id && slot.imageState === 'failed')));
    assert.deepEqual((await createCodexChatBackend(partner).read()).messages.filter(message => message.imageState).map(message => message.imageState), ['failed']);
    await partner.close(); partner = await f.createPartner();
    assert.deepEqual((await createCodexChatBackend(partner).read()).messages.filter(message => message.imageState).map(message => message.imageState), ['failed']);
    await f.streamCommand({ action: 'fail' });
    await eventually(async () => (await createCodexChatBackend(partner).read()).activeTurnId === null);
    assert.deepEqual((await createCodexChatBackend(partner).read()).messages.filter(message => message.imageState).map(message => message.imageState), ['failed']);
  } finally { await partner.close(); await f.close(); }
});

test('an unobserved in-progress image snapshot does not claim a recorded start position', async () => {
  const f = await fixture();
  const turn = { id: 'historical-active', status: 'inProgress', itemsView: 'full', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'native-user', clientId: 'input', content: [{ type: 'text', text: 'input' }] },
    { type: 'imageGeneration', id: 'unobserved', status: 'in_progress', revisedPrompt: 'fixture', result: '', failure: null, savedPath: null },
  ] };
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 2, active: turn.id, turns: [turn] }));
  const partner = await f.createPartner();
  try {
    const view = await createCodexChatBackend(partner).read();
    assert.equal(view.messages.some(message => message.imageState), false);
  } finally { await partner.close(); await f.close(); }
});

// An explicitly supplied App source is an additional cross-check, not a CFL
// release dependency. Normal CFL installations need only the pinned archive.
const controllerPath = process.env.CFL_TEST_APP_CONTROLLER;
test('real App controller reconciles a delayed image across 35 voices, reconnect and restart', { skip: !controllerPath }, async () => {
  const { ChatController } = await import(pathToFileURL(controllerPath!).href) as { ChatController: new (changed: () => void, storage: Storage) => {
    view?: ChatView; older: ChatMessage[]; before: string | null; connected: boolean; historySyncFailed: boolean;
    start(): void; close(): void; loadOlder(): Promise<void>; setVisible(value: boolean): void;
  } };
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true'; f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  let partner = await f.createPartner();
  let app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: `http://127.0.0.1:${(app.server.address() as { port: number }).port}/` } });
  const storage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
  let controller = new ChatController(() => {}, storage);
  const visible = () => [...controller.older, ...(controller.view?.messages ?? [])];
  const image = { type: 'imageGeneration', id: 'slow-image', status: 'in_progress', revisedPrompt: 'fixture', result: '', failure: null, savedPath: null };
  const secondImage = { ...image, id: 'another-slow-image' };
  const voice = (index: number) => ({ type: 'mcpToolCall', id: `voice-${index}`, server: 'companion', tool: 'send_voice', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'voice', audioId: index.toString(16).padStart(64, '0') }) }] } });
  try {
    controller.start(); await eventually(async () => controller.connected);
    const sourceId = crypto.randomUUID(); await partner.submit(sourceId, 'timeline input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'before image' });
    await eventually(async () => visible().some(message => message.text === 'before image'));
    const first = partner.streamingReply()!;
    controller.close();
    const completedText = { type: 'agentMessage', id: first.id, text: first.text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
    await f.streamCommand({ action: 'timeline', entries: [
      { method: 'item/completed', item: completedText },
      { method: 'item/started', item: image },
      { method: 'item/started', item: image },
      { method: 'item/started', item: secondImage },
    ] });
    const native = await f.nativeState();
    await f.streamCommand({ action: 'event', notification: { method: 'item/started', params: { threadId: 'foreign-thread', turnId: native.active, startedAtMs: Date.now(), item: { ...image, id: 'foreign-image' } } } });
    const steerId = crypto.randomUUID(); await partner.submit(steerId, 'steer after pictures');
    await eventually(async () => await f.consumed(steerId));
    await f.streamCommand({ action: 'timeline', entries: [
      ...Array.from({ length: 35 }, (_, index) => [
        { method: 'item/started', item: { ...voice(index), status: 'inProgress', result: null } },
        { method: 'item/completed', item: voice(index) },
      ]).flat(),
    ] });
    await eventually(async () => (await partner.snapshot()).results.some(result => result.voices.length === 35), 20_000);
    controller = new ChatController(() => {}, storage); controller.start();
    await eventually(async () => (controller.view?.messages.filter(message => message.voice).length ?? 0) >= 28 && !!controller.before, 4_000);
    await controller.loadOlder();
    const imageId = `image:${createHash('sha256').update(JSON.stringify([first.turnId, image.id])).digest('hex')}`;
    const before = visible();
    assert.equal(before.some(message => message.imageState !== undefined), false);
    assert.equal(JSON.stringify(before).includes('foreign-image'), false);
    assert.ok(before.findIndex(message => message.operationId === sourceId) < before.findIndex(message => message.id === first.id));
    assert.ok(before.findIndex(message => message.operationId === steerId) < before.findIndex(message => !!message.voice));
    const otherImageId = `image:${createHash('sha256').update(JSON.stringify([first.turnId, secondImage.id])).digest('hex')}`;
    assert.equal(before.filter(message => message.voice).length, 35);
    const voiceIds = before.filter(message => message.voice).map(message => message.id);
    controller.setVisible(false);
    for (const socket of app.chatSockets.clients) socket.terminate();
    await eventually(async () => !controller.connected);
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/completed', item: { ...image, status: 'completed', result: fixtureImage.toString('base64') } }] });
    controller.setVisible(true);
    await eventually(async () => controller.connected && visible().some(message => message.id === imageId && message.imageState === 'ready'), 20_000);
    assert.equal(controller.historySyncFailed, false);
    assert.deepEqual(visible().filter(message => message.voice).map(message => message.id), voiceIds);
    await f.streamCommand({ action: 'timeline', entries: [{ method: 'item/completed', item: { ...secondImage, status: 'completed', result: fixtureImage.toString('base64') } }] });
    await eventually(async () => visible().some(message => message.id === otherImageId && message.imageState === 'ready'), 10_000);
    await f.streamCommand({ action: 'next', phase: 'final_answer' });
    await f.streamCommand({ action: 'advance', text: 'after voice' });
    await eventually(async () => visible().some(message => message.text === 'after voice'));
    assert.ok(visible().findIndex(message => message.id === imageId) < visible().findIndex(message => message.text === 'after voice'));
    await f.streamCommand({ action: 'complete', text: 'after voice' });
    await eventually(async () => controller.view?.activeTurnId === null);
    controller.close(); await app.close(); await partner.close();
    partner = await f.createPartner(); app = createWebServer(partner, join(f.directory, 'assets'));
    const backend = createCodexChatBackend(partner); const view = await backend.read();
    let cursor = view.before, restored = view.messages;
    while (cursor) { const page = await backend.history(cursor); restored = [...page.messages, ...restored]; cursor = page.before; }
    assert.equal(restored.find(message => message.id === imageId)?.imageState, 'ready');
    assert.deepEqual(restored.filter(message => message.voice).map(message => message.id), voiceIds);
    assert.ok(restored.findIndex(message => message.id === imageId) < restored.findIndex(message => message.text === 'after voice'));
  } finally {
    controller.close(); await app.close(); await partner.close(); await f.close();
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else Reflect.deleteProperty(globalThis, 'location');
  }
});
