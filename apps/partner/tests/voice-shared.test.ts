import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createChatHost } from '@lamplit/contracts/server';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import type { Partner } from '../runtime/partner.ts';
import { fixture, eventually } from './fixture.ts';

test('voice messages keep identity across edits, history windows and recovery', async () => {
  const ids = Array.from({ length: 35 }, (_, i) => i.toString(16).padStart(64, '0'));
  const image = { attachmentId: 'image', name: 'image.png', mediaType: 'image/png', availability: 'available' };
  const result = { id: 'turn:t', turnId: 't', sourceIds: ['source'], completedMessages: [] as Array<{id: string; text: string}>, images: [] as Array<{id: string}>, voices: ids.map(id => ({ id, itemId: `item:${id}`, url: `/api/audio/${id}.mp3` })), chatStatus: 'running' };
  const snapshot = { sessionId: 'session', name: 'Mica', messages: [{ id: 'source', delivery: 'acknowledged', inputImages: [], sequence: 1, input: 'hello', created: 1, turnId: 't' }], results: [result], cancellable: [], lifecycle: {}, hasMore: false, before: null };
  const partner = { snapshot: async () => ({ ...snapshot, results: [{ ...result, anchorSequence: 1, anchorCreated: 1, timeline: [
    { itemId: 'user', kind: 'user', sourceIds: ['source'] },
    ...result.completedMessages.map(message => ({ itemId: message.id, kind: 'text', text: message.text, textState: 'complete', sourceIds: [] })),
    ...result.images.map(item => ({ itemId: item.id, kind: 'image', imageId: item.id, imageState: 'ready', sourceIds: [] })),
    ...result.voices.map(item => ({ itemId: item.itemId, kind: 'voice', voiceId: item.id, sourceIds: [] })),
  ].map((item, position) => ({ ...item, position })) }] }), chatReceipt: async () => ({ state: 'submitted' }), sharedImageRef: async () => image, sharedRecovery: async () => [], sharedImageLimits: async () => false, sharedFileLimits: async () => false, streamingReply: () => undefined, replyCompletion: () => undefined } as unknown as Partner;
  const backend = createCodexChatBackend(partner);
  const collect = async () => {
    const latest = await backend.read();
    let before = latest.before, messages = latest.messages;
    while (before) { const page = await backend.history(before); messages = [...page.messages, ...messages]; before = page.before; }
    return messages;
  };
  const initial = await collect();
  assert.deepEqual(initial.filter(m => m.voice).map(m => m.voice!.id), ids);
  assert.equal(new Set(initial.map(m => m.id)).size, initial.length);
  const identity = new Map(initial.filter(m => m.voice).map(m => [m.voice!.id, m.id]));
  result.completedMessages.push({ id: 'answer', text: 'hello' }); result.images.push({ id: 'image' });
  result.voices.reverse();
  const mixed = await collect();
  assert.equal(mixed.find(m => m.imageState === 'ready')?.images?.[0]?.attachmentId, 'image');
  assert.deepEqual(mixed.filter(m => m.voice).map(m => m.voice!.id), [...ids].reverse());
  for (const message of mixed.filter(m => m.voice)) assert.equal(message.id, identity.get(message.voice!.id));
  assert.deepEqual(await collect(), mixed);
});

test('fake engine retains multiple voice identities through pagination, final text and restart', async () => {
  const f = await fixture(); f.appServer.env.FAKE_VOICE_COUNT = '35'; await f.holdVoiceFinal(true);
  let partner = await f.createPartner();
  const collect = async () => {
    const backend = createCodexChatBackend(partner), view = await backend.read();
    let before = view.before, messages = view.messages;
    while (before) { const page = await backend.history(before); messages = [...page.messages, ...messages]; before = page.before; }
    return messages;
  };
  try {
    await partner.submit(crypto.randomUUID(), 'send voice');
    await eventually(async () => (await collect()).filter(message => message.voice).length === 35);
    const initial = await collect();
    const identity = new Map(initial.flatMap(message => message.voice ? [[message.voice.id, message.id] as const] : []));
    assert.equal(identity.size, 35);
    assert.equal(new Set(initial.map(message => message.id)).size, initial.length);
    await f.holdVoiceFinal(false);
    await eventually(async () => (await collect()).some(message => message.role === 'agent' && message.text));
    const completed = await collect();
    for (const message of completed) if (message.voice) assert.equal(message.id, identity.get(message.voice.id));
    await partner.close(); partner = await f.createPartner();
    const restored = await collect();
    assert.deepEqual(restored.filter(message => message.voice).map(message => [message.voice!.id, message.id]), [...identity]);
  } finally { await partner.close(); await f.close(); }
});

