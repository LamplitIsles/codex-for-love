import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { openChat } from '@lamplit/contracts/client';
import { createChatHost } from '@lamplit/contracts/server';
import type { ChatView } from '@lamplit/contracts';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';

test('chat subscription exposes the scoped host lifecycle', async () => {
  const f = await fixture();
  const partner = await f.createPartner();
  const subscription = createCodexChatBackend(partner).subscribe(() => {});
  try {
    assert.equal(typeof subscription.scope, 'symbol');
    assert.equal(typeof subscription.close, 'function');
  } finally {
    if (typeof subscription === 'function') (subscription as () => void)();
    else subscription.close();
    await f.close();
  }
});

test('the first visible delta keeps its started position before a later consumed steer', { timeout: 25_000 }, async () => {
  const f = await fixture();
  f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  const partner = await f.createPartner();
  try {
    const first = crypto.randomUUID();
    await partner.submit(first, 'initial input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    const second = crypto.randomUUID();
    await partner.submitNativeDelivery({ operationId: second, text: 'later steer' });
    await eventually(async () => (await partner.lookupNativeDelivery(second))?.state === 'submitted');
    await eventually(async () => await f.consumed(second));
    await eventually(async () => (await partner.snapshot()).results.some(result => result.sourceIds.includes(second)));
    await f.streamCommand({ action: 'advance', text: 'first visible line\n' });
    const backend = createCodexChatBackend(partner);
    await eventually(async () => (await backend.read()).messages.some(message => message.text === 'first visible line\n'));
    const messages = (await backend.read()).messages;
    const reply = messages.find(message => message.text === 'first visible line\n')!;
    assert.deepEqual(messages.map(message => message.id), [first, reply.id, second]);
  } finally { await f.close(); }
});

test('a native reply during initial host read is present in the first view', { timeout: 25_000 }, async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner();
  const id = crypto.randomUUID(); await partner.submit(id, 'initial input');
  await eventually(async () => !!(await f.nativeState()).streamingItem);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const snapshot = partner.snapshot.bind(partner); let held = false;
  partner.snapshot = async (...args) => { const value = await snapshot(...args); if (!held) { held = true; entered(); await gate; } return value; };
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: ChatView | undefined;
  const views: ChatView[] = [];
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    const connecting = openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), value => { view = value; views.push(structuredClone(value)); }, () => {});
    await reading;
    await f.streamCommand({ action: 'advance', text: 'during initial read\n' });
    release(); client = await connecting;
    await eventually(async () => view?.messages.some(message => message.text === 'during initial read\n') === true);
    assert.ok(views[0]?.messages.some(message => message.text === 'during initial read\n'));
    assert.deepEqual(view!.messages.map(message => message.id), [id, partner.streamingReply()!.id]);
  } finally { release(); client?.close(); await app.close(); await f.close(); }
});

test('cancelling initial host read closes its subscription without cancelling an accepted input', { timeout: 25_000 }, async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner();
  const id = crypto.randomUUID();
  await partner.submitNativeDelivery({ operationId: id, text: 'retained' });
  await eventually(async () => (await partner.lookupNativeDelivery(id))?.state === 'submitted');
  await eventually(async () => (await f.requests()).some(request => request.method === 'turn/start'));
  let release!: () => void, entered!: () => void, finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  const snapshot = partner.snapshot.bind(partner);
  partner.snapshot = async (...args) => { entered(); await gate; try { return await snapshot(...args); } finally { finished(); } };
  const subscribe = partner.subscribeChat.bind(partner); let subscriptions = 0;
  partner.subscribeChat = listener => { subscriptions++; const off = subscribe(listener); return () => { subscriptions--; off(); }; };
  const controller = new AbortController();
  try {
    const opening = createChatHost(createCodexChatBackend(partner), undefined, { signal: controller.signal });
    await reading; controller.abort();
    await assert.rejects(opening, /cancelled/i);
    assert.equal(subscriptions, 0);
    release(); await done;
    assert.equal((await partner.lookupNativeDelivery(id))?.state, 'submitted');
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 1);
  } finally { release(); await f.close(); }
});

