// Test-owned actual Partner/Node host. Controls touch only fixture state and fake upstreams.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';
import type { Partner } from '../runtime/partner.ts';

export async function textVoiceHost(assets: string, sentenceEvidence?: string) {
  let f = await fixture(), partner: Partner;
  const listeners = new Set<() => void>(); let off = () => {};
  const chats = new Set<import('node:stream').Duplex>();
  const control = { hold: true, completedText: '完整回复' };
  async function writeControl() {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path + '.next', JSON.stringify(control)); await rename(path + '.next', path);
  }
  async function reset(seed = true) {
    off(); await f.close(); f = await fixture();
    control.hold = true; control.completedText = '完整回复'; await writeControl();
    if (sentenceEvidence) {
      f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
      if (!seed) await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: `sentence-${crypto.randomUUID()}`, next: 1, turns: [] }));
      if (seed) {
        const texts = ['更早第一行。\n更早第二行。', ...Array.from({ length: 14 }, (_, i) => `history filler ${i}`), '历史第一行。同行第二句。\n历史第二行。'];
        const turns = texts.map((text, i) => ({ id: `seed-${i}`, status: 'completed', itemsView: 'full', startedAt: 1700000000 + i, completedAt: 1700000001 + i, error: null,
          items: [{ type: 'userMessage', id: `seed-user-${i}`, clientId: `seed-input-${i}`, content: [{ type: 'text', text: `Test-owned history ${i}` }] },
            { type: 'reasoning', id: `seed-reasoning-${i}`, summary: ['CFL_REASONING_PRIVATE_SENTINEL'], content: ['CFL_REASONING_PRIVATE_SENTINEL'] },
            { type: 'agentMessage', id: `seed-answer-${i}`, text, phase: 'final_answer' }] }));
        await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: `sentence-${crypto.randomUUID()}`, next: 100, turns }));
      }
    }
    partner = await f.createPartner(); off = partner.subscribe(() => { for (const listener of listeners) listener(); });
    for (const listener of listeners) listener();
    // Replacing the Partner also replaces its chat subscriptions. Reconnect
    // existing clients only after the new instance is ready.
    for (const socket of chats) socket.destroy();
  }
  await reset();
  const facade = new Proxy({} as Partner, { get(_target, key) {
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const value = partner[key as keyof Partner]; return typeof value === 'function' ? value.bind(partner) : value;
  } });
  const owner = (request: import('node:http').IncomingMessage) => request.headers.cookie?.includes('native-test-owner=1') === true;
  const app = createWebServer(facade, assets, { authorize: async request => owner(request) });
  const requestHandler = app.server.listeners('request')[0]!;
  app.server.removeAllListeners('request');
  app.server.on('request', (request, response) => {
    if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'native-test-owner=1; Path=/; SameSite=Strict');
    requestHandler.call(app.server, request, response);
  });
  app.server.on('upgrade', (request, socket) => { if (request.url === '/api/chat/socket') { chats.add(socket); socket.on('close', () => chats.delete(socket)); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  async function sentenceState(completed = false) {
    const native = await f.nativeState();
    return { held: !!native.active, generationId: native.active ?? null, itemId: native.active ? native.streamingItem : null,
      executions: (await f.requests()).filter(r => r.method === 'turn/start').length, completed, sessionId: (await partner.snapshot()).sessionId };
  }
  async function sentenceAction(input: { action: string; text?: string }) {
    const native = await f.nativeState();
    if (input.action === 'reset' || input.action === 'session') await reset(input.action === 'reset');
    else if (input.action === 'start') {
      if (native.active) throw new Error('Provider already held');
      const operationId = crypto.randomUUID();
      await partner.submitNativeDelivery({ operationId, text: 'Test-owned sentence acceptance input' });
      await eventually(async () => {
        const current = await f.nativeState();
        return !!current.active && !!current.streamingItem && current.streamingItem !== native.streamingItem;
      });
      await f.streamCommand({ action: 'advance', text: input.text ?? '' });
    } else if (input.action === 'advance' || input.action === 'complete') {
      const turn = native.turns.find((t: { id: string }) => t.id === native.active);
      const item = turn?.items.find((i: { id: string }) => i.id === native.streamingItem);
      if (!item || typeof input.text !== 'string' || !input.text.startsWith(item.text)) throw new Error('Provider must extend a held prefix');
      await f.streamCommand({ action: input.action, text: input.text });
    } else if (input.action === 'stop') {
      if (!native.active) throw new Error('No held execution');
      await partner.chatStop(native.active);
    } else if (input.action === 'fail') {
      if (!native.active) throw new Error('No held execution');
      await f.streamCommand({ action: 'fail' });
    } else if (input.action !== 'status') throw new Error('Unknown sentence control');
    await partner.snapshot();
    if (input.action === 'start' || input.action === 'advance') await eventually(async () => partner.streamingReply()?.text === input.text);
    if (['complete', 'stop', 'fail'].includes(input.action)) await eventually(async () => !(await partner.snapshot()).typing);
    const status = await sentenceState(input.action === 'complete');
    console.log(JSON.stringify({ action: input.action, ...status }));
    if (sentenceEvidence) {
      const observation = { action: input.action, status, native: await f.nativeState(), requests: await f.requests() };
      await writeFile(join(sentenceEvidence, 'native-current.json'), JSON.stringify(observation, null, 2));
      await appendFile(join(sentenceEvidence, 'native-observations.jsonl'), JSON.stringify(observation) + '\n');
    }
    return status;
  }
  async function state() { return { sessionId: (await partner.snapshot()).sessionId, executions: (await f.requests()).filter(r => r.method === 'turn/start').length, takes: [] }; }
  async function action(input: { action: string; text?: string; hold?: boolean; holdReady?: boolean; availability?: string; takeId?: string; code?: string }) {
    if (input.action === 'reset') await reset();
    else if (input.action === 'complete') {
      control.completedText = input.text ?? '完整回复'; control.hold = false; await writeControl();
      await eventually(async () => !(await partner.snapshot()).typing);
      control.hold = true; await writeControl();
    } else if (input.action === 'disconnect') for (const socket of chats) socket.destroy();
    else if (input.action !== 'state') throw new Error('Unknown test action');
    return state();
  }
  const controls = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      let result;
      if (sentenceEvidence && request.url?.endsWith('/disconnect')) {
        for (const socket of chats) socket.destroy();
        await eventually(async () => chats.size === 0);
        result = { disconnected: true };
      } else result = sentenceEvidence ? await sentenceAction(input) : await action(input);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { console.error(error); response.writeHead(500); response.end(String(error)); }
  });
  controls.listen(0, '127.0.0.1'); await once(controls, 'listening');
  return { origin: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}`,
    async close() { off(); await app.close(); await f.close(); await new Promise<void>(done => controls.close(() => done())); } };
}
if (process.argv[1] === import.meta.filename) {
  const h = await textVoiceHost(resolve(process.argv[2]!), process.argv[3] ? resolve(process.argv[3]) : undefined); console.log(JSON.stringify(h));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void h.close().then(() => process.exit()); });
}
