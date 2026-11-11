import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { fixtureImage } from './panels-seed.ts';
import { createWebServer } from './web-server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { fixture, eventually } from './fixture.ts';

for (const count of [0, 35, 70]) test(`native text/image/voice/steering order survives ${count ? `${count} older rounds` : 'live read'} and restart`, async () => {
  const f = await fixture();
  const savedPath = join(f.directory, 'native-image.png'), audioId = 'b'.repeat(64);
  await writeFile(savedPath, fixtureImage);
  await mkdir(join(f.workspace, '.lamplit', 'audio'), { recursive: true });
  await writeFile(join(f.workspace, '.lamplit', 'audio', `${audioId}.mp3`), 'ID3 test-owned voice');
  const mixed = { id: 'mixed-turn', status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'native-human', clientId: 'first-input', content: [{ type: 'text', text: 'first human' }] },
    { type: 'agentMessage', id: 'first-text', text: 'before image', phase: 'commentary' },
    { type: 'imageGeneration', id: 'image-slot', status: 'completed', savedPath, result: '' },
    { type: 'mcpToolCall', id: 'voice-tool', server: 'companion', tool: 'send_voice', status: 'completed', arguments: {}, appContext: null, pluginId: null, readOnlyHint: null, error: null, durationMs: 1, result: { _meta: null, structuredContent: null, content: [{ type: 'text', text: JSON.stringify({ kind: 'voice', audioId }) }] } },
    { type: 'userMessage', id: 'native-steer', clientId: 'steered-input', content: [{ type: 'text', text: 'steered human' }] },
    { type: 'agentMessage', id: 'last-text', text: 'after voice', phase: 'final_answer' },
  ] };
  const turns = [mixed, ...Array.from({ length: count }, (_, i) => ({ id: `later-${i}`, status: 'completed', startedAt: 1700000001 + i, items: [
    { type: 'userMessage', id: `user-${i}`, clientId: `input-${i}`, content: [{ type: 'text', text: `later ${i}` }] },
    { type: 'agentMessage', id: `answer-${i}`, text: `reply ${i}`, phase: 'final_answer' },
  ] }))];
  if (count === 70) {
    mixed.items.push(
      { type: 'userMessage', id: 'native-last-steer', clientId: 'last-steered-input', content: [{ type: 'text', text: 'last steer' }] },
      { type: 'agentMessage', id: 'after-last-steer', text: 'last reply', phase: 'final_answer' },
    );
    // Durable admission order need not keep one native turn contiguous: queued
    // inputs can precede steers consumed by the already active turn.
    const paths = partnerPaths(f.workspace); await mkdir(paths.managedRoot, { recursive: true });
    const store = new Store(paths.database);
    try {
      for (const id of ['first-input', ...Array.from({ length: 35 }, (_, i) => `input-${i}`), 'steered-input', ...Array.from({ length: 35 }, (_, i) => `input-${i + 35}`), 'last-steered-input']) {
        await store.ensureMessage(id, 1700000000000);
      }
    } finally { await store.close(); }
  }
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 100, turns }));
  try {
    for (let restart = 0; restart < 2; restart++) {
      const partner = await f.createPartner(), backend = createCodexChatBackend(partner);
      const view = await backend.read(), messages = [...view.messages]; let before = view.before;
      while (before) { const page = await backend.history(before); messages.unshift(...page.messages); before = page.before; }
      if (count === 70) {
        const app = createWebServer(partner, join(f.directory, 'assets'));
        app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
        let socketView: ChatView | undefined;
        const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), value => { socketView = value; }, () => {});
        let client = await connect();
        try {
          await eventually(async () => !!socketView);
          const all = [...socketView!.messages]; let cursor = socketView!.before;
          while (cursor) {
            const page = await client.history(cursor);
            assert.ok(page.messages.length > 0 && page.messages.length <= 30);
            client.close(); socketView = undefined; client = await connect();
            await eventually(async () => !!socketView);
            assert.deepEqual(await client.history(cursor), page, 'retained cursor is stable across reconnect');
            all.unshift(...page.messages); cursor = page.before;
          }
          assert.equal(new Set(all.map(m => m.id)).size, all.length, 'shared history must not repeat turn entries');
          assert.deepEqual(all.map(m => m.id), messages.map(m => m.id));
        } finally { client.close(); await app.close(); }
      }
      assert.equal(new Set(messages.map(m => m.id)).size, messages.length, 'history must not repeat turn entries');
      assert.equal(messages.length, count * 2 + (count === 70 ? 8 : 6));
      const entries = messages.filter(message => message.turnId === 'mixed-turn');
      assert.deepEqual(entries.map(message => message.id), ['first-input', 'first-text', `image:${createHash('sha256').update(JSON.stringify(['mixed-turn', 'image-slot'])).digest('hex')}`, `voice:${createHash('sha256').update(JSON.stringify(['turn:mixed-turn', 'voice-tool', audioId])).digest('hex')}`, 'steered-input', 'last-text', ...(count === 70 ? ['last-steered-input', 'after-last-steer'] : [])]);
      assert.equal(entries[2]!.imageState, 'ready'); assert.equal(entries[2]!.images?.length, 1);
      assert.deepEqual(entries[3]!.voice, { id: audioId });
      assert.equal(entries[1]!.images, undefined); assert.equal(entries[5]!.images, undefined);
      assert.equal((await f.requests()).some(request => request.method === 'turn/start'), false);
      await partner.close();
    }
  } finally { await f.close(); }
});

