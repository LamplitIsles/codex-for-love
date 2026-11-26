import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { stageTestFiles } from './file-fixture.ts';
import { fixtureImage } from './panels-seed.ts';

for (const tampered of [false, true]) test(`a restarted active ${tampered ? 'tampered' : 'proven'} unknown delivery is checked on terminal event for a fresh Chord client`, async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const input = { operationId: crypto.randomUUID(), text: 'committed active input' };
  const prior = { id: 'prior-turn', status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'prior-user', clientId: 'prior-input', content: [{ type: 'text', text: 'prior' }] },
    { type: 'agentMessage', id: 'prior-answer', text: 'prior reply', phase: 'final_answer' },
  ] };
  const save = (turns: object[], active: string | null) => writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', turns, next: 10, active }));
  await save([prior], null);
  try {
    let head = '', historyId = '';
    for (let restart = 0; restart < 2; restart++) {
      const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      let view: ChatView | undefined;
      const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
      try {
        await eventually(async () => !!view);
        const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
        assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
        if (!restart) { head = start.head; historyId = start.historyId; }
        else {
          assert.equal(start.historyId, historyId);
          assert.equal((await partner.historyStore.deliveryAttempt(input.operationId, view!.sessionId))?.state, 'unknown');
          assert.equal((await partner.snapshot()).typing, true);
          const active = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: head });
          assert.equal(active.kind, 'newer'); if (active.kind !== 'newer') throw new Error();
          assert.deepEqual(active.records, []);
          const requestsBefore = (await f.requests()).length;
          await f.streamCommand({ action: 'complete', text: 'finished after restart' });
          await eventually(async () => partner.historyTurns().includes('active-turn'));
          await partner.historyFence();
          assert.equal((await f.requests()).filter(row => row.method === 'turn/start' || row.method === 'turn/steer').length, 0);
          if (tampered) {
            await assert.rejects(client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: head }));
            assert.equal((await partner.historyStore.deliveryAttempt(input.operationId, view!.sessionId))?.state, 'unknown');
            assert.equal(view!.messages.some(message => message.id === input.operationId), false);
          } else {
            const completed = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: head });
            assert.equal(completed.kind, 'newer'); if (completed.kind !== 'newer') throw new Error();
            assert.equal(completed.historyId, historyId);
            assert.deepEqual(completed.records.map(row => row.message.text), [input.text, 'finished after restart']);
            assert.equal((await partner.historyStore.deliveryAttempt(input.operationId, view!.sessionId))?.state, 'accepted');
            await eventually(async () => view!.messages.some(message => message.id === input.operationId));
          }
          const later = (await f.requests()).slice(requestsBefore);
          assert.equal(later.filter(row => row.method === 'thread/turns/list' || (row.method === 'thread/items/list' && !(row.params as { turnId?: string }).turnId)).length, 0);
        }
      } finally { client.close(); await app.close(); await partner.close(); }
      if (!restart) {
        const store = new Store(partnerPaths(f.workspace).database);
        try { assert.equal((await store.reserveNativeDelivery(input, 'thread-fake', 'test-owner'))?.delivery.state, 'unknown'); }
        finally { await store.close(); }
        await save([prior, { id: 'active-turn', status: 'inProgress', startedAt: 1700000001, items: [
          { type: 'userMessage', id: 'active-user', clientId: input.operationId, content: [{ type: 'text', text: tampered ? 'changed' : input.text }] },
        ] }], 'active-turn');
        f.appServer.env.FAKE_RESUME_ACTIVE = 'true';
      }
    }
    assert.equal((await f.requests()).filter(row => row.method === 'turn/start' || row.method === 'turn/steer').length, 0);
  } finally { await f.close(); }
});

