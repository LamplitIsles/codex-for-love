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
  const connect = () => openChat(new WS(host.origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { cookie: 'native-test-owner=1', origin: host.origin } }) as unknown as WebSocket, v => { view = v; }, () => {});
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
    await eventually(async () => view?.streamingReply?.text === 'first\r');
    const id = view!.streamingReply!.id;
    await control('advance', 'first\r\nsecond');
    await eventually(async () => view?.streamingReply?.text === 'first\r\nsecond');
    assert.equal(view!.streamingReply!.id, id);
    client.close();
    assert.deepEqual(await control('status'), { ...start, itemId: id });
    client = await connect(); await eventually(async () => view?.streamingReply?.id === id);
    const completed = await control('complete', 'first\r\nsecond final'); assert.equal(completed.completed, true); assert.equal(completed.held, false);
    await eventually(async () => !view?.streamingReply && !!view?.messages.some(m => m.id === id));
    const current = JSON.parse(await readFile(join(root, 'native-current.json'), 'utf8'));
    assert.ok(JSON.stringify(current.native).includes(privateSentinel), 'sentinel really exists in official native reasoning');
    assert.equal(current.requests.filter((r: { method: string }) => r.method === 'turn/start').length, 1);
    assert.ok(current.requests.some((r: { method: string; params?: { input?: { text?: string }[] } }) => r.method === 'turn/start' && r.params?.input?.some(i => i.text === 'Test-owned sentence acceptance input')));
    assert.equal(JSON.stringify(view).includes(privateSentinel), false);
    for (const terminal of ['stop', 'fail']) {
      await control('start', `temporary ${terminal}`);
      await control(terminal);
      await eventually(async () => !view?.streamingReply && view?.activeTurnId === null);
      assert.ok(view!.messages.some(m => m.text === (terminal === 'stop' ? '已停止回复' : '回复失败')));
    }
    const session = view!.sessionId; await control('session');
    await eventually(async () => !!view && view.sessionId !== session);
    assert.equal(view!.messages.length, 0); assert.equal(view!.streamingReply, undefined);
  } finally { client.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
