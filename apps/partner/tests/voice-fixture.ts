import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { parseVoiceServerEvent, type VoiceServerEvent } from '@lamplit/contracts/voice';
import type { VoiceDependencies } from '../runtime/voice.ts';

export async function voiceFixture(timeouts?: VoiceDependencies['timeouts'], assets?: string) {
  const f = await fixture();
  f.config.speech = { endpoint: 'http://unused-batch.invalid' }; f.credentials.speech = 'fixture-key';
  const state = { reject: 0, holdReady: false, holdFinish: false, malformed: false, unfinished: false, text: 'recognized final', calls: 0, closes: 0, frames: 0, bytes: 0, auth: '', events: [] as string[] };
  const provider = createServer(); const sockets = new WebSocketServer({ noServer: true });
  let providerSession: { ws: WebSocket; event: (name: string, payload: object) => void } | undefined;
  provider.on('upgrade', (req, socket, head) => {
    state.calls++; state.auth = req.headers.authorization ?? '';
    if (state.reject) { socket.end(`HTTP/1.1 ${state.reject} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    let taskId = '';
    const event = (name: string, payload: object = {}) => ws.send(JSON.stringify({ header: { event: name, task_id: taskId }, payload }));
    providerSession = { ws, event };
    const sentence = (id: number, text: string, final = true) => event('result-generated', { output: { sentence: { sentence_id: id, sentence_end: final, text } } });
    ws.on('error', () => {}); ws.on('close', () => state.closes++);
    ws.on('message', (raw, binary) => {
      if (binary) { state.frames++; state.bytes += raw instanceof ArrayBuffer ? raw.byteLength : Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : raw.length; state.events.push('pcm'); return; }
      const request = JSON.parse(raw.toString()); taskId = request.header.task_id; state.events.push(request.header.action);
      if (request.header.action === 'run-task') { if (!state.holdReady) event('task-started'); }
      else if (!state.holdFinish) {
        if (state.malformed) { ws.send('not json'); return; }
        sentence(2, ' final'); sentence(1, 'stale'); sentence(1, state.text.replace(/ final$/u, ''));
        sentence(1, 'late interim must not reopen final', false);
        if (state.unfinished) sentence(3, 'unfinished', false);
        event('task-finished');
      }
    });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const upstream = `ws://127.0.0.1:${(provider.address() as {port:number}).port}`;
  const partner = await f.createPartner();
  const app = createWebServer(partner, assets ?? `${f.directory}/assets`, { voice: {connect: key => new WebSocket(upstream, {headers: {Authorization: `Bearer ${key}`}}), ...(timeouts ? {timeouts} : {})} });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const clients = new Set<WebSocket>();
  return {f, partner, app, state, origin,
    async providerEvent(name: string, payload: object = {}) {
      if (!providerSession || providerSession.ws.readyState !== WebSocket.OPEN) throw new Error('Fixture provider is not connected');
      const { ws, event } = providerSession;
      // A pong fences prior provider messages through the real relay; rejection closes it instead.
      await new Promise<void>(resolve => {
        const done = () => { ws.off('pong', done); ws.off('close', done); resolve(); };
        ws.once('pong', done); ws.once('close', done);
        event(name, payload); ws.ping();
      });
      return ws.readyState === WebSocket.OPEN;
    },
    async client(originHeader: string | undefined = origin) {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/voice/stream`, originHeader ? {origin: originHeader} : {}); clients.add(ws);
      const events: VoiceServerEvent[] = []; ws.on('message', raw => events.push(parseVoiceServerEvent(raw.toString()))); ws.on('error', () => {});
      await once(ws, 'open');
      return {ws, events, async wait(type: VoiceServerEvent['type']) {await eventually(async () => events.some(e => e.type === type)); return events.find(e => e.type === type)!;} };
    },
    async close() {for (const ws of clients) ws.terminate(); if (app.server.listening) await app.close(); await f.close(); for (const ws of sockets.clients) ws.terminate(); sockets.close(); await new Promise<void>(resolve => provider.close(() => resolve()));},
  };
}