test('restart reconciles a proven terminal unknown delivery before Chord history sync', async () => {
  const f = await fixture();
  const input = { operationId: crypto.randomUUID(), text: 'native committed before the local receipt' };
  const turns = [{ id: 'prior-turn', status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'prior-user', clientId: 'prior-input', content: [{ type: 'text', text: 'prior' }] },
    { type: 'agentMessage', id: 'prior-answer', text: 'prior reply', phase: 'final_answer' },
  ] }];
  const save = () => writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', turns, next: 10 }));
  await save();
  try {
    let head = '', historyId = '';
    for (let restart = 0; restart < 2; restart++) {
      const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      let view: ChatView | undefined;
      const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
      try {
        await eventually(async () => !!view);
        const historyReads = (await f.requests()).filter(row => row.method === 'thread/turns/list' || row.method === 'thread/items/list').length;
        const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
        assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
        if (restart) {
          assert.equal(start.historyId, historyId);
          const newer = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: head });
          assert.equal(newer.kind, 'newer'); if (newer.kind !== 'newer') throw new Error();
          assert.deepEqual(newer.records.map(row => row.message.text), [input.text, 'committed reply']);
        } else { head = start.head; historyId = start.historyId; }
        assert.equal((await f.requests()).filter(row => row.method === 'thread/turns/list' || row.method === 'thread/items/list').length, historyReads);
      } finally { client.close(); await app.close(); await partner.close(); }
      if (!restart) {
        // Recreate a crash after native commit and before the local accepted transition.
        const store = new Store(partnerPaths(f.workspace).database);
        try { assert.equal((await store.reserveNativeDelivery(input, 'thread-fake', 'test-owner'))?.delivery.state, 'unknown'); }
        finally { await store.close(); }
        turns.push({ id: 'committed-turn', status: 'completed', startedAt: 1700000001, items: [
          { type: 'userMessage', id: 'committed-user', clientId: input.operationId, content: [{ type: 'text', text: input.text }] },
          { type: 'agentMessage', id: 'committed-answer', text: 'committed reply', phase: 'final_answer' },
        ] });
        await save();
      }
    }
    const store = new Store(partnerPaths(f.workspace).database);
    try { assert.deepEqual(await store.deliveryAttempt(input.operationId, 'thread-fake'), { attempt: 1, state: 'accepted' }); }
    finally { await store.close(); }
    assert.equal((await f.requests()).filter(row => row.method === 'turn/start' || row.method === 'turn/steer').length, 0);
  } finally { await f.close(); }
});

test('restart leaves tampered, absent and active native deliveries unknown without publishing an incomplete history', async () => {
  const f = await fixture();
  const tampered = { operationId: crypto.randomUUID(), text: 'original' };
  const absent = { operationId: crypto.randomUUID(), text: 'never proven' };
  const active = { operationId: crypto.randomUUID(), text: 'still active' };
  const prior = { id: 'prior-turn', status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'prior-user', clientId: 'prior-input', content: [{ type: 'text', text: 'prior' }] },
    { type: 'agentMessage', id: 'prior-answer', text: 'prior reply', phase: 'final_answer' },
  ] };
  const save = (turns: object[]) => writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', turns, next: 10 }));
  await save([prior]);
  try {
    let head = '';
    for (let restart = 0; restart < 2; restart++) {
      const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      let view: ChatView | undefined;
      const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
      try {
        await eventually(async () => !!view);
        if (!restart) {
          const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
          assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
          head = start.head;
        } else {
          await assert.rejects(client.historySync({ kind: 'start', sessionId: view!.sessionId }));
          await assert.rejects(client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: head }));
        }
      } finally { client.close(); await app.close(); await partner.close(); }
      if (!restart) {
        const store = new Store(partnerPaths(f.workspace).database);
        try {
          for (const input of [tampered, absent, active]) assert.equal((await store.reserveNativeDelivery(input, 'thread-fake', 'test-owner'))?.delivery.state, 'unknown');
        } finally { await store.close(); }
        await save([prior, { id: 'tampered-turn', status: 'completed', startedAt: 1700000001, items: [
          { type: 'userMessage', id: 'tampered-user', clientId: tampered.operationId, content: [{ type: 'text', text: 'changed' }] },
          { type: 'agentMessage', id: 'tampered-answer', text: 'reply', phase: 'final_answer' },
        ] }, { id: 'active-turn', status: 'inProgress', startedAt: 1700000002, items: [
          { type: 'userMessage', id: 'active-user', clientId: active.operationId, content: [{ type: 'text', text: active.text }] },
        ] }]);
      }
    }
    const store = new Store(partnerPaths(f.workspace).database);
    try { for (const input of [tampered, absent, active]) assert.deepEqual(await store.deliveryAttempt(input.operationId, 'thread-fake'), { attempt: 1, state: 'unknown' }); }
    finally { await store.close(); }
    assert.equal((await f.requests()).filter(row => row.method === 'turn/start' || row.method === 'turn/steer').length, 0);
  } finally { await f.close(); }
});

