import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';

for (const rounds of [16, 31]) for (const advance of [0, 11]) test(`older history button pages ${rounds} native rounds through the shared socket after ${advance} new rounds`, async () => {
  const f = await fixture();
  const turns = Array.from({ length: rounds }, (_, i) => ({
    id: `history-turn-${i}`, status: 'completed', startedAt: 1700000000 + i, completedAt: 1700000000 + i,
    error: null, items: [
      { type: 'userMessage', id: `history-user-${i}`, clientId: `history-input-${i}`, content: [{ type: 'text', text: `human ${i}` }] },
      { type: 'agentMessage', id: `history-agent-${i}`, text: `partner ${i}`, phase: 'final_answer' },
    ],
  }));
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 32, turns }));
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as { port: number }).port;
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`), value => { view = value; }, () => {});
  let client = await connect();
  try {
    await eventually(async () => !!view?.before);
    const pages = [view!.messages];
    let before = view!.before;
    // The App retains this older-history cursor while accumulating evicted
    // live messages. Advance the native window beyond its original anchor.
    for (let i = 0; i < advance; i++) {
      const id = crypto.randomUUID();
      await partner.submit(id, `new message ${i}`);
      await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(id) && r.status === 'completed'));
    }
    const originalBoundary = rounds + 1;
    const anchor = pages[0]![0]!.operationId!;
    assert.equal((await partner.snapshot()).messages.some(m => m.id === anchor), advance === 0);
    assert.equal((await partner.snapshot({ before: originalBoundary })).messages.some(m => m.id === anchor), true);
    const firstPage = await client.history(before!);
    client.close(); view = undefined; client = await connect();
    await eventually(async () => !!view?.before);
    assert.deepEqual(await client.history(before!), firstPage, 'the retained history cursor also works after reconnect');
    while (before) {
      const page = await client.history(before);
      assert.ok(page.messages.length > 0);
      assert.ok(page.messages.length <= 30);
      pages.unshift(page.messages);
      before = page.before;
    }
    assert.deepEqual(pages.flat().map(m => m.text), turns.flatMap((_, i) => [`human ${i}`, `partner ${i}`]));
  } finally { client.close(); await app.close(); await f.close(); }
});

test('real Node host and official SDK: completed messages, duplicate admission, steer, stop and rehydrate', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as { port: number }).port;
  let view: ChatView | undefined;
  let client = await openChat(new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`), value => { view = value; }, () => {});
  try {
    const input = { operationId: crypto.randomUUID(), text: 'shared Codex protocol' };
    await client.submit(input); await client.submit(input);
    await assert.rejects(client.submit({ ...input, text: 'identity conflict' }));
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/start').length === 1);
    assert.equal(view?.messages.filter(m => m.role === 'agent').length, 0);
    const steer = { operationId: crypto.randomUUID(), text: 'additional input' }; await client.submit(steer);
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/steer'));
    assert.equal((await client.stop('stale-turn')).stopped, false);
    client.close(); await f.holdProvider(false);
    await eventually(async () => (await partner.snapshot()).results.some(r => r.status === 'completed'));
    client = await openChat(new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`), value => { view = value; }, () => {});
    await eventually(async () => !!view?.messages.some(m => m.role === 'agent'));
    assert.equal((await client.lookup(input.operationId)).state, 'consumed');
    await eventually(async () => view?.activeTurnId === null);
    assert.equal(view!.messages.some(m => m.text === '回复完成'), false);
    const old = view?.activeTurnId;
    await f.holdProvider(true); await client.submit({ operationId: crypto.randomUUID(), text: 'stop me' });
    await eventually(async () => !!view?.activeTurnId);
    assert.equal((await client.stop(old ?? 'old-turn')).stopped, false);
    const target = view!.activeTurnId!;
    assert.equal((await client.stop(target)).stopped, true);
    await eventually(async () => !!view?.messages.some(m => m.turnId === target && m.role === 'notice' && m.text === '已停止回复'));
    assert.equal((await client.history(JSON.stringify({ before: 0 }))).messages.length, 0);
  } finally { client.close(); await app.close(); await f.close(); }
});


test('each completed message appears while running; consumed input and terminal outcomes survive reconnect', async () => {
  const f = await fixture();
  f.appServer.env.FAKE_CHAT_PHASE_FIXTURE = 'true';
  await f.chatPhase('partial');
  let partner = await f.createPartner();
  let app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let port = (app.server.address() as { port: number }).port;
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`), value => { view = value; }, () => {});
  let client = await connect();
  try {
    for (const ending of ['finish', 'fail', 'stop'] as const) {
      await f.chatPhase('partial');
      const input = { operationId: crypto.randomUUID(), text: `phase fixture ${ending}` };
      await client.submit(input);
      await eventually(async () => !!view?.activeTurnId && view.messages.some(m => m.operationId === input.operationId && m.delivery === 'consumed'));
      const turnId = view!.activeTurnId!;
      assert.equal((await client.lookup(input.operationId)).state, 'consumed');
      assert.equal(view!.messages.filter(m => m.turnId === turnId && m.role === 'agent').length, 0);
      await f.chatPhase('message-completed');
      await eventually(async () => !!view?.messages.some(m => m.turnId === turnId && m.text === 'completed commentary'));
      assert.equal(view!.activeTurnId, turnId);
      assert.equal(view!.messages.filter(m => m.turnId === turnId && m.role === 'agent').length, 1);
      assert.equal(view!.messages.some(m => m.text.startsWith('unfinished')), false);
      const completedId = view!.messages.find(m => m.turnId === turnId && m.role === 'agent')!.id;
      await eventually(async () => (await partner.snapshot()).results.some(r => r.turnId === turnId && r.status === 'failed'));
      assert.equal(view!.messages.some(m => m.turnId === turnId && m.role === 'notice'), false);
      client.close(); view = undefined; client = await connect();
      await eventually(async () => !!view?.messages.some(m => m.id === completedId));
      assert.equal(view!.activeTurnId, turnId);
      if (ending === 'stop') assert.equal((await client.stop(turnId)).stopped, true);
      else await f.chatPhase(ending);
      const status = ending === 'fail' ? '回复失败' : '已停止回复';
      await eventually(async () => view?.activeTurnId === null);
      if (ending === 'finish') assert.equal(view!.messages.some(m => m.turnId === turnId && m.role === 'notice'), false);
      else await eventually(async () => !!view?.messages.some(m => m.turnId === turnId && m.role === 'notice' && m.text === status));
      const messages = view!.messages.filter(m => m.turnId === turnId && m.role === 'agent');
      assert.equal(messages.length, ending === 'finish' ? 2 : 1);
      assert.ok(messages.some(m => m.id === completedId));
      assert.equal(view!.messages.some(m => m.text.startsWith('unfinished')), false);
      client.close(); view = undefined;
      if (ending === 'stop') {
        await app.close(); await partner.close();
        partner = await f.createPartner();
        app = createWebServer(partner, join(f.directory, 'assets'));
        app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
        port = (app.server.address() as { port: number }).port;
      }
      client = await connect();
      await eventually(async () => view?.activeTurnId === null);
      if (ending === 'finish') assert.equal(view!.messages.some(m => m.turnId === turnId && m.role === 'notice'), false);
      else await eventually(async () => !!view?.messages.some(m => m.turnId === turnId && m.role === 'notice' && m.text === status));
      assert.equal(view!.messages.filter(m => m.turnId === turnId && m.role === 'agent').length, ending === 'finish' ? 2 : 1);
    }
  } finally { client.close(); await app.close(); await f.close(); }
});
