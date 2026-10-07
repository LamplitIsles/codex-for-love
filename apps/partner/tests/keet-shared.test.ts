import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { openChat } from '@lamplit/contracts/client';
import type { ChatMessage, ChatView } from '@lamplit/contracts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { createWebServer } from '../runtime/server.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { fixture, eventually } from './fixture.ts';

test('native Keet ingress retains display source, private context, images and receipts through shared reconnect/restart/history', async () => {
  const f = await fixture();
  const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#cc8844' } }).png().toBuffer();
  const imageRequests: string[] = [];
  const kfa = createServer((request, response) => {
    imageRequests.push(`${request.url} ${request.headers.authorization}`);
    response.writeHead(200, { 'content-type': 'image/png' }).end(bytes);
  });
  kfa.listen(0, '127.0.0.1'); await once(kfa, 'listening');
  f.config.keet = { endpoint: `http://127.0.0.1:${(kfa.address() as { port: number }).port}` };
  f.credentials.keet = 'owned-fake-kfa-key';
  let partner = await f.createPartner();
  let app = createWebServer(partner, join(f.directory, 'assets'));
  let origin = '';
  async function listen() {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  await listen();
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(origin.replace('http:', 'ws:') + '/api/chat/socket'), value => { view = value; }, () => {});
  let client = await connect();
  const post = (event: unknown) => fetch(origin + '/api/keet/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
  const event = (sequence: number, text: string, channel: 'dm' | 'group', trigger = true) => ({
    type: 'message', eventId: randomUUID(), sequence, timestamp: sequence,
    messageId: { deviceId: 'owned-peer', seq: sequence },
    destination: { kind: channel, groupName: channel === 'dm' ? 'Peer' : 'Room' },
    senderLabel: 'Alice', text, ...(trigger ? { trigger: channel === 'dm' ? 'dm' : 'mention' } : {}),
  });
  const visible = new Map<string, ChatMessage>();
  try {
    assert.equal((await post(event(1, 'native-only context sentinel', 'group', false))).status, 202);
    const group = { ...event(2, 'original **group** text', 'group'), senderLabel: '<img src=x onerror="unsafe()">',
      reactionContext: [{ targetMessageId: { deviceId: 'self', seq: 0 }, targetText: 'native-only context sentinel', emoji: '👍', externalCount: 1 }],
      images: [{ status: 'unavailable', mediaType: 'image/png' }] };
    const dm = { ...event(3, 'original DM caption', 'dm'), images: [{ status: 'available', mediaType: 'image/png', ref: `${randomUUID()}.png` }] };
    for (const entry of [group, dm]) {
      assert.equal((await post(entry)).status, 202);
      const id = `keet:webhook:${entry.eventId}`;
      await eventually(async () => view?.messages.some(m => m.id === id && m.delivery === 'consumed') === true);
      const m = view!.messages.find(m => m.id === id)!;
      assert.equal(m.text, entry.text + (entry.destination.kind === 'dm'
        ? '\n[Keet images: 1 attached; 0 unavailable.]'
        : '\n[Keet images: 1 present; 1 unavailable. Image bytes are not included in Group context.]'));
      assert.deepEqual(m.source, { kind: 'keet', channel: entry.destination.kind, senderLabel: entry.senderLabel, destination: entry.destination.groupName });
      assert.equal(m.operationId, id);
      assert.equal(m.delivery, (await partner.chatReceipt(id)).state);
      assert.equal(m.images?.length ?? 0, entry.destination.kind === 'dm' ? 1 : 0);
      assert.equal(m.role, 'user'); visible.set(id, m);
    }
    assert.equal(imageRequests.length, 1);
    assert.match(imageRequests[0]!, /Bearer owned-fake-kfa-key$/);
    const image = visible.get(`keet:webhook:${dm.eventId}`)!.images![0]!;
    const media = () => fetch(`${origin}/api/chat/media/${image.attachmentId}/original`);
    assert.deepEqual(Buffer.from(await (await media()).arrayBuffer()), bytes);
    const starts = (await f.requests()).filter(r => r.method === 'turn/start');
    assert.match(JSON.stringify(starts), /native-only context sentinel/);
    assert.doesNotMatch(JSON.stringify(view), /native-only context sentinel|owned-fake-kfa-key|reactionContext|localTime|deviceId/);
    await assert.rejects(client.submit({ operationId: randomUUID(), text: 'forged', source: { kind: 'keet', channel: 'dm', senderLabel: 'Forge', destination: 'Peer' } } as never));
    const webId = randomUUID(); await client.submit({ operationId: webId, text: 'ordinary web' });
    await eventually(async () => view?.messages.some(m => m.id === webId && m.delivery === 'consumed') === true);
    assert.equal(view!.messages.find(m => m.id === webId)!.source, undefined);
    client.close(); view = undefined; client = await connect();
    await eventually(async () => [...visible.keys()].every(id => view?.messages.some(m => m.id === id)));
    for (const [id, before] of visible) assert.deepEqual(view!.messages.find(m => m.id === id), before);
    client.close(); await app.close(); await partner.close();
    // Only later test-owned native metadata is seeded; Keet records came through real ingress.
    const store = new Store(partnerPaths(f.workspace).database);
    try { for (let n = 0; n < 51; n++) await store.ensureMessage(randomUUID(), Date.now()); }
    finally { await store.close(); }
    partner = await f.createPartner(); app = createWebServer(partner, join(f.directory, 'assets')); await listen();
    client = await connect(); await eventually(async () => !!view?.before);
    assert(!view!.messages.some(m => m.source?.kind === 'keet'));
    let cursor = view!.before;
    const historical: ChatMessage[] = [];
    while (cursor) { const page = await client.history(cursor); historical.push(...page.messages); cursor = page.before; }
    for (const [id, before] of visible) assert.deepEqual(historical.find(m => m.id === id), before);
    assert.deepEqual(Buffer.from(await (await media()).arrayBuffer()), bytes);
    assert.equal((await post(dm)).status, 202);
    assert.equal(imageRequests.length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, starts.length + 1);
  } finally {
    client.close(); await app.close(); await f.close();
    kfa.closeAllConnections(); await new Promise<void>(done => kfa.close(() => done()));
  }
});

test('shared reminder keeps native source and ordinary display text', async () => {
  const f = await fixture();
  let clock = Date.parse('2026-09-30T00:00:00Z');
  try {
    const alarm = createAlarm(partnerPaths(f.workspace).alarms, 'Bring tea', { kind: 'once', at: '2026-09-30T09:00:00+08:00' }, clock);
    clock += 61 * 60_000;
    const partner = await f.createPartner({ now: () => clock });
    const backend = createCodexChatBackend(partner);
    await eventually(async () => (await backend.read()).messages.some(m => m.source?.kind === 'reminder'));
    const m = (await backend.read()).messages.find(m => m.source?.kind === 'reminder')!;
    assert.equal(m.text, 'Bring tea');
    assert.deepEqual(m.source, { kind: 'reminder', reminderId: alarm.id, occurrenceId: m.id });
    assert.equal(m.role, 'user');
  } finally { await f.close(); }
});