test('restart proves a terminal delivery with its original staged file and image', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  try {
    const files = await stageTestFiles(partner, sessionId, operationId, [{ id: 'note', name: 'note.txt', mediaType: 'text/plain', bytes: Buffer.from('owned fixture') }]);
    const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
    const images = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'image', order: 0, name: 'image.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    const input = { operationId, text: 'attachment proof', files: files.files.map(file => file.ref), images: images.images.map(image => image.ref) };
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await f.nativeState()).turns.some((turn: { status: string; items: Array<{ clientId?: string }> }) => turn.status === 'completed' && turn.items.some(item => item.clientId === operationId)));
    await partner.close();
    // Model the lost receipt commit while retaining the actual staged and native payloads.
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    try { assert.equal(db.prepare("UPDATE delivery_attempts SET state='unknown' WHERE operation_id=? AND attempt=1").run(operationId).changes, 1); }
    finally { db.close(); }
    const before = (await f.requests()).filter(row => row.method === 'turn/start' || row.method === 'turn/steer').length;
    partner = await f.createPartner();
    const app = createWebServer(partner, join(f.directory, 'assets'));
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    let view: ChatView | undefined;
    const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
    try {
      await eventually(async () => !!view);
      const start = await client.historySync({ kind: 'start', sessionId });
      assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
      const message = start.records.find(row => row.message.id === operationId)?.message;
      assert.equal(message?.text, input.text);
      assert.equal(message?.files?.[0]?.attachmentId, input.files[0]?.attachmentId);
      assert.equal(message?.images?.[0]?.attachmentId, input.images[0]?.attachmentId);
    } finally { client.close(); await app.close(); await partner.close(); }
    const store = new Store(partnerPaths(f.workspace).database);
    try { assert.deepEqual(await store.deliveryAttempt(operationId, sessionId), { attempt: 1, state: 'accepted' }); }
    finally { await store.close(); }
    assert.equal((await f.requests()).filter(row => row.method === 'turn/start' || row.method === 'turn/steer').length, before);
  } finally { await partner.close(); await f.close(); }
});

test('native finalized history is available through real Chord and resumes after restart', async () => {
  const f = await fixture();
  const turns = Array.from({ length: 70 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', startedAt: 1700000000 + i, items: [
    { type: 'userMessage', id: `u-${i}`, clientId: `input-${i}`, content: [{ type: 'text', text: `human ${i}` }] },
    { type: 'agentMessage', id: `a-${i}`, text: `agent ${i}`, phase: 'final_answer' },
  ] }));
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', turns, next: 100 }));
  try {
    let head = '';
    for (let restart = 0; restart < 2; restart++) {
      const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      let view: ChatView | undefined;
      const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
      try {
        await eventually(async () => !!view?.before);
        const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
        assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
        assert.equal(start.records.length, 128);
        if (restart) {
          const resumed = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: head });
          assert.equal(resumed.kind, 'newer'); if (resumed.kind !== 'newer') throw new Error();
          assert.equal(resumed.records.length, 0);
        }
        head = start.head;
        const older = await client.historySync({ kind: 'older', sessionId: view!.sessionId, before: view!.before! });
        assert.equal(older.kind, 'older'); if (older.kind !== 'older') throw new Error();
        assert.equal(older.records.at(-1)?.message.id, 'a-54');
      } finally { client.close(); await app.close(); await partner.close(); }
    }
  } finally { await f.close(); }
});

test('active input stays in live view and becomes append-only history after terminal reconciliation', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true'; f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
  try {
    await eventually(async () => !!view);
    const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
    assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
    assert.deepEqual(start.records, []);
    const operationId = crypto.randomUUID();
    await partner.submit(operationId, 'first input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'partial' });
    await eventually(async () => view?.messages.some(message => message.text === 'partial') === true);
    const active = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: start.head });
    assert.equal(active.kind, 'newer'); if (active.kind !== 'newer') throw new Error();
    assert.deepEqual(active.records, []);
    const steer = crypto.randomUUID();
    await partner.submit(steer, 'steered input');
    await eventually(async () => (await partner.snapshot()).messages.some(message => message.id === steer));
    await f.streamCommand({ action: 'next' });
    await f.streamCommand({ action: 'complete', text: 'finished' });
    await eventually(async () => {
      const next = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: start.head });
      return next.kind === 'newer' && next.records.length === 4;
    });
    const completed = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: start.head });
    assert.equal(completed.kind, 'newer'); if (completed.kind !== 'newer') throw new Error();
    assert.deepEqual(completed.records.map(row => row.message.text), ['first input', 'partial', 'steered input', 'finished']);
  } finally { client.close(); await app.close(); await f.close(); }
});

