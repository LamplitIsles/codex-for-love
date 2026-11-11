import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { join } from 'node:path';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';

async function harness(summary = false, failAdmission = false, stream = false) {
  const f = await fixture();
  if (summary) f.appServer.env.FAKE_SUMMARY_START = 'true';
  if (stream) f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  if (failAdmission) {
    const paths = partnerPaths(f.workspace);
    await mkdir(paths.managedRoot, { recursive: true });
    const seed = new Store(paths.database); await seed.close();
    const db = new DatabaseSync(paths.database);
    try { db.exec("CREATE TRIGGER fail_shared_admission BEFORE INSERT ON message_meta BEGIN SELECT RAISE(ABORT, 'test-owned storage failure'); END"); }
    finally { db.close(); }
  }
  const control = async (holdMethods: string[], hold = true) => {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(`${path}.next`, JSON.stringify({ hold, holdMethods }));
    await rename(`${path}.next`, path);
  };
  await control([]);
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as { port: number }).port;
  let view: ChatView | undefined;
  let dropIncoming = false;
  let socket: WebSocket;
  const calls: string[] = [];
  const connect = () => {
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`);
    socket.addEventListener('message', event => { if (dropIncoming) event.stopImmediatePropagation(); });
    const send = socket.send.bind(socket);
    socket.send = data => { calls.push(String(data)); send(data); };
    return openChat(socket, value => { view = value; }, () => {});
  };
  let client = await connect();
  return { f, partner, control, get client() { return client; }, get view() { return view; }, get socket() { return socket; }, calls,
    dropReplies() { dropIncoming = true; },
    async reconnect() { client.close(); dropIncoming = false; client = await connect(); },
    async close() { await control([], false); client.close(); await app.close(); await f.close(); } };
}

async function promptly<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Receipt/view blocked behind held native work')), 2000); })]); }
  finally { clearTimeout(timer!); }
}

test('native typing reaches WS while history is held, and completed reply arrives once', async () => {
  const h = await harness(true);
  try {
    await h.control(['thread/items/list']);
    const input = { operationId: crypto.randomUUID(), text: 'summary native start' };
    const receipt = h.client.submit(input).catch(() => null);
    await eventually(async () => (await h.f.requests()).some(r => r.method === 'thread/items/list'));
    await promptly(receipt);
    await eventually(async () => !!h.view?.activeTurnId, 2000);
    assert.equal(h.view!.messages.filter(m => m.role === 'agent').length, 0);
    await h.reconnect();
    assert.ok(h.view!.activeTurnId, 'reconnect read also bypasses history wait');
    await h.control([]);
    await eventually(async () => await h.f.consumed(input.operationId));
    assert.equal((await h.client.lookup(input.operationId))?.state, 'submitted');
    await h.control([], false);
    await eventually(async () => h.view?.activeTurnId === null && h.view.messages.some(m => m.role === 'agent'));
    assert.equal(h.view!.messages.filter(m => m.role === 'agent').length, 1);
    await h.reconnect();
    assert.equal(h.view!.messages.filter(m => m.role === 'agent').length, 1);
  } finally { await h.close(); }
});

test('shared Node connection stays quiet beyond the former heartbeat and still receives native updates', async () => {
  const h = await harness();
  try {
    await h.f.holdProvider(true);
    const initial = h.calls.length;
    await new Promise(resolve => setTimeout(resolve, 16_000));
    assert.equal(h.calls.length, initial, 'idle must not send catalogue or replacement probes');
    const input = { operationId: crypto.randomUUID(), text: 'test-owned quiet connection update' };
    await h.client.submit(input).catch(() => {});
    await eventually(async () => !!h.view?.activeTurnId);
    await h.f.holdProvider(false);
    await eventually(async () => !!h.view?.messages.some(m => m.role === 'agent'));
    await h.reconnect();
    assert.equal((await h.client.lookup(input.operationId))?.state, 'submitted');
    assert.equal((await h.f.requests()).filter(r => r.method === 'turn/start').length, 1);
  } finally { await h.close(); }
});
