// Owned actual CFL ingress/storage/socket host; no shared DTO seeding or providers.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView, PostSource } from '@lamplit/contracts';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { Store } from '../runtime/store.ts';
import type { Partner } from '../runtime/partner.ts';
import { event, examples, postService } from './post-fixture.ts';
import { postInputId } from '../runtime/post.ts';

type Incoming = { action: 'incoming'; id: string; source: PostSource; text: string; createdAt: number; history?: boolean; images?: unknown[] };
export async function postAcceptanceHost(assets: string, evidence?: string) {
  const cleanup: Array<() => void | Promise<void>> = [];
  try { return await initializePostAcceptanceHost(assets, evidence, cleanup); }
  catch (error) {
    for (const close of cleanup.reverse()) try { await close(); } catch { /* preserve the setup error */ }
    throw error;
  }
}

async function initializePostAcceptanceHost(assets: string, evidence: string | undefined, cleanup: Array<() => void | Promise<void>>) {
  let evidenceIndex = 0;
  const post = await postService();
  cleanup.push(() => post.close());
  let f = await fixture(), partner: Partner;
  cleanup.push(() => f.close());
  let clock = Date.parse('2026-10-07T00:00:00Z'), sequence = 0;
  let off = () => {};
  cleanup.push(() => off());
  const listeners = new Set<() => void>(), submissions: string[] = [];
  let first: Incoming | undefined;
  let historical: Incoming[] = [];
  let published: ChatView | undefined;
  let observer: Awaited<ReturnType<typeof openChat>> | undefined;
  cleanup.push(() => observer?.close());
  let control = { hold: false, completedText: '普通回复' };
  async function writeControl() {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path + '.next', JSON.stringify(control)); await rename(path + '.next', path);
  }
  async function start() {
    f.appServer.env.HOME = f.directory;
    f.config.post = { endpoint: post.endpoint, agent_id: 'cfl' };
    f.credentials.post = post.token; f.credentials.post_receiver = post.receiver;
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
  const app = createWebServer(facade, assets, { authorize: async request => request.headers.cookie?.includes('post-test-owner=1') === true });
  cleanup.push(() => app.close());
  app.server.prependListener('request', (request, response) => {
    if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'post-test-owner=1; Path=/; SameSite=Strict');
  });
  const sockets = new Set<import('node:stream').Duplex>();
  app.server.on('upgrade', (request, socket) => {
    if (request.url === '/api/chat/socket') { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  async function observe() {
    observer?.close(); published = undefined;
    observer = await openChat(new WebSocket(origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Cookie: 'post-test-owner=1' } }) as unknown as globalThis.WebSocket, view => { published = view; }, () => {});
  }
  await observe();
  async function settled() {
    await eventually(async () => JSON.stringify(published) === JSON.stringify(await createCodexChatBackend(partner).read()));
  }
  async function incoming(input: Incoming) {
    if (input.source.conversationName && input.source.conversationName.length > 256) throw new Error('Native conversation name exceeds canonical UTF-16 bound');
    control.hold = false; control.completedText = ''; await writeControl();
    const e = event(`browser-${++sequence}`, input.source.platform);
    e.message.conversation = { id: input.source.conversationId, native_id: input.source.conversationId,
      type: input.source.conversationType, ...(input.source.conversationName ? { name: input.source.conversationName } : {}) };
    e.message.sender = { native_id: input.source.senderId, ...(input.source.senderDisplayName ? { name: input.source.senderDisplayName } : {}) };
    e.message.timestamp = input.createdAt;
    e.wake.reason = e.message.conversation.type === 'direct' ? 'direct_message' : 'mentioned';
    e.message.content = [{ type: 'text', text: input.text }];
    if (input.images?.length) e.message.content.push({ type: 'image', asset_id: e.message.assets[0]!.asset_id });
    else e.message.assets = [];
    post.conversation = { ...examples.tools.get_conversation.result, account_id: e.message.account_id,
      conversation_id: e.message.conversation.id, native_id: e.message.conversation.native_id, type: e.message.conversation.type,
      name: e.message.conversation.name };
    const response = await fetch(origin + '/api/post/events', { method: 'POST', headers: {
      'content-type': 'application/json', cookie: 'post-test-owner=1', authorization: `Bearer ${post.receiver}` }, body: JSON.stringify(e) });
    if (response.status !== 202) throw new Error(`Native ingress ${response.status}`);
    const id = postInputId(post.endpoint, e);
    await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(id) && r.status === 'completed') && !(await partner.snapshot()).typing);
    control.hold = true; await writeControl();
  }
  async function reset() {
    observer?.close(); off(); await f.close(); f = await fixture(); sequence = 0; first = undefined; historical = []; submissions.length = 0;
    control = { hold: false, completedText: '普通回复' }; await start(); await observe();
  }
  async function action(input: Incoming | { action: string }) {
    if (input.action === 'reset') await reset();
    else if (input.action === 'incoming') {
      const entry = input as Incoming;
      if (entry.history) {
        // The runner seeds history before opening UI. Re-admit in chronological order,
        // then create later empty native metadata to exercise actual bounded pagination.
        if (!first || submissions.length) throw new Error('Seed history before browser submissions');
        const initial = first, older = [...historical, entry]; await reset();
        for (const item of older) { await incoming(item); }
        historical = older;
        off(); await partner.close();
        const store = new Store(partnerPaths(f.workspace).database);
        try { for (let n = 0; n < 31; n++) await store.ensureMessage(crypto.randomUUID(), clock); }
        finally { await store.close(); }
        await start(); await observe(); await incoming(initial); first = initial;
      } else { await incoming(entry); first ??= entry; }
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
    return { submissions: [...submissions] };
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
  cleanup.push(async () => { controls.closeAllConnections(); if (controls.listening) await new Promise<void>(done => controls.close(() => done())); });
  controls.listen(0, '127.0.0.1'); await once(controls, 'listening');
  return { origin, controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}/__test/post-source-ui`, action,
    async close() { observer?.close(); off(); await app.close(); await f.close(); await post.close(); controls.closeAllConnections(); await new Promise<void>(done => controls.close(() => done())); } };
}
if (process.argv[1] === import.meta.filename) {
  const host = await postAcceptanceHost(resolve(process.argv[2]!), process.argv[3] ? resolve(process.argv[3]) : undefined); console.log(JSON.stringify({ origin: host.origin, controlUrl: host.controlUrl }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().catch(() => { process.exitCode = 1; }); });
}