test('a proven reminder reply retains wake attribution in history', async () => {
  const f = await fixture();
  const occurrence = 'alarm:reminder-id:1700000000123';
  const turns = [{ id: 'wake-turn', status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'wake-user', clientId: occurrence, content: [{ type: 'text', text: '[Partner self-set reminder; not from the Human or Keet]\nremember this' }] },
    { type: 'agentMessage', id: 'wake-reply', text: 'I remembered.', phase: 'final_answer' },
  ] }];
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', turns, next: 10 }));
  const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
  try {
    await eventually(async () => !!view);
    const result = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
    assert.equal(result.kind, 'start'); if (result.kind !== 'start') throw new Error();
    assert.deepEqual(result.records.find(row => row.message.id === 'wake-reply')?.wake, { occurrenceId: occurrence, reminderId: 'reminder-id', triggeredAtMs: 1700000000123 });
    assert.equal(result.records.find(row => row.message.id === occurrence)?.message.source?.kind, 'reminder');
  } finally { client.close(); await app.close(); await f.close(); }
});

for (const terminal of ['fail', 'stop'] as const) test(`native ${terminal} creates a final notice in ordered history`, async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
  try {
    await eventually(async () => !!view);
    const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
    assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
    const id = crypto.randomUUID(); await partner.submit(id, 'terminal input');
    await eventually(async () => !!view?.activeTurnId);
    if (terminal === 'fail') await f.streamCommand({ action: 'fail' });
    else assert.equal((await client.stop(view!.activeTurnId!)).stopped, true);
    await eventually(async () => {
      const next = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: start.head });
      return next.kind === 'newer' && next.records.some(row => row.message.role === 'notice');
    });
    const result = await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: start.head });
    assert.equal(result.kind, 'newer'); if (result.kind !== 'newer') throw new Error();
    assert.deepEqual(result.records.map(row => row.message.role), ['user', 'notice']);
    assert.equal(result.records[1]?.message.text, terminal === 'fail' ? '回复失败' : '已停止回复');
  } finally { client.close(); await app.close(); await f.close(); }
});

test('native history repair rotates the generation after restart', async () => {
  const f = await fixture();
  const turns = [{ id: 'repair-turn', status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'repair-user', clientId: 'repair-input', content: [{ type: 'text', text: 'input' }] },
    { type: 'agentMessage', id: 'repair-answer', text: 'original', phase: 'final_answer' },
  ] }];
  const path = f.appServer.env.FAKE_SERVER_STATE!;
  await writeFile(path, JSON.stringify({ threadId: 'thread-fake', turns, next: 10 }));
  try {
    let old = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      let view: ChatView | undefined;
      const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
      try {
        await eventually(async () => !!view);
        if (attempt) assert.equal((await client.historySync({ kind: 'newer', sessionId: view!.sessionId, after: old })).kind, 'resyncRequired');
        const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
        assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
        assert.equal(start.records.at(-1)?.message.text, attempt ? 'repaired' : 'original'); old = start.head;
      } finally { client.close(); await app.close(); await partner.close(); }
      const state = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(path, 'utf8')));
      state.turns[0].items[1].text = 'repaired'; await writeFile(path, JSON.stringify(state));
    }
  } finally { await f.close(); }
});

test('an in-flight history projection does not block live native submission', async () => {
  const f = await fixture();
  const turns = Array.from({ length: 90 }, (_, i) => ({ id: `backlog-${i}`, status: 'completed', startedAt: 1700000000 + i, items: [
    { type: 'userMessage', id: `backlog-u-${i}`, clientId: `backlog-input-${i}`, content: [{ type: 'text', text: `human ${i}` }] },
    { type: 'agentMessage', id: `backlog-a-${i}`, text: `agent ${i}`, phase: 'final_answer' },
  ] }));
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', turns, next: 1000 }));
  const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: ChatView | undefined, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; }, () => {});
  const original = partner.chatVisible;
  let pending: Promise<unknown> | undefined;
  try {
    await eventually(async () => !!view?.before);
    const start = await client.historySync({ kind: 'start', sessionId: view!.sessionId });
    assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
    let armed = true;
    partner.chatVisible = async id => { if (armed) { armed = false; entered(); await gate; } return original(id); };
    pending = client.historySync({ kind: 'older', sessionId: view!.sessionId, before: start.before! });
    await blocked;
    const operationId = crypto.randomUUID();
    const submission = client.submit({ operationId, text: 'sent during history' }).catch(() => null);
    await eventually(async () => (await f.requests()).some(row => row.method === 'turn/start' && (row.params as { clientUserMessageId?: string }).clientUserMessageId === operationId));
    release(); await pending; await submission;
  } finally { release(); await pending?.catch(() => {}); partner.chatVisible = original; client.close(); await app.close(); await f.close(); }
});
