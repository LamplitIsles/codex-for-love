// Isolated actual CFL ingress/storage/socket host; no shared DTO seeding or providers.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import sharp from 'sharp';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { Store } from '../runtime/store.ts';
import type { Partner } from '../runtime/partner.ts';

type Incoming = { action: 'incoming'; id: string; channel: 'dm' | 'group'; senderLabel: string; destination: string; text: string; history?: boolean; hasImage?: boolean; images?: unknown[] };
export async function keetAcceptanceHost(assets: string, evidence?: string) {
  let evidenceIndex = 0;
  let f = await fixture(), partner: Partner;
  let clock = Date.parse('2026-10-07T00:00:00Z'), sequence = 0;
  let off = () => {};
  const listeners = new Set<() => void>(), submissions: string[] = [];
  let first: Incoming | undefined;
  let historical: Incoming[] = [];
  let published: ChatView | undefined;
  let observer: Awaited<ReturnType<typeof openChat>> | undefined;
  let control = { hold: false, completedText: '普通回复' };
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#cc8844' } }).png().toBuffer();
  const kfa = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer owned-test-kfa') { response.writeHead(401).end(); return; }
    response.writeHead(200, { 'content-type': 'image/png' }).end(image);
  });
  kfa.listen(0, '127.0.0.1'); await once(kfa, 'listening');
  async function writeControl() {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path + '.next', JSON.stringify(control)); await rename(path + '.next', path);
  }
  async function start() {
    f.config.keet = { endpoint: `http://127.0.0.1:${(kfa.address() as { port: number }).port}` };
    f.credentials.keet = 'owned-test-kfa';
    await writeControl(); partner = await f.createPartner({ now: () => clock });
    off = partner.subscribe(() => { for (const listener of listeners) listener(); });
    for (const listener of listeners) listener();
  }
  await start();
  const facade = new Proxy({} as Partner, { get(_target, key) {
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
    if (key === 'submitShared') return async (input: Parameters<Partner['submitShared']>[0]) => {
      const receipt = await partner.submitShared(input); submissions.push(input.text); return receipt;
    };
    const value = partner[key as keyof Partner]; return typeof value === 'function' ? value.bind(partner) : value;
  } });
  const app = createWebServer(facade, assets, { authorize: async request => request.headers.cookie?.includes('keet-test-owner=1') === true });
  app.server.prependListener('request', (request, response) => {
    if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'keet-test-owner=1; Path=/; SameSite=Strict');
  });
  const sockets = new Set<import('node:stream').Duplex>();
  app.server.on('upgrade', (request, socket) => {
    if (request.url === '/api/chat/socket') { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  async function observe() {
    observer?.close(); published = undefined;
    observer = await openChat(new WebSocket(origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Cookie: 'keet-test-owner=1' } }) as unknown as globalThis.WebSocket, view => { published = view; }, () => {});
  }
  await observe();
  async function settled() {
    await eventually(async () => JSON.stringify(published) === JSON.stringify(await createCodexChatBackend(partner).read()));
  }
  async function incoming(input: Incoming) {
    control.hold = false; control.completedText = `fixture Keet reply ${input.id}`; await writeControl();
    // Buffered native context and reaction facts deliberately never enter the display DTO.
    if (input.channel === 'group') await partner.ingestKeet({ type: 'message', eventId: crypto.randomUUID(), sequence: ++sequence,
      messageId: { deviceId: 'fixture-peer', seq: sequence }, timestamp: clock, destination: { kind: 'group', groupName: input.destination },
      senderLabel: 'Context', text: 'native-only context sentinel' });
    const eventId = crypto.randomUUID();
    const response = await fetch(origin + '/api/keet/events', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'keet-test-owner=1' }, body: JSON.stringify({
      type: 'message', eventId, sequence: ++sequence, messageId: { deviceId: 'fixture-peer', seq: sequence }, timestamp: clock,
      destination: { kind: input.channel, groupName: input.destination }, senderLabel: input.senderLabel, text: input.text,
      trigger: input.channel === 'dm' ? 'dm' : 'mention',
      reactionContext: [{ targetMessageId: { deviceId: 'self', seq: 0 }, targetText: 'native-only context sentinel', emoji: '👍', externalCount: 1 }],
      ...(input.hasImage || input.images?.length ? { images: [{ status: 'available', mediaType: 'image/png', name: 'keet-original.png', ref: `${crypto.randomUUID()}.png` }] } : {}),
    }) });
    if (response.status !== 202) throw new Error(`Native ingress ${response.status}: ${await response.text()}`);
    await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(`keet:webhook:${eventId}`) && r.status === 'completed') && !(await partner.snapshot()).typing);
    control.hold = true; await writeControl();
    return (await partner.snapshot()).messages.find(m => m.id === `keet:webhook:${eventId}`)?.keet?.imageNote;
  }
  async function reset() {
    observer?.close(); off(); await f.close(); f = await fixture(); sequence = 0; first = undefined; historical = []; submissions.length = 0;
    control = { hold: false, completedText: '普通回复' }; await start(); await observe();
  }
  async function action(input: Incoming | { action: string }) {
    let imageNote: string | undefined;
    if (input.action === 'reset') await reset();
    else if (input.action === 'incoming') {
      const entry = input as Incoming;
      if (entry.history) {
        // The runner seeds history before opening UI. Re-admit in chronological order,
        // then create later empty native metadata to exercise actual bounded pagination.
        if (!first || submissions.length) throw new Error('Seed history before browser submissions');
        const initial = first, older = [...historical, entry]; await reset();
        for (const item of older) { const note = await incoming(item); if (item === entry) imageNote = note; }
        historical = older;
        off(); await partner.close();
        const store = new Store(partnerPaths(f.workspace).database);
        try { for (let n = 0; n < 31; n++) await store.ensureMessage(crypto.randomUUID(), clock); }
        finally { await store.close(); }
        await start(); await observe(); await incoming(initial); first = initial;
      } else { imageNote = await incoming(entry); first ??= entry; }
    } else if (input.action === 'complete') {
      control.completedText = '普通回复'; control.hold = false; await writeControl(); await eventually(async () => !(await partner.snapshot()).typing);
      control.hold = true; await writeControl();
    } else if (input.action === 'reminder') {
      const alarm = createAlarm(partnerPaths(f.workspace).alarms, '测试提醒', { kind: 'once', at: new Date(clock + 1000).toISOString() }, clock);
      clock += 2000; control.completedText = 'fixture reminder reply'; control.hold = false; await writeControl(); await partner.checkAlarms();
      await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(`alarm:${alarm.id}:${alarm.nextAt}`) && r.status === 'completed') && !(await partner.snapshot()).typing); control.hold = true; await writeControl();
    } else if (input.action !== 'state') throw new Error('Unknown action');
    await settled();
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, `native-${++evidenceIndex}-${input.action}.json`), JSON.stringify({ action: input, requests: await f.requests(), published, submissions }, null, 2));
    }
    return { submissions: [...submissions], ...(imageNote ? { imageNote } : {}) };
  }
  const controls = createServer(async (request, response) => {
    try {
      response.setHeader('content-type', 'application/json');
      if (request.url?.endsWith('/disconnect')) {
        for (const socket of sockets) socket.destroy(); await observe(); await settled();
        response.end(JSON.stringify({ disconnected: true })); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      response.end(JSON.stringify(await action(JSON.parse(Buffer.concat(chunks).toString()))));
    } catch (error) { console.error(error); response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
  });
  controls.listen(0, '127.0.0.1'); await once(controls, 'listening');
  return { origin, controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}/__test/keet`, action,
    async close() { observer?.close(); off(); await app.close(); await f.close(); kfa.closeAllConnections(); await Promise.all([new Promise<void>(done => kfa.close(() => done())), new Promise<void>(done => controls.close(() => done()))]); } };
}
if (process.argv[1] === import.meta.filename) {
  const host = await keetAcceptanceHost(resolve(process.argv[2]!), process.argv[3] ? resolve(process.argv[3]) : undefined); console.log(JSON.stringify({ origin: host.origin, controlUrl: host.controlUrl }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().then(() => process.exit()); });
}