test('fake engine keeps image, text and voice as distinct visible content', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  try {
    await partner.submit(crypto.randomUUID(), 'generate image and send voice');
    const read = () => createCodexChatBackend(partner).read();
    await eventually(async () => {
      const messages = (await read()).messages;
      return messages.some(message => message.voice) && messages.some(message => message.role === 'agent' && message.text) && messages.some(message => message.imageState === 'ready');
    });
    const initial = (await read()).messages;
    const voice = initial.find(message => message.voice)!;
    assert.equal(voice.text, ''); assert.equal(voice.images, undefined);
    assert.equal(initial.filter(message => message.voice).length, 1);
    await partner.close(); partner = await f.createPartner();
    const restored = (await read()).messages;
    assert.equal(restored.find(message => message.voice)?.id, voice.id);
    assert.ok(restored.some(message => message.imageState === 'ready') && restored.some(message => message.role === 'agent' && message.text));
  } finally { await partner.close(); await f.close(); }
});

test('repeated voice dispatches of the same cached audio remain distinct after restart', async () => {
  const f = await fixture(); f.appServer.env.FAKE_VOICE_COUNT = '2'; f.appServer.env.FAKE_VOICE_DUPLICATE = 'true';
  let partner = await f.createPartner();
  try {
    await partner.submit(crypto.randomUUID(), 'send voice');
    const read = async () => (await createCodexChatBackend(partner).read()).messages.filter(message => message.voice);
    await eventually(async () => (await read()).length === 2, 3_000);
    const voices = await read();
    assert.deepEqual(voices.map(message => message.voice!.id), ['a'.repeat(64), 'a'.repeat(64)]);
    assert.notEqual(voices[0]!.id, voices[1]!.id);
    await partner.close(); partner = await f.createPartner();
    assert.deepEqual((await read()).map(message => message.id), voices.map(message => message.id));
  } finally { await partner.close(); await f.close(); }
});

test('fake engine publishes voice over the shared socket and recovers it after restart', async () => {
  const f = await fixture(); f.appServer.env.FAKE_VOICE_COUNT = '35'; await f.holdVoiceFinal(true);
  let partner = await f.createPartner(), host = await createChatHost(createCodexChatBackend(partner));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const channels = new Map<import('ws').WebSocket, ReturnType<typeof host.connect>>();
  server.on('connection', socket => {
    const channel = host.connect(socket, async () => true); channels.set(socket, channel);
    socket.on('message', data => { void channel.receive(data.toString()); });
    socket.on('close', () => { channel.close(); channels.delete(socket); });
  });
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`), value => { view = value; }, () => {});
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    client = await connect();
    await partner.submit(crypto.randomUUID(), 'send voice');
    await eventually(async () => (view?.messages.filter(message => message.voice).length ?? 0) === 30 && !!view?.before, 20_000);
    let history = await client.history(view!.before!);
    assert.equal(history.messages.filter(message => message.voice).length, 5);
    const identity = new Map([...history.messages, ...view!.messages].flatMap(message => message.voice ? [[message.voice.id, message.id] as const] : []));
    assert.equal(identity.size, 35);
    await f.holdVoiceFinal(false);
    await eventually(async () => (await partner.snapshot()).results?.some(result => result.completedMessages.length > 0) === true);
    await eventually(async () => view!.messages.some(message => message.role === 'agent' && !!message.text));
    history = await client.history(view!.before!);
    for (const message of [...history.messages, ...view!.messages]) if (message.voice) assert.equal(message.id, identity.get(message.voice.id));
    client.close(); host.close(); for (const socket of channels.keys()) socket.terminate();
    await partner.close(); partner = await f.createPartner(); host = await createChatHost(createCodexChatBackend(partner));
    client = await connect(); history = await client.history(view!.before!);
    assert.deepEqual([...history.messages, ...view!.messages].flatMap(message => message.voice ? [[message.voice.id, message.id] as const] : []), [...identity]);
  } finally {
    client?.close(); host.close(); for (const socket of channels.keys()) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); await partner.close(); await f.close();
  }
});