test('shared socket publishes native input changes through the view', async () => {
  const f = await fixture(), partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const frames: string[] = []; let view: ChatView | undefined;
  const socket = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`);
  socket.addEventListener('message', event => frames.push(String(event.data)));
  const client = await openChat(socket, value => { view = value; }, () => {});
  try {
    const operationId = crypto.randomUUID(); await client.submit({ operationId, text: 'native view update' }).catch(() => {});
    await eventually(async () => view?.messages.some(message => message.role === 'agent') === true);
    assert.ok(view!.messages.some(message => message.operationId === operationId));
    assert.equal(frames.some(frame => JSON.parse(frame).type === 'timeline'), false);
  } finally { client.close(); await app.close(); await f.close(); }
});

for (const [backlog, depth] of [[0, 0], [70, 0], [70, 1]] as const) test(`retained cursor stays exclusive when active turn gains a newer steer beyond its bound (${backlog} later admissions, ${depth} loaded pages)`, async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true'; f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  const paths = partnerPaths(f.workspace); await mkdir(paths.managedRoot, { recursive: true });
  const store = new Store(paths.database);
  const prior = Array.from({ length: 65 }, (_, i) => ({ type: 'agentMessage', id: `prior-answer-${i}`, text: `prior reply ${i}`, phase: 'commentary' }));
  try {
    await store.admit('active-input', 'active initial input');
    await store.recordTimelineSlot('thread-fake', 'growing-turn', 'native-active-input', 'user');
    for (const item of prior) {
      await store.markChatItemCompleted('growing-turn', item.id);
      await store.recordTimelineSlot('thread-fake', 'growing-turn', item.id, 'text');
    }
    await store.recordTimelineSlot('thread-fake', 'growing-turn', 'pending-answer', 'text');
    // Old unresolved admissions remain hidden and are never replayed.
    for (let i = 0; i < backlog; i++) await store.admit(`queued-${i}`, `queued input ${i}`);
  } finally { await store.close(); }
  const turn = { id: 'growing-turn', status: 'inProgress', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'native-active-input', clientId: 'active-input', content: [{ type: 'text', text: 'active initial input' }] },
    ...prior, { type: 'agentMessage', id: 'pending-answer', text: '', phase: 'final_answer' },
  ] };
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 100, active: turn.id, streamingItem: 'pending-answer', turns: [turn] }));
  const partner = await f.createPartner(); const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), value => { view = value; }, () => {});
  let client = await connect();
  try {
    await eventually(async () => !!view?.before);
    const original = view!, loaded = [...original.messages];
    let cursor = original.before!;
    for (let i = 0; i < depth; i++) {
      const page = await client.history(cursor); loaded.unshift(...page.messages); cursor = page.before!;
    }
    const cursorBeforeSequence = JSON.parse(cursor).before;
    const steer = crypto.randomUUID(); await client.submit({ operationId: steer, text: 'steer after retained cursor' }).catch(() => {});
    await eventually(async () => (await partner.snapshot()).messages.some(message => message.id === steer));
    assert.ok((await partner.snapshot()).messages.find(message => message.id === steer)!.sequence >= cursorBeforeSequence);
    await f.streamCommand({ action: 'next' });
    await f.streamCommand({ action: 'complete', text: 'after retained-cursor steer' });
    await eventually(async () => view?.activeTurnId === null);
    const fresh = [...view!.messages]; let before = view!.before;
    while (before) { const page = await client.history(before); fresh.unshift(...page.messages); before = page.before; }
    const retained = [...view!.messages];
    const liveIds = new Set(retained.map(message => message.id));
    // Mirror the shared UI's retention of messages evicted by a live refresh.
    retained.unshift(...loaded.filter(message => !liveIds.has(message.id)));
    before = cursor;
    while (before) {
      const page = await client.history(before);
      assert.ok(page.messages.length > 0 && page.messages.length <= 30);
      client.close(); view = undefined; client = await connect();
      await eventually(async () => !!view);
      assert.deepEqual(await client.history(before), page, 'retained cursor is stable after refresh/reconnect');
      retained.unshift(...page.messages); before = page.before;
    }
    assert.equal(new Set(retained.map(message => message.id)).size, retained.length, 'retained history and refreshed live pages are exclusive');
    assert.deepEqual(retained.map(message => message.id), fresh.map(message => message.id), 'retained cursor must not omit a new steer from its native timeline');
    const native = fresh.filter(message => message.turnId === turn.id);
    assert.deepEqual(native.map(message => message.text), ['active initial input', ...prior.map(item => item.text), 'steer after retained cursor', 'after retained-cursor steer']);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 0, 'unresolved admissions are never replayed');
  } finally { client.close(); await app.close(); await f.close(); }
});
