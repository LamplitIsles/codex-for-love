import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WS from 'ws';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { textVoiceHost } from './text-voice-acceptance-host.ts';
import { eventually } from './fixture.ts';

test('sentence controls exercise native ingress, held execution, privacy, session and terminal truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-sentence-controls-'));
  const host = await textVoiceHost(root, root);
  let view: ChatView | undefined;
  const observed: ChatView[] = [];
  let socket: WS | undefined;
  const connect = () => {
    socket = new WS(host.origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { cookie: 'native-test-owner=1', origin: host.origin } });
    return openChat(socket as unknown as WebSocket, v => { view = v; observed.push(v); }, () => {});
  };
  let client = await connect();
  const control = async (action: string, text?: string) => {
    const response = await fetch(host.controlUrl, { method: 'POST', body: JSON.stringify({ action, text }) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const privateSentinel = 'CFL_REASONING_PRIVATE_SENTINEL';
  try {
    await eventually(async () => !!view?.before);
    assert.equal(JSON.stringify(view).includes(privateSentinel), false);
    assert.equal(view!.messages.some(m => m.thinking), false);
    const older = await client.history(view!.before!);
    assert.ok(older.messages.some(m => m.text === '更早第一行。\n更早第二行。'), 'one real older page reaches the approved older marker');
    assert.equal(JSON.stringify(older).includes(privateSentinel), false);
    const start = await control('start', 'first\r'); assert.equal(start.held, true);
    // The ordered timeline owns the preview; it must not also appear in the legacy slot.
    await eventually(async () => view?.messages.find(m => m.id === start.itemId)?.text === 'first\r');
    const first = view!.messages.find(m => m.id === start.itemId)!;
    assert.equal(first.textState, 'streaming');
    assert.equal(first.role, 'agent');
    assert.equal(first.turnId, start.generationId);
    assert.equal(view!.streamingReply, undefined);
    const id = first.id;
    await control('advance', 'first\r\nsecond');
    await eventually(async () => {
      const message = view?.messages.find(m => m.id === id);
      return message?.text === 'first\r\nsecond' && JSON.stringify(message.ends) === '[7]';
    });
    const advanced = view!.messages.find(m => m.id === id)!;
    assert.equal(advanced.textState, 'streaming');
    assert.equal(advanced.createdAt, first.createdAt);
    client.close();
    assert.deepEqual(await control('status'), { ...start, itemId: id });
    view = undefined;
    client = await connect();
    await eventually(async () => view?.messages.find(m => m.id === id)?.text === 'first\r\nsecond');
    assert.deepEqual(view!.messages.find(m => m.id === id), advanced);
    assert.equal(view!.streamingReply, undefined);
    const completed = await control('complete', 'first\r\nsecond final'); assert.equal(completed.completed, true); assert.equal(completed.held, false);
    await eventually(async () => !!view?.messages.some(m => m.id === id && m.textState === 'complete' && m.text === 'first\r\nsecond final') && view.activeTurnId === null);
    assert.equal(view!.messages.filter(m => m.id === id).length, 1);
    assert.equal(view!.streamingReply, undefined);
    const current = JSON.parse(await readFile(join(root, 'native-current.json'), 'utf8'));
    assert.ok(JSON.stringify(current.native).includes(privateSentinel), 'sentinel really exists in official native reasoning');
    assert.equal(current.requests.filter((r: { method: string }) => r.method === 'turn/start').length, 1);
    assert.ok(current.requests.some((r: { method: string; params?: { input?: { text?: string }[] } }) => r.method === 'turn/start' && r.params?.input?.some(i => i.text === 'Test-owned sentence acceptance input')));
    assert.equal(JSON.stringify(view).includes(privateSentinel), false);
    for (const terminal of ['stop', 'fail']) {
      const attempt = await control('start', `temporary ${terminal}`);
      await eventually(async () => view?.messages.find(m => m.id === attempt.itemId)?.text === `temporary ${terminal}`);
      assert.equal(view!.messages.find(m => m.id === attempt.itemId)!.textState, 'streaming');
      await control(terminal);
      await eventually(async () => !!view && !view.streamingReply && view.activeTurnId === null && !view.messages.some(m => m.textState === 'streaming'));
      assert.equal(view!.messages.some(m => m.id === attempt.itemId || m.text === `temporary ${terminal}`), false);
      assert.ok(view!.messages.some(m => m.text === (terminal === 'stop' ? '已停止回复' : '回复失败')));
    }
    const session = view!.sessionId; const oldSocket = socket!; const replacement = await control('session');
    assert.notEqual(replacement.sessionId, session);
    await eventually(async () => oldSocket.readyState === WS.CLOSED);
    client.close(); view = undefined; client = await connect();
    await eventually(async () => view?.sessionId === replacement.sessionId);
    assert.equal(view!.messages.length, 0); assert.equal(view!.streamingReply, undefined);
    const fresh = await control('start', 'fresh session line\n');
    await eventually(async () => view?.messages.some(m => m.id === fresh.itemId && m.text === 'fresh session line\n') === true);
    await control('complete', 'fresh session line\n');
    await eventually(async () => view?.messages.some(m => m.id === fresh.itemId && m.textState === 'complete') === true);
    const priorSocket = socket!; const immediateSession = await control('session');
    await eventually(async () => priorSocket.readyState === WS.CLOSED);
    client.close(); view = undefined;
    // The runner may start a reply before the browser has reconnected.
    const immediate = await control('start', 'immediate line\n');
    client = await connect();
    await eventually(async () => view?.sessionId === immediateSession.sessionId && view.messages.some(m => m.id === immediate.itemId && m.text === 'immediate line\n'));
    assert.equal(view!.messages.some(m => m.text === 'fresh session line\n'), false);
    await control('complete', 'immediate line\n');
    await eventually(async () => view?.messages.some(m => m.id === immediate.itemId && m.textState === 'complete') === true);
    const replacedSocket = socket!; const reset = await control('reset');
    assert.notEqual(reset.sessionId, immediateSession.sessionId);
    await eventually(async () => replacedSocket.readyState === WS.CLOSED);
    client.close(); view = undefined; client = await connect();
    await eventually(async () => view?.sessionId === reset.sessionId && !!view.before);
    assert.equal(view!.messages.some(m => m.id === immediate.itemId || m.text === 'immediate line\n'), false);
    const afterReset = await control('start', 'reset line\n');
    await eventually(async () => view?.messages.some(m => m.id === afterReset.itemId && m.text === 'reset line\n') === true);
    await control('complete', 'reset line\n');
    await eventually(async () => view?.messages.some(m => m.id === afterReset.itemId && m.textState === 'complete') === true);
    for (const observation of observed) {
      assert.equal(JSON.stringify(observation).includes(privateSentinel), false);
      assert.equal(observation.messages.some(m => m.thinking), false);
      assert.ok(observation.messages.filter(m => m.textState === 'streaming').length <= 1);
      assert.equal(new Set(observation.messages.map(m => m.id)).size, observation.messages.length);
    }
  } finally { client.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('text and voice control reset replaces the partner and leaves a usable public chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-text-voice-reset-'));
  const host = await textVoiceHost(root);
  let view: ChatView | undefined;
  let socket: WS | undefined;
  const connect = () => {
    socket = new WS(host.origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { cookie: 'native-test-owner=1', origin: host.origin } });
    return openChat(socket as unknown as WebSocket, value => { view = value; }, () => {});
  };
  const control = async (action: string) => {
    const response = await fetch(host.controlUrl, { method: 'POST', body: JSON.stringify({ action }) });
    assert.equal(response.status, 200); return response.json();
  };
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    const initial = await control('reset');
    assert.equal(initial.executions, 0); assert.deepEqual(initial.takes, []);
    client = await connect();
    await eventually(async () => view?.sessionId === initial.sessionId);
    await client.submit({ operationId: crypto.randomUUID(), text: 'before fixture reset' });
    await eventually(async () => view?.messages.some(m => m.text === 'before fixture reset') === true);
    await control('complete');
    await eventually(async () => view?.messages.some(m => m.text === '完整回复' && m.textState === 'complete') === true);
    const oldSocket = socket!; const reset = await control('reset');
    assert.equal(reset.executions, 0); assert.deepEqual(reset.takes, []);
    await eventually(async () => oldSocket.readyState === WS.CLOSED);
    client.close(); view = undefined; client = await connect();
    await eventually(async () => view?.sessionId === reset.sessionId);
    assert.equal(view!.messages.some(m => m.text === 'before fixture reset'), false);
    await client.submit({ operationId: crypto.randomUUID(), text: 'after fixture reset' });
    await eventually(async () => view?.messages.some(m => m.text === 'after fixture reset') === true);
  } finally { client?.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
