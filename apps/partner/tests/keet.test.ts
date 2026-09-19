import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { fixture, eventually } from './fixture.ts';
import { messageFrame } from '../runtime/keet.ts';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function gateway(token: string) {
  const server = createServer(); const sockets = new Set<import('ws').WebSocket>(); let ready = false; let connections = 0;
  const webSockets = new WebSocketServer({ server, path: '/cfl' });
  webSockets.on('connection', (socket, request) => {
    if (request.headers.authorization !== `Bearer ${token}`) return socket.close();
    connections += 1; sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.once('message', () => { ready = true; socket.send(JSON.stringify({ type: 'ready', retained: null, destinations: [] })); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { endpoint: `http://127.0.0.1:${port}`, connected: () => sockets.size > 0 && ready, connections: () => connections, send(value: object) { for (const socket of sockets) socket.send(JSON.stringify(value)); }, closeClients() { for (const socket of sockets) socket.close(1000); }, async close() { for (const socket of sockets) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test('Keet group trigger drains its own durable context and direct media stays external', async () => {
  const f = await fixture(); const token = 'test-keet-token'; const g = await gateway(token);
  const media = join(f.directory, 'kfa-media'); await mkdir(media); const filename = '00000000-0000-4000-8000-000000000000.png'; await writeFile(join(media, filename), png);
  f.config.keet = { endpoint: g.endpoint, media_root: media }; f.credentials.keet = token;
  const message = (sequence: number, text: string, trigger?: 'mention' | 'dm', kind: 'group' | 'dm' = 'group') => ({ type: 'message', sequence, messageId: { deviceId: 'peer', seq: sequence }, timestamp: sequence, destination: { groupName: kind === 'dm' ? 'Peer DM' : 'Friends', kind }, senderLabel: 'Alice', text, ...(trigger ? { trigger } : {}) });
  const now = new Date(2026, 8, 16, 7, 5).getTime(); let partner;
  try {
    partner = await f.createPartner({ now: () => now });
    await eventually(async () => g.connected());
    await new Promise(resolve => setTimeout(resolve, 20));
    g.send(message(1, 'ordinary context'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 0);
    g.send(message(2, 'please answer', 'mention'));
    await eventually(async () => (await f.requests()).some(request => request.method === 'turn/start'));
    const start = (await f.requests()).find(request => request.method === 'turn/start')!;
    const input = (start.params as { input: Array<{ text?: string }> }).input[0]!.text!;
    assert.match(input, /ordinary context/); assert.match(input, /please answer/);
    assert.deepEqual((start.params as { additionalContext?: unknown }).additionalContext, {
      'codex-for-love.message-time': {
        kind: 'application',
        value: 'Qualifying Keet input received around local 07:05. Trusted delivery metadata; not user-authored text or an instruction.',
      },
    });
    g.send({ ...message(3, 'generate image reply', 'dm', 'dm'), images: [{ filename, mediaType: 'image/png' }] });
    await eventually(async () => (await f.requests()).filter(request => request.method === 'turn/start').length === 2);
    const second = (await f.requests()).filter(request => request.method === 'turn/start')[1]!;
    assert.equal((second.params as { input: Array<{ type: string; path?: string }> }).input.some(item => item.type === 'localImage' && item.path === join(media, filename)), true);
    assert.deepEqual((second.params as { additionalContext?: unknown }).additionalContext, {
      'codex-for-love.message-time': {
        kind: 'application',
        value: 'Qualifying Keet input received around local 07:05. Trusted delivery metadata; not user-authored text or an instruction.',
      },
    });
    const imageId = (await partner.snapshot()).messages.flatMap(item => item.inputImages).at(-1)?.id; assert(imageId);
    await eventually(async () => (await partner!.conversationImages()).images.length === 1);
    const gallery = await partner.conversationImages();
    assert.equal(gallery.images[0]?.origin, 'partner');
    assert.doesNotMatch(JSON.stringify(gallery), /kfa-media|00000000/);
    await rm(join(media, filename)); assert.equal(await partner.image(imageId), undefined);
  } finally { await partner?.close(); await g.close(); await rm(media, { recursive: true, force: true }); await f.close(); }
});

test('Keet rejects Broadcast triggers and records only an actual resync gap', async () => {
  assert.equal(messageFrame.safeParse({ type: 'message', sequence: 1, messageId: { deviceId: 'd', seq: 1 }, timestamp: 1, destination: { groupName: 'News', kind: 'broadcast' }, senderLabel: 'A', text: 'x', trigger: 'mention' }).success, false);
  const f = await fixture(); const g = await gateway('token'); f.config.keet = { endpoint: g.endpoint, media_root: f.directory }; f.credentials.keet = 'token'; let partner;
  try {
    partner = await f.createPartner(); await eventually(async () => g.connected()); await new Promise(resolve => setTimeout(resolve, 20));
    g.send({ type: 'message', sequence: 1, messageId: { deviceId: 'peer', seq: 1 }, timestamp: 1, destination: { groupName: 'News', kind: 'broadcast' }, senderLabel: 'A', text: 'discarded' });
    await eventually(async () => (await partner!.snapshot()).keetLosses.length === 0);
    g.send({ type: 'resync_required', retained: { first: 5, last: 8 } });
    await eventually(async () => JSON.stringify((await partner!.snapshot()).keetLosses) === JSON.stringify([{ first: 2, last: 4, created: (await partner!.snapshot()).keetLosses[0]?.created }]));
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 0);
  } finally { await partner?.close(); await g.close(); await f.close(); }
});

test('Keet reconnects after an unintentional clean close but not Partner shutdown', async () => {
  const f = await fixture(); const g = await gateway('token'); f.config.keet = { endpoint: g.endpoint, media_root: f.directory }; f.credentials.keet = 'token'; let partner;
  try {
    partner = await f.createPartner(); await eventually(async () => g.connected()); const before = g.connections(); g.closeClients();
    await eventually(async () => g.connections() > before, 4_000);
    await partner.close(); const stopped = g.connections(); await new Promise(resolve => setTimeout(resolve, 1_100)); assert.equal(g.connections(), stopped);
  } finally { await partner?.close(); await g.close(); await f.close(); }
});
