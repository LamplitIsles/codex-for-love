import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietCompactionFixture } from './quiet-compaction-fixture.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { openChat } from '@lamplit/contracts/client';
import { once } from 'node:events';

test('native last usage, nullable completion, fresh coalesced snapshot, failure and ownership', async () => {
  const h = await quietCompactionFixture('', '');
  try {
    const backend = createCodexChatBackend(h.partner);
    assert.deepEqual((await backend.read()).contextUsage, { tokens: null, capacity: null });
    await h.action({ action: 'usage', tokens: 90000, capacity: 100000 });
    assert.deepEqual((await backend.read()).contextUsage, { tokens: 90000, capacity: 100000 });
    for (const tokens of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      await h.action({ action: 'usage', tokens, capacity: -1 });
      assert.deepEqual((await backend.read()).contextUsage, { tokens: null, capacity: 100000 });
    }
    await h.action({ action: 'usage', tokens: 42000, capacity: 100000 });
    await h.action({ action: 'usage', tokens: 1, capacity: 1, threadId: 'foreign-session' });
    assert.equal((await backend.read()).contextUsage.tokens, 42000);
    const input = { sessionId: (await backend.read()).sessionId };
    assert.equal((await backend.compact(input)).accepted, true);
    await eventually(async () => (await backend.read()).compaction?.status === 'running');
    assert.match((await backend.read()).compaction?.id ?? '', /^context-/);
    assert.equal((await backend.compact(input)).accepted, false);
    await h.action({ action: 'finish' });
    assert.deepEqual((await backend.read()).contextUsage, { tokens: null, capacity: 100000 });
    await h.action({ action: 'usage', tokens: 12000, capacity: 100000 });
    const fresh = await backend.read();
    assert.equal(fresh.compaction?.status, 'complete');
    assert.equal(fresh.contextUsage.tokens, 12000, 'fresh usage accompanying complete must survive');
    await h.action({ action: 'auto' }); await h.action({ action: 'finish', failed: true });
    assert.equal((await backend.read()).compaction?.status, 'failed');
    assert.equal((await backend.read()).contextUsage.tokens, 12000);
    await assert.rejects(backend.compact({ sessionId: 'foreign' }), /session/);
    await assert.rejects(backend.submit({ operationId: crypto.randomUUID(), text: '/compact' }), /compact/);
    await assert.rejects(backend.submit({ operationId: crypto.randomUUID(), text: ' /compact ', images: [] }), /compact/);
    assert.equal((await h.action({ action: 'state' })).calls, 1);
    assert.equal((await h.action({ action: 'state' })).submissions.length, 0);
  } finally { await h.close(); }
});

test('admission revalidates revoked authorization and busy state after awaited guard', async () => {
  const h = await quietCompactionFixture('', '');
  try {
    let release: (value: boolean) => void = () => {};
    const entered = Promise.withResolvers<void>();
    const backend = createCodexChatBackend(h.partner, async () => { entered.resolve(); return new Promise<boolean>(resolve => { release = resolve; }); });
    const input = { sessionId: (await backend.read()).sessionId };
    const denied = backend.compact(input); await entered.promise;
    assert.equal((await backend.compact(input)).accepted, false, 'in-flight native admission is refused without queuing');
    release(false);
    await assert.rejects(denied, /Unauthorized/);
    assert.equal((await h.action({ action: 'state' })).calls, 0);
    const racing = backend.compact(input);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    await h.action({ action: 'busy', enabled: true }); release(true);
    assert.equal((await racing).accepted, false);
    assert.equal((await h.action({ action: 'state' })).calls, 0);
  } finally { await h.close(); }
});


test('connection revoked while native authorization awaits never enters the official engine', { timeout: 15000 }, async () => {
  const h = await quietCompactionFixture('', '');
  let armed = false, checks = 0;
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<boolean>();
  const app = createWebServer(h.partner, '', { authorize: async () => {
    if (armed && ++checks === 2) { entered.resolve(); return gate.promise; }
    return true;
  } });
  const disconnected = Promise.withResolvers<void>();
  app.server.on('upgrade', (_request, socket) => socket.once('close', () => disconnected.resolve()));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`);
  let sessionId = '';
  const client = await openChat(socket, view => { sessionId = view.sessionId; }, () => {});
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    armed = true;
    const result = client.compact({ sessionId }).catch(() => undefined);
    await entered.promise; socket.close();
    await new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
    await Promise.race([disconnected.promise, new Promise<void>(resolve => setTimeout(resolve, 100))]);
    gate.resolve(true); await result;
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal((await h.action({ action: 'state' })).calls, 0);
    assert.equal((await h.partner.snapshot()).lifecycle.latest, undefined);
  } finally { gate.resolve(false); client.close(); socket.close(); await app.close(); await h.close(); }
});


test('definite official admission refusal returns false without an execution or retry', async () => {
  const h = await quietCompactionFixture('', '');
  try {
    await h.action({ action: 'refuse', enabled: true });
    const backend = createCodexChatBackend(h.partner);
    assert.deepEqual(await backend.compact({ sessionId: (await backend.read()).sessionId }), { sessionId: 'fixture-session', accepted: false });
    await backend.read(); await backend.read();
    const state = await h.action({ action: 'state' });
    assert.equal(state.calls, 1); assert.equal(state.executions, 0); assert.deepEqual(state.submissions, []);
  } finally { await h.close(); }
});


for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'native'} pending human admission refuses immediate compact without queuing`, async () => {
    const h = await quietCompactionFixture('', '');
    try {
      const id = crypto.randomUUID();
      const submission = shared ? h.partner.submitShared({ operationId: id, text: 'first queued text' }) : h.partner.submit(id, 'first queued text');
      const compact = h.partner.compact({ sessionId: 'fixture-session' });
      const results = await Promise.allSettled([submission, compact]);
      assert.equal(results[0]!.status, 'fulfilled');
      assert.deepEqual(results[1], { status: 'fulfilled', value: { sessionId: 'fixture-session', accepted: false } });
      await eventually(async () => (await h.partner.snapshot()).results.some(result => result.chatStatus === 'completed'));
      const state = await h.action({ action: 'state' });
      assert.equal(state.calls, 0); assert.equal(state.executions, 0);
      assert.equal((await h.partner.snapshot()).messages[0]?.input, 'first queued text');
      assert.equal((await h.partner.compact({ sessionId: 'fixture-session' })).accepted, true, 'successful admission releases its marker');
      await h.action({ action: 'finish' });
    } finally { await h.close(); }
  });
}

test('failed shared prerequisites and failed native admission release pending human markers', async () => {
  const h = await quietCompactionFixture('', '');
  try {
    await assert.rejects(h.partner.submitShared({ operationId: '', text: 'invalid shared input' }));
    await assert.rejects(h.partner.submitShared({ operationId: crypto.randomUUID(), text: 'invalid replacement', replacementSourceIds: ['not-owned'] }));
    await h.f.rejectStart(true);
    const submission = h.partner.submit(crypto.randomUUID(), 'failed human admission');
    assert.equal((await h.partner.compact({ sessionId: 'fixture-session' })).accepted, false);
    await assert.rejects(submission);
    await h.f.rejectStart(false);
    const before = await h.action({ action: 'state' });
    assert.equal(before.calls, 0); assert.equal(before.executions, 0);
    assert.equal((await h.partner.compact({ sessionId: 'fixture-session' })).accepted, true, 'all failure paths release their markers');
    await h.action({ action: 'finish' });
  } finally { await h.close(); }
});
