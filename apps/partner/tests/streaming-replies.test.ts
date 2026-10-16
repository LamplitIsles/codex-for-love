import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { fixture, eventually } from './fixture.ts';

for (const ending of ['complete', 'stop', 'fail'] as const) test(`held official answer deltas: last observer reconnect, ${ending}, stale events and restart`, async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  let partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as { port: number }).port;
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`), v => { view = v; }, () => {});
  let client = await connect(); let appClosed = false;
  try {
    const input = { operationId: crypto.randomUUID(), text: 'Test-owned sentence acceptance input' };
    assert.equal((await client.submit(input)).state, 'submitted');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: '第一行。同行第二句。\r' });
    await eventually(async () => view?.streamingReply?.text === '第一行。同行第二句。\r');
    const identity = { ...view!.streamingReply! };
    const turnId = identity.turnId!, itemId = identity.id;
    const event = (method: string, params: Record<string, unknown>) => f.streamCommand({ action: 'event', notification: { method, params } });
    const delta = (threadId: string, targetTurn: string, targetItem: string, text: string) => event('item/agentMessage/delta', { threadId, turnId: targetTurn, itemId: targetItem, delta: text });
    await delta('foreign-thread', turnId, itemId, 'secret');
    await delta(view!.sessionId, 'unknown-turn', itemId, 'secret');
    await delta(view!.sessionId, turnId, 'unknown-item', 'secret');
    await delta(view!.sessionId, turnId, itemId, '');
    await event('item/reasoning/textDelta', { threadId: view!.sessionId, turnId, itemId: 'reasoning', delta: 'CFL_REASONING_PRIVATE_SENTINEL', contentIndex: 0 });
    await f.streamCommand({ action: 'advance', text: '第一行。同行第二句。\r\n第二行' });
    await eventually(async () => view?.streamingReply?.text === '第一行。同行第二句。\r\n第二行');
    assert.equal(view!.streamingReply!.id, identity.id); assert.equal(view!.streamingReply!.createdAt, identity.createdAt);
    assert.equal(view!.messages.filter(m => m.role === 'agent').length, 0);
    assert.equal((await partner.snapshot()).results.some(r => r.completedMessages.length > 0), false);
    assert.equal((await client.lookup(input.operationId))?.state, 'submitted');
    assert.equal(JSON.stringify(await createCodexChatBackend(partner).read()).includes('CFL_REASONING_PRIVATE_SENTINEL'), false);
    assert.equal(JSON.stringify(await client.history(JSON.stringify({ before: 999999 }))).includes('CFL_REASONING_PRIVATE_SENTINEL'), false);
    const starts = (await f.requests()).filter(r => r.method === 'turn/start').length;
    client.close(); view = undefined;
    await eventually(async () => app.chatSockets.clients.size === 0);
    await f.streamCommand({ action: 'advance', text: '第一行。同行第二句。\r\n第二行继续' });
    assert.equal(partner.streamingReply()?.text, '第一行。同行第二句。\r\n第二行继续');
    client = await connect();
    await eventually(async () => view?.streamingReply?.text === '第一行。同行第二句。\r\n第二行继续');
    assert.equal(view!.streamingReply!.id, identity.id);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, starts);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/interrupt').length, 0);
    if (ending === 'stop') assert.equal((await client.stop(turnId)).stopped, true);
    else await f.streamCommand({ action: ending, text: '第一行。同行第二句。\r\n第二行继续完成' });
    await eventually(async () => view?.activeTurnId === null && !view.streamingReply);
    if (ending === 'complete') {
      await eventually(async () => !!view?.messages.some(m => m.id === itemId));
      assert.equal(view!.messages.find(m => m.id === itemId)!.text, '第一行。同行第二句。\r\n第二行继续完成');
      assert.equal(view!.messages.filter(m => m.id === itemId).length, 1);
    } else {
      assert.equal(view!.messages.some(m => m.id === itemId), false);
      assert.ok(view!.messages.some(m => m.role === 'notice'));
    }
    await delta(view!.sessionId, turnId, itemId, 'late secret');
    await event('item/started', { threadId: view!.sessionId, turnId, startedAtMs: Date.now(), item: { type: 'agentMessage', id: itemId, text: 'late secret', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } });
    await partner.snapshot();
    assert.equal(partner.streamingReply(), undefined);
    assert.equal(JSON.stringify(await createCodexChatBackend(partner).read()).includes('secret'), false);
    await partner.submit(crypto.randomUUID(), 'retry after terminal');
    await eventually(async () => (await f.nativeState()).active !== turnId && !!(await f.nativeState()).active);
    await f.streamCommand({ action: 'advance', text: 'new attempt' });
    await eventually(async () => partner.streamingReply()?.text === 'new attempt');
    const retry = partner.streamingReply()!;
    await delta(view!.sessionId, turnId, itemId, 'old attempt secret');
    await partner.snapshot(); assert.equal(partner.streamingReply()?.id, retry.id); assert.equal(partner.streamingReply()?.text, 'new attempt');
    await partner.chatStop(retry.turnId);
    client.close(); await app.close(); appClosed = true; partner = await f.createPartner();
    const reopened = await createCodexChatBackend(partner).read();
    assert.equal(reopened.streamingReply, undefined);
    assert.equal(reopened.messages.filter(m => m.role === 'agent').length, ending === 'complete' ? 1 : 0);
    assert.equal((await partner.chatReceipt(input.operationId))?.state, 'submitted');
  } finally { client.close(); if (!appClosed) await app.close(); await f.close(); }
});

test('multiple native answer items retain separate durable messages; commentary/tool work never enters preview', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner(), backend = createCodexChatBackend(partner);
  try {
    await partner.submit(crypto.randomUUID(), 'Test-owned sentence acceptance input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'first answer' });
    await eventually(async () => partner.streamingReply()?.text === 'first answer');
    const first = partner.streamingReply()!;
    await f.streamCommand({ action: 'next', phase: 'commentary' });
    await f.streamCommand({ action: 'advance', text: 'private commentary sentinel' });
    await partner.snapshot(); assert.equal(partner.streamingReply(), undefined);
    assert.equal((await backend.read()).messages.filter(m => m.id === first.id).length, 1);
    const state = await f.nativeState();
    await f.streamCommand({ action: 'event', notification: { method: 'item/mcpToolCall/progress', params: { threadId: state.threadId, turnId: first.turnId, itemId: 'tool-only', message: 'CFL_REASONING_PRIVATE_SENTINEL' } } });
    await f.streamCommand({ action: 'next', phase: 'final_answer' });
    await f.streamCommand({ action: 'advance', text: 'second answer' });
    await eventually(async () => partner.streamingReply()?.text === 'second answer');
    const second = partner.streamingReply()!; assert.notEqual(second.id, first.id);
    await f.streamCommand({ action: 'event', notification: { method: 'item/agentMessage/delta', params: { threadId: (await backend.read()).sessionId, turnId: first.turnId, itemId: first.id, delta: 'stale' } } });
    await partner.snapshot(); assert.equal(partner.streamingReply()?.text, 'second answer');
    await f.streamCommand({ action: 'complete', text: 'second answer final' });
    await eventually(async () => (await backend.read()).activeTurnId === null);
    const final = await backend.read();
    assert.equal(final.streamingReply, undefined); assert.equal(final.messages.filter(m => m.id === first.id).length, 1);
    assert.equal(final.messages.find(m => m.id === second.id)?.text, 'second answer final');
    assert.equal(final.messages.some(m => m.thinking), false);
    // Existing completed commentary remains visible; the new preview never discloses it.
    assert.ok(final.messages.some(m => m.text === 'private commentary sentinel'));
    await partner.close(); assert.equal(partner.streamingReply(), undefined);
  } finally { await f.close(); }
});

test('closing the last socket during initial native read releases its eventual subscription', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const reading = new Promise<void>(r => { entered = r; });
  let observing = 0;
  const facade = new Proxy(partner, { get(target, key) {
    if (key === 'snapshot') return async (...args: Parameters<typeof partner.snapshot>) => { entered(); await gate; return target.snapshot(...args); };
    if (key === 'subscribe') return (listener: () => void) => { observing++; const off = target.subscribe(listener); let subscribed = true; return () => { if (subscribed) { subscribed = false; observing--; off(); } }; };
    const value = target[key as keyof typeof target]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = createWebServer(facade, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`);
  try {
    await reading; ws.close();
    await eventually(async () => app.chatSockets.clients.size === 0);
    release();
    await eventually(async () => observing === 0);
    await partner.submit(crypto.randomUUID(), 'Test-owned sentence acceptance input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'unobserved active answer' });
    await eventually(async () => partner.streamingReply()?.text === 'unobserved active answer');
    assert.equal(observing, 0);
    assert.equal((await f.requests()).some(r => r.method === 'turn/interrupt'), false);
  } finally { release(); ws.close(); await app.close(); await f.close(); }
});