for (const scenario of [
  { timing: 'none', followup: 'none' },
  { timing: 'during', followup: 'delta' },
  { timing: 'during', followup: 'completed' },
  { timing: 'after', followup: 'delta' },
  { timing: 'after', followup: 'completed' },
] as const) test(`a ${scenario.followup} ${scenario.timing} a failed structural read recovers on a new socket`, { timeout: 30_000 }, async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner();
  const snapshot = partner.snapshot.bind(partner);
  let armed = false, failures = 0, reads = 0;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  partner.snapshot = async (...args) => {
    reads++;
    if (armed && partner.streamingReply()?.text === 'first line\n') {
      armed = false; failures++;
      if (scenario.timing === 'during') { entered(); await gate; }
      throw new Error('Test-owned first structural read failure');
    }
    return snapshot(...args);
  };
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (!(args[0] instanceof Error && args[0].message === 'Test-owned first structural read failure')) originalError(...args);
  };
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`;
  let view: ChatView | undefined;
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  let offObservation: (() => void) | undefined;
  try {
    const socket = new WebSocket(url);
    const closed = once(socket, 'close');
    client = await openChat(socket, value => { view = value; }, () => {});
    const id = crypto.randomUUID();
    await client.submit({ operationId: id, text: 'input' }).catch(() => {});
    await eventually(async () => !!(await f.nativeState()).streamingItem && view?.messages.some(message => message.id === id) === true);
    const native = await f.nativeState();
    const item = native.turns.find((turn: { id: string }) => turn.id === native.active).items.find((value: { id: string }) => value.id === native.streamingItem);
    armed = true;
    await f.streamCommand({ action: 'advance', text: 'first line\n' });
    if (scenario.timing === 'during') await reading;
    else assert.equal((await closed)[0].code, 1012);
    assert.equal(failures, 1);
    assert.equal(view!.messages.some(message => message.role === 'agent'), false);
    const readsAtClose = scenario.timing === 'during' ? undefined : reads;
    const observed = new Promise<void>(resolve => {
      offObservation = partner.subscribeChat(event => {
        if (scenario.followup === 'delta' && event.type === 'delta' && event.reply.id === item.id && event.reply.text === 'first line\nsecond line\n') resolve();
        if (scenario.followup === 'completed' && event.type === 'completed' && event.id === item.id) resolve();
      });
    });
    if (scenario.followup === 'delta') await f.streamCommand({ action: 'advance', text: 'first line\nsecond line\n' });
    if (scenario.followup === 'completed') await f.streamCommand({ action: 'event', notification: { method: 'item/completed', params: {
      threadId: native.threadId, turnId: native.active, completedAtMs: Date.now(), item: { ...item, text: 'first line\n', phase: 'final_answer' },
    } } });
    if (scenario.followup !== 'none') { await observed; await snapshot(); }
    const readsBeforeFailure = reads;
    if (scenario.timing === 'during') { release(); assert.equal((await closed)[0].code, 1012); }
    const readsAfterFailure = reads;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads, readsAtClose ?? readsBeforeFailure, 'closed host does not scan after the error');
    assert.equal(readsAfterFailure, reads);
    assert.equal(failures, 1);
    const requests = (await f.requests()).filter(request => request.method === 'turn/start' || request.method === 'turn/steer').length;
    client = await openChat(new WebSocket(url), value => { view = value; }, () => {});
    await eventually(async () => view?.messages.some(message => message.id === item.id && (scenario.followup === 'completed'
      ? message.textState === 'complete' : message.text === (scenario.followup === 'delta' ? 'first line\nsecond line\n' : 'first line\n'))) === true);
    assert.deepEqual(view!.messages.map(message => message.id), [id, item.id]);
    assert.equal(view!.messages.filter(message => message.id === item.id).length, 1);
    if (scenario.followup === 'completed') assert.equal(view!.streamingReply, undefined);
    assert.equal((await client.lookup(id))?.state, 'submitted');
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start' || request.method === 'turn/steer').length, requests);
  } finally {
    release(); offObservation?.(); console.error = originalError;
    client?.close(); await app.close(); await f.close();
  }
});

test('initial read failure closes its socket with 1011 and the next socket can read', { timeout: 25_000 }, async () => {
  const f = await fixture();
  const partner = await f.createPartner();
  const snapshot = partner.snapshot.bind(partner);
  let first = true;
  partner.snapshot = async (...args) => {
    if (first) { first = false; throw new Error('Test-owned initial read failure'); }
    return snapshot(...args);
  };
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`;
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    const socket = new WebSocket(url);
    const closed = once(socket, 'close');
    await assert.rejects(openChat(socket, () => {}, () => {}));
    assert.equal((await closed)[0].code, 1011);
    let view: ChatView | undefined;
    client = await openChat(new WebSocket(url), value => { view = value; }, () => {});
    assert.ok(view);
  } finally { client?.close(); await app.close(); await f.close(); }
});

