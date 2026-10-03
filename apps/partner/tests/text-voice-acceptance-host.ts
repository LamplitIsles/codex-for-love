// Test-owned actual Partner/Node host. Controls touch only fixture state and fake upstreams.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import type { Partner } from '../runtime/partner.ts';

type Take = { id: string; bytes: number; controls: string[]; closed: boolean; finishedBytes: number; firstFrame: number[]; nonzero: boolean; upstream?: WebSocket; taskId?: string; text: string; hold: boolean };
export async function textVoiceHost(assets: string) {
  let f = await fixture(), partner: Partner;
  let speech = { text: 'recognized final', hold: false, availability: 'enabled' };
  const takes: Take[] = [], pending: Take[] = [];
  const listeners = new Set<() => void>(); let off = () => {};
  const control = { hold: true, completedText: '完整回复' };
  async function writeControl() {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path + '.next', JSON.stringify(control)); await rename(path + '.next', path);
  }
  async function reset() {
    off(); await f.close(); f = await fixture();
    speech = { text: 'recognized final', hold: false, availability: 'enabled' };
    takes.length = pending.length = 0;
    f.config.speech = { endpoint: 'http://127.0.0.1/unused-batch' }; f.credentials.speech = 'synthetic-fixture-key';
    control.hold = true; control.completedText = '完整回复'; await writeControl();
    partner = await f.createPartner(); off = partner.subscribe(() => { for (const listener of listeners) listener(); });
    for (const listener of listeners) listener();
  }
  await reset();
  const facade = new Proxy({} as Partner, { get(_target, key) {
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const value = partner[key as keyof Partner]; return typeof value === 'function' ? value.bind(partner) : value;
  } });
  function result(take: Take, text: string) {
    if (take.upstream?.readyState !== WebSocket.OPEN) return;
    take.upstream.send(JSON.stringify({ header: { event: 'result-generated', task_id: take.taskId }, payload: { output: { sentence: { sentence_id: 1, sentence_end: true, text } } } }));
    take.upstream.send(JSON.stringify({ header: { event: 'task-finished', task_id: take.taskId }, payload: {} }));
  }
  const provider = createServer(), upstreams = new WebSocketServer({ noServer: true });
  provider.on('upgrade', (req, socket, head) => upstreams.handleUpgrade(req, socket, head, ws => upstreams.emit('connection', ws)));
  upstreams.on('connection', ws => {
    const take = pending.shift()!; take.upstream = ws; ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const request = JSON.parse(raw.toString()); take.taskId = request.header.task_id;
      if (request.header.action === 'run-task') ws.send(JSON.stringify({ header: { event: 'task-started', task_id: take.taskId }, payload: {} }));
      else if (!take.hold) result(take, take.text);
    });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const upstream = `ws://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const owner = (request: import('node:http').IncomingMessage) => request.headers.cookie?.includes('native-test-owner=1') === true;
  const app = createWebServer(facade, assets, { authorize: async request => owner(request), voice: {
    connect: () => new WebSocket(upstream),
    observe(client) {
      const take: Take = { id: crypto.randomUUID(), bytes: 0, controls: [], closed: false, finishedBytes: 0, firstFrame: [], nonzero: false, text: speech.text, hold: speech.hold };
      takes.push(take); pending.push(take);
      client.on('message', (raw, binary) => {
        if (!binary) { const type = JSON.parse(raw.toString()).type; take.controls.push(type); if (type === 'finish') take.finishedBytes = take.bytes; }
        else {
          const frame = raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw;
          take.bytes += frame.length; if (!take.firstFrame.length) take.firstFrame = Array.from(frame);
          if (frame.some(byte => byte !== 0)) take.nonzero = true;
        }
      });
      client.on('close', () => { take.closed = true; });
    },
  } });
  // Failure is injected after native auth; no synthetic capability response.
  const requestHandler = app.server.listeners('request')[0]!;
  app.server.removeAllListeners('request');
  app.server.on('request', (request, response) => {
    if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'native-test-owner=1; Path=/; SameSite=Strict');
    if (request.url === '/api/voice/capability' && owner(request) && speech.availability === 'unreachable') { response.writeHead(503); response.end(); return; }
    requestHandler.call(app.server, request, response);
  });
  const chats = new Set<import('node:stream').Duplex>();
  app.server.on('upgrade', (request, socket) => { if (request.url === '/api/chat/socket') { chats.add(socket); socket.on('close', () => chats.delete(socket)); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  async function state() { return { sessionId: (await partner.snapshot()).sessionId, executions: (await f.requests()).filter(r => r.method === 'turn/start').length, takes: takes.map(({ upstream, taskId, text, hold, ...take }) => take) }; }
  async function action(input: { action: string; text?: string; hold?: boolean; availability?: string; takeId?: string; code?: string }) {
    if (input.action === 'reset') await reset();
    else if (input.action === 'complete') {
      control.completedText = input.text ?? '完整回复'; control.hold = false; await writeControl();
      await eventually(async () => !(await partner.snapshot()).typing);
      control.hold = true; await writeControl();
    } else if (input.action === 'speech') {
      if (input.text !== undefined) speech.text = input.text;
      if (input.hold !== undefined) speech.hold = input.hold;
      if (input.availability !== undefined) { speech.availability = input.availability; f.config.speech = input.availability === 'disabled' ? undefined : { endpoint: 'http://127.0.0.1/unused-batch' }; }
    } else if (input.action === 'disconnect') for (const socket of chats) socket.destroy();
    else if (input.action === 'result') result(takes.find(t => t.id === input.takeId)!, input.text!);
    else if (input.action === 'error') {
      const take = takes.find(t => t.id === input.takeId)!;
      take.upstream?.send(JSON.stringify({ header: { event: 'task-failed', task_id: take.taskId }, payload: {} }));
    } else if (input.action !== 'state') throw new Error('Unknown test action');
    return state();
  }
  const controls = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await action(JSON.parse(Buffer.concat(chunks).toString()))));
    } catch (error) { console.error(error); response.writeHead(500); response.end(String(error)); }
  });
  controls.listen(0, '127.0.0.1'); await once(controls, 'listening');
  return { origin: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}`,
    async close() { off(); await app.close(); await f.close(); for (const ws of upstreams.clients) ws.terminate(); upstreams.close(); await Promise.all([new Promise<void>(done => provider.close(() => done())), new Promise<void>(done => controls.close(() => done()))]); } };
}
if (process.argv[1] === import.meta.filename) {
  const h = await textVoiceHost(resolve(process.argv[2]!)); console.log(JSON.stringify(h));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void h.close().then(() => process.exit()); });
}