test('a delayed host history read cannot overwrite newer partials or resurrect a terminal preview', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner();
  try {
    await partner.submit(crypto.randomUUID(), 'Test-owned sentence acceptance input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'first' });
    await eventually(async () => partner.streamingReply()?.text === 'first');
    for (const terminal of [false, true]) {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const reading = new Promise<void>(r => { entered = r; });
      const facade = new Proxy(partner, { get(target, key) {
        if (key === 'snapshot') return async (...args: Parameters<typeof partner.snapshot>) => {
          const value = await target.snapshot(...args); entered(); await gate; return value;
        };
        const value = target[key as keyof typeof target]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      const pending = createCodexChatBackend(facade).read();
      try {
        await reading;
        await f.streamCommand({ action: terminal ? 'complete' : 'advance', text: terminal ? 'first updated final' : 'first updated' });
        await partner.snapshot(); release();
        const delayed = await pending;
        assert.equal(delayed.streamingReply?.text, terminal ? undefined : 'first updated');
        assert.equal(JSON.stringify(delayed).includes('CFL_REASONING_PRIVATE_SENTINEL'), false);
      } finally { release(); await pending; }
    }
  } finally { await f.close(); }
});

test('same-second native item time orders the preview after its source and stays stable during growth', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner(), backend = createCodexChatBackend(partner);
  try {
    // Select actual source/item timestamps within one second, retrying only if real
    // admission crosses its boundary. Neither the host clock nor native time is mocked.
    let sourceTime = 0, startedAtMs = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previousItem = (await f.nativeState()).streamingItem;
      const operationId = crypto.randomUUID(); await partner.submit(operationId, 'Test-owned sentence acceptance input');
      await eventually(async () => { const native = await f.nativeState(); return !!native.streamingItem && native.streamingItem !== previousItem; });
      sourceTime = (await backend.read()).messages.find(m => m.operationId === operationId)!.createdAt;
      startedAtMs = (await f.nativeState()).streamingStartedAtMs;
      if (sourceTime > Math.floor(sourceTime / 1000) * 1000 && Math.floor(sourceTime / 1000) === Math.floor(startedAtMs / 1000)) break;
      await partner.chatStop((await f.nativeState()).active);
    }
    assert.equal(Math.floor(sourceTime / 1000), Math.floor(startedAtMs / 1000), 'exercise real same-second source/item ordering');
    assert.ok(sourceTime > Math.floor(sourceTime / 1000) * 1000, 'second truncation would put the preview before its source');
    assert.ok(startedAtMs >= sourceTime, 'native lifecycle follows source admission');
    await f.streamCommand({ action: 'advance', text: 'test-owned timestamp answer' });
    await eventually(async () => (await backend.read()).streamingReply?.text === 'test-owned timestamp answer');
    const preview = (await backend.read()).streamingReply!;
    assert.equal(preview.createdAt, startedAtMs, 'use the original official item millisecond timestamp');
    assert.ok(preview.createdAt >= sourceTime, 'public preview follows the current admitted source');
    await f.streamCommand({ action: 'advance', text: 'test-owned timestamp answer\ncontinued' });
    await eventually(async () => (await backend.read()).streamingReply?.text.endsWith('continued') === true);
    const grown = (await backend.read()).streamingReply!;
    assert.equal(grown.createdAt, startedAtMs); assert.equal(grown.id, preview.id); assert.equal(grown.turnId, preview.turnId);
  } finally { await f.close(); }
});
