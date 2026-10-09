// Test-owned actual Matrix ingress, SQLite, fake official engine and public socket.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { openChat } from '@lamplit/contracts/client';
import type { ChatMessage, ChatView } from '@lamplit/contracts';
import { fixture, eventually } from './fixture.ts';
import { matrixGateway } from './matrix-fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { matrixInputId, type MatrixEvent } from '../runtime/matrix.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { Store } from '../runtime/store.ts';
import type { Partner } from '../runtime/partner.ts';

type Incoming = { action: 'incoming'; id: string; senderId: string; senderDisplayName: string; roomId: string; text: string; createdAt: number; history?: boolean };
export async function matrixAcceptanceHost(assets: string, evidence?: string) {
  const gateway = await matrixGateway();
  let f = await fixture(), partner: Partner, off = () => {};
  let clock = Date.parse('2026-10-07T00:00:00Z'), evidenceIndex = 0;
  let first: Incoming | undefined, historical: Incoming[] = [];
  let control = { hold: false, completedText: '普通回复' };
  const listeners = new Set<() => void>(), submissions: string[] = [];
  let published: ChatView | undefined, observer: Awaited<ReturnType<typeof openChat>> | undefined;
  async function writeControl() {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path + '.next', JSON.stringify(control)); await rename(path + '.next', path);
  }
  async function start() {
    f.config.matrix = { endpoint: gateway.endpoint }; f.credentials.matrix = gateway.token;
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
  const app = createWebServer(facade, assets, { authorize: async request => request.headers.cookie?.includes('matrix-test-owner=1') === true });
  app.server.prependListener('request', (request, response) => {
    if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'matrix-test-owner=1; Path=/; SameSite=Strict');
  });
  const sockets = new Set<import('node:stream').Duplex>();
  app.server.on('upgrade', (request, socket) => {
    if (request.url === '/api/chat/socket') { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  async function observe() {
    observer?.close(); published = undefined;
    observer = await openChat(new WebSocket(origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Cookie: 'matrix-test-owner=1' } }) as unknown as globalThis.WebSocket, view => { published = view; }, () => {});
  }
  await observe();
  async function settled() {
    await eventually(async () => JSON.stringify(published) === JSON.stringify(await createCodexChatBackend(partner).read()));
  }
  async function publicHistory() {
    await settled();
    const messages: ChatMessage[] = [...published!.messages];
    let before = published!.before;
    while (before) { const page = await observer!.history(before); messages.unshift(...page.messages); before = page.before; }
    return messages;
  }
  async function incoming(input: Incoming) {
    control.hold = false; control.completedText = `fixture Matrix reply ${input.id}`; await writeControl();
    const event: MatrixEvent = { type: 'message', event_id: input.id, room_id: input.roomId, sender_id: input.senderId,
      sender_display_name: input.senderDisplayName, body: input.text, timestamp: input.createdAt, mentions: ['@self:test'], truncated: false };
    // Native buffered context is private; it must never enter ChatMessage.text/source.
    await partner.ingestMatrix({ ...event, event_id: `${input.id}-context`, body: 'native-only context sentinel', mentions: [] });
    const response = await fetch(origin + '/api/matrix/events', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'matrix-test-owner=1' }, body: JSON.stringify(event) });
    assert.equal(response.status, 202, await response.text());
    await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(matrixInputId(event)) && r.status === 'completed') && !(await partner.snapshot()).typing);
    control.hold = true; await writeControl();
  }
  async function reset() {
    observer?.close(); off(); await f.close(); f = await fixture(); first = undefined; historical = []; submissions.length = 0;
    clock = Date.parse('2026-10-07T00:00:00Z'); control = { hold: false, completedText: '普通回复' };
    await start(); await observe();
  }
  async function restart() {
    const before = await publicHistory();
    observer?.close(); off(); await partner.close();
    for (const socket of sockets) socket.destroy();
    await start(); await observe(); const after = await publicHistory();
    assert.deepEqual(after, before, 'durable public socket/history must survive process restart');
    return { before, after };
  }
  async function action(input: Incoming | { action: string }) {
    let restartProof: Awaited<ReturnType<typeof restart>> | undefined;
    if (input.action === 'reset') await reset();
    else if (input.action === 'incoming') {
      const entry = input as Incoming;
      if (entry.history) {
        if (!first || submissions.length) throw new Error('Seed history before browser submissions');
        const initial = first, older = [...historical, entry]; await reset();
        for (const item of older) await incoming(item);
        historical = older; off(); await partner.close();
        const store = new Store(partnerPaths(f.workspace).database);
        try { for (let n = 0; n < 31; n++) await store.ensureMessage(crypto.randomUUID(), clock); }
        finally { await store.close(); }
        await start(); await observe(); await incoming(initial); first = initial;
      } else { await incoming(entry); first ??= entry; }
    } else if (input.action === 'complete') {
      control.completedText = '普通回复'; control.hold = false; await writeControl();
      await eventually(async () => !(await partner.snapshot()).typing); control.hold = true; await writeControl();
    } else if (input.action === 'reminder') {
      const alarm = createAlarm(partnerPaths(f.workspace).alarms, '测试提醒', { kind: 'once', at: new Date(clock + 1000).toISOString() }, clock);
      clock += 2000; control.completedText = 'fixture reminder reply'; control.hold = false; await writeControl(); await partner.checkAlarms();
      await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(`alarm:${alarm.id}:${alarm.nextAt}`) && r.status === 'completed') && !(await partner.snapshot()).typing);
      control.hold = true; await writeControl();
    } else if (input.action === 'restart') restartProof = await restart();
    else if (input.action !== 'state') throw new Error('Unknown action');
    await settled();
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, `native-${++evidenceIndex}-${input.action}.json`), JSON.stringify({ action: input, requests: await f.requests(), published, submissions, restartProof }, null, 2));
    }
    return { submissions: [...submissions], ...(restartProof ? { restartProof } : {}) };
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
  return { origin, controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}/__test/matrix-source-ui`, action,
    async close() { observer?.close(); off(); await app.close(); await f.close(); await gateway.close(); controls.closeAllConnections(); await new Promise<void>(done => controls.close(() => done())); } };
}
if (process.argv[1] === import.meta.filename) {
  const host = await matrixAcceptanceHost(resolve(process.argv[2]!), process.argv[3] ? resolve(process.argv[3]) : undefined);
  console.log(JSON.stringify({ origin: host.origin, controlUrl: host.controlUrl }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().then(() => process.exit()); });
}
