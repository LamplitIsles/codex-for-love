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
import { createWebServer } from '../runtime/server.ts';

async function harness(summary = false, failAdmission = false) {
  const f = await fixture();
  if (summary) f.appServer.env.FAKE_SUMMARY_START = 'true';
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
  const connect = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`);
    socket.addEventListener('message', event => { if (dropIncoming) event.stopImmediatePropagation(); });
    return openChat(socket, value => { view = value; }, () => {});
  };
  let client = await connect();
  return { f, partner, control, get client() { return client; }, get view() { return view; },
    dropReplies() { dropIncoming = true; },
    async reconnect() { client.close(); dropIncoming = false; client = await connect(); },
    async close() { await control([], false); client.close(); await app.close(); await f.close(); } };
}

async function promptly<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Receipt/view blocked behind held native work')), 2000); })]); }
  finally { clearTimeout(timer!); }
}

test('durable WS receipts, concurrent admission and reconnect do not wait for native start/steer', async () => {
  const h = await harness();
  try {
    await h.control(['turn/start']);
    const first = { operationId: crypto.randomUUID(), text: 'saved while start held' };
    assert.equal((await promptly(h.client.submit(first))).state, 'accepted');
    assert.equal(h.view!.activeTurnId, null, 'no activity before native evidence');
    await eventually(async () => (await h.f.requests()).some(r => r.method === 'turn/start'));
    const second = { operationId: crypto.randomUUID(), text: 'saved behind first execution' };
    assert.equal((await promptly(h.client.submit(second))).state, 'accepted');
    assert.equal((await promptly(h.client.submit(first))).state, 'accepted');
    await assert.rejects(h.client.submit({ ...first, text: 'conflict' }));
    const bad = { operationId: crypto.randomUUID(), text: '', images: [{ attachmentId: 'a'.repeat(64), name: 'missing.png', mediaType: 'image/png' as const, availability: 'available' as const }] };
    await assert.rejects(h.client.submit(bad));
    assert.equal((await h.client.lookup(bad.operationId)).state, 'missing');
    await h.reconnect();
    assert.equal((await promptly(h.client.lookup(first.operationId))).state, 'accepted', 'lookup after lost connection uses committed identity');
    await h.control(['turn/steer']);
    await eventually(async () => !!h.view?.activeTurnId);
    await eventually(async () => (await h.f.requests()).some(r => r.method === 'turn/steer'));
    const third = { operationId: crypto.randomUUID(), text: 'saved while steer held' };
    assert.equal((await promptly(h.client.submit(third))).state, 'accepted');
    await h.control([]);
    await eventually(async () => (await h.client.lookup(third.operationId)).state === 'consumed');
    assert.equal((await h.f.requests()).filter(r => r.method === 'turn/start').length, 1);
    assert.equal((await h.f.requests()).filter(r => r.method === 'turn/steer').length, 2);
    assert.equal((await h.client.stop(h.view!.activeTurnId!)).stopped, true);
  } finally { await h.close(); }
});

test('native typing reaches WS while history is held, and completed reply arrives once', async () => {
  const h = await harness(true);
  try {
    await h.control(['thread/items/list']);
    const input = { operationId: crypto.randomUUID(), text: 'summary native start' };
    const receipt = h.client.submit(input);
    await eventually(async () => (await h.f.requests()).some(r => r.method === 'thread/items/list'));
    await promptly(receipt);
    await eventually(async () => !!h.view?.activeTurnId, 2000);
    assert.equal(h.view!.messages.filter(m => m.role === 'agent').length, 0);
    await h.reconnect();
    assert.ok(h.view!.activeTurnId, 'reconnect read also bypasses history wait');
    await h.control([]);
    await eventually(async () => (await h.client.lookup(input.operationId)).state === 'consumed');
    await h.control([], false);
    await eventually(async () => h.view?.activeTurnId === null && h.view.messages.some(m => m.role === 'agent'));
    assert.equal(h.view!.messages.filter(m => m.role === 'agent').length, 1);
    await h.reconnect();
    assert.equal(h.view!.messages.filter(m => m.role === 'agent').length, 1);
  } finally { await h.close(); }
});

test('accepted inputs survive shutdown with a held attempt and queued input without automatic replay', async () => {
  const f = await fixture();
  f.appServer.env.FAKE_HOLD_METHOD = 'turn/start';
  let partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'ambiguous attempt' };
  const second = { operationId: crypto.randomUUID(), text: 'retained before execution' };
  try {
    assert.equal((await promptly(partner.submitShared(first))).state, 'accepted');
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/start'));
    assert.equal((await promptly(partner.submitShared(second))).state, 'accepted');
    await promptly(partner.close());
    f.appServer.env.FAKE_HOLD_METHOD = '';
    partner = await f.createPartner();
    for (const input of [first, second]) {
      assert.equal((await partner.chatReceipt(input.operationId)).state, 'uncertain');
      assert.equal((await partner.submitShared(input)).state, 'uncertain');
      await assert.rejects(partner.submitShared({ ...input, text: 'changed retry' }));
    }
    assert.equal((await partner.sharedRecovery()).length, 2);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 0);
  } finally { await partner.close(); await f.close(); }
});

test('lost WS acknowledgement resolves by lookup without executing the same operation twice', async () => {
  const h = await harness();
  try {
    await h.control(['turn/start']);
    h.dropReplies();
    const input = { operationId: crypto.randomUUID(), text: 'saved but acknowledgement lost' };
    let acknowledged = false;
    const lost = h.client.submit(input).then(() => { acknowledged = true; }, () => {});
    await eventually(async () => (await h.partner.chatReceipt(input.operationId)).state === 'accepted');
    assert.equal(acknowledged, false);
    await h.reconnect(); await lost;
    assert.equal((await promptly(h.client.lookup(input.operationId))).state, 'accepted');
    assert.equal((await promptly(h.client.submit(input))).state, 'accepted');
    await h.control([]);
    await eventually(async () => (await h.client.lookup(input.operationId)).state === 'consumed');
    assert.equal((await h.f.requests()).filter(r => r.method === 'turn/start').length, 1);
  } finally { await h.close(); }
});


test('failed SQLite admission rolls back input and fingerprint without an accepted receipt', async () => {
  const h = await harness(false, true);
  try {
    const failed = { operationId: crypto.randomUUID(), text: 'must roll back' };
    await assert.rejects(h.client.submit(failed));
    assert.equal((await h.client.lookup(failed.operationId)).state, 'missing');
    assert.equal((await h.partner.snapshot()).messages.length, 0);
    // A leaked immutable fingerprint would incorrectly turn this into success.
    await assert.rejects(h.client.submit(failed));
    assert.equal((await h.f.requests()).filter(r => r.method === 'turn/start').length, 0);
  } finally { await h.close(); }
});