test('native reply updates use one source without reading the page on each delta', { timeout: 25_000 }, async () => {
  const f = await fixture();
  f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  const partner = await f.createPartner();
  const counts = { snapshot: 0, receipt: 0, image: 0, recovery: 0 };
  const snapshot = partner.snapshot.bind(partner), receipt = partner.chatVisible.bind(partner), image = partner.sharedImageRef.bind(partner);
  partner.snapshot = async (...args) => { counts.snapshot++; return snapshot(...args); };
  partner.chatVisible = async (...args) => { counts.receipt++; return receipt(...args); };
  partner.sharedImageRef = async (...args) => { counts.image++; return image(...args); };
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: ChatView | undefined;
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), value => { view = value; }, () => {});
    const operationId = crypto.randomUUID();
    await client.submit({ operationId, text: 'input' }).catch(() => {});
    await eventually(async () => !!(await f.nativeState()).streamingItem && view?.messages.some(message => message.id === operationId) === true);
    const steerId = crypto.randomUUID();
    await client.submit({ operationId: steerId, text: 'steer before text' }).catch(() => {});
    await eventually(async () => await f.consumed(steerId));
    await eventually(async () => view?.messages.some(message => message.id === steerId) === true);
    await f.streamCommand({ action: 'advance', text: 'first line\n' });
    await eventually(async () => view?.messages.some(message => message.role === 'agent' && message.text === 'first line\n') === true);
    const answer = view!.messages.find(message => message.role === 'agent')!;
    assert.deepEqual(view!.messages.map(message => message.id), [operationId, answer.id, steerId]);
    assert.deepEqual(answer.ends, [11]);
    const prior = { ...counts };
    await f.streamCommand({ action: 'advance', text: 'first line\nsecond' });
    await eventually(async () => view?.messages.some(message => message.id === answer.id && message.text === 'first line\nsecond') === true);
    await f.streamCommand({ action: 'advance', text: 'first line\nsecond line\n' });
    await eventually(async () => view?.messages.some(message => message.id === answer.id && message.text === 'first line\nsecond line\n') === true);
    assert.deepEqual(view!.messages.find(message => message.id === answer.id)?.ends, [11, 23]);
    assert.deepEqual(counts, prior, 'ordinary deltas do not read page, receipt or image metadata');
    const native = await f.nativeState();
    const item = native.turns.find((turn: { id: string }) => turn.id === native.active).items.find((value: { id: string }) => value.id === answer.id);
    await f.streamCommand({ action: 'event', notification: { method: 'item/completed', params: {
      threadId: native.threadId, turnId: native.active, completedAtMs: Date.now(), item: { ...item, phase: 'final_answer' },
    } } });
    await eventually(async () => view?.messages.some(message => message.id === answer.id && message.textState === 'complete') === true);
    assert.equal(view!.messages.filter(message => message.id === answer.id).length, 1);
    await partner.snapshot(); counts.snapshot--;
    assert.deepEqual(counts, prior, 'completed reply does not reread page, receipt or image metadata');
  } finally {
    client?.close();
    try { await app.close(); }
    catch {
      for (const socket of app.chatSockets.clients) socket.terminate();
      app.server.closeAllConnections();
      if (app.server.listening) app.server.close();
    }
    await f.close();
  }
});
