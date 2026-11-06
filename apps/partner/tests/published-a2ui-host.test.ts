import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { A2UI_BASIC_CATALOG_ID, validateA2UISurface, workspaceMediaUrl, type ChatView } from '@lamplit/contracts';
import { openChat } from '@lamplit/contracts/client';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';

// Test-owned contract example; no upstream fixture or unpublished build is used.
const surface = { version: '1.0', createSurface: { surfaceId: 'test', catalogId: A2UI_BASIC_CATALOG_ID, components: [
  { id: 'root', component: 'Column', children: ['label', 'image', 'audio', 'video'] },
  { id: 'label', component: 'Text', text: 'Test interface' },
  { id: 'image', component: 'Image', url: 'workspace:picture.png' },
  { id: 'audio', component: 'AudioPlayer', url: 'workspace:file%2520name.wav' },
  { id: 'video', component: 'Video', url: 'workspace:clip.mp4' },
] } };
const uiId = (turn: string, id: string) => `ui:${createHash('sha256').update(JSON.stringify([turn, id])).digest('hex')}`;
const item = (id: string, ui: unknown, extras: Record<string, unknown> = {}) => ({ type: 'mcpToolCall', id, server: 'companion', tool: 'send_ui', status: 'completed', error: null,
  arguments: { secret: 'PRIVATE_ARGS' }, result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'ui', ui }) }], structuredContent: { secret: 'PRIVATE_RESULT' } }, ...extras });
function wav() {
  const b = Buffer.alloc(172, 0x23); b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(128, 40); return b;
}

test('published validator and actual Companion MCP accept supported UI and reject unsafe input', async () => {
  const f = await fixture(), client = new Client({ name: 'published-ui-test', version: '1' });
  const script = fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, f.workspace], stderr: 'ignore' }));
  try {
    assert.deepEqual(validateA2UISurface(surface), surface);
    const sent = await client.callTool({ name: 'send_ui', arguments: { ui: surface } });
    assert.notEqual(sent.isError, true);
    assert.deepEqual(JSON.parse((sent.content as Array<{ text: string }>)[0]!.text), { kind: 'ui', ui: surface });
    // Unknown component properties and unsupported media schemes are rejected by the shared boundary.
    const invalid = structuredClone(surface); invalid.createSurface.components[2]!.url = 'javascript:alert(1)';
    assert.throws(() => validateA2UISurface(invalid));
    assert.equal((await client.callTool({ name: 'send_ui', arguments: { ui: invalid } })).isError, true);
  } finally { await client.close(); await f.close(); }
});

test('published shared host preserves valid and damaged UI through history, reconnect and restart', async () => {
  const f = await fixture(), turnId = 'ui-history';
  const bad = { version: '9.0', private: 'invalid but bounded' };
  const oversized = item('oversized', null, { result: { content: [{ type: 'text', text: 'PRIVATE_HUGE'.repeat(12_000) }] } });
  const first = { id: turnId, status: 'completed', startedAt: 1700000000, items: [
    { type: 'userMessage', id: 'user-start', clientId: 'first-input', content: [{ type: 'text', text: 'hello' }] },
    { type: 'agentMessage', id: 'before', text: 'before', phase: 'commentary' },
    item('good', surface), item('bad', bad), item('too-large-ui', { payload: 'x'.repeat(20_000) }), oversized, item('failed', surface, { status: 'failed' }),
    { type: 'agentMessage', id: 'after', text: 'after', phase: 'final_answer' },
  ] };
  const turns = [first, ...Array.from({ length: 40 }, (_, i) => ({ id: `later-${i}`, status: 'completed', startedAt: 1700000001 + i, items: [
    { type: 'userMessage', id: `user-${i}`, clientId: `input-${i}`, content: [{ type: 'text', text: `input ${i}` }] },
    { type: 'agentMessage', id: `answer-${i}`, text: `answer ${i}`, phase: 'final_answer' },
  ] }))];
  await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: 'thread-fake', next: 100, turns }));
  try {
    let previous: unknown;
    for (let restart = 0; restart < 2; restart++) {
      const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`;
      let view: ChatView | undefined;
      const connect = () => openChat(new WebSocket(url), value => { view = value; }, () => {});
      let client = await connect();
      try {
        await eventually(async () => !!view);
        const messages = [...view!.messages]; let cursor = view!.before;
        while (cursor) {
          const retained = cursor, page = await client.history(retained);
          assert.ok(page.messages.length && page.messages.length <= 30);
          client.close(); view = undefined; client = await connect(); await eventually(async () => !!view);
          assert.deepEqual(await client.history(retained), page);
          messages.unshift(...page.messages); cursor = page.before;
        }
        const mixed = messages.filter(message => message.turnId === turnId);
        assert.deepEqual(mixed.map(message => message.id), ['first-input', 'before', uiId(turnId, 'good'), uiId(turnId, 'bad'), uiId(turnId, 'too-large-ui'), uiId(turnId, 'oversized'), 'after']);
        assert.deepEqual(validateA2UISurface(mixed[2]!.ui), surface);
        assert.deepEqual(mixed[3]!.ui, bad);
        assert.throws(() => validateA2UISurface(mixed[3]!.ui));
        assert.deepEqual(mixed[4]!.ui, {});
        assert.deepEqual(mixed[5]!.ui, {});
        assert.equal(JSON.stringify(messages).includes('PRIVATE_'), false);
        assert.equal(new Set(messages.map(message => message.id)).size, messages.length);
        if (previous) assert.deepEqual(messages, previous); previous = messages;
      } finally { client.close(); await app.close(); }
    }
  } finally { await f.close(); }
});

test('published host delivers UI, bounded fallback and later text patches with workspace media ranges', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true'; f.appServer.env.FAKE_TIMELINE_USER_START = 'true';
  const partner = await f.createPartner(), app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(origin.replace('http:', 'ws:') + '/api/chat/socket'), next => { view = next; }, () => {});
  try {
    await eventually(async () => !!view);
    const operationId = crypto.randomUUID(); await client.submit({ operationId, text: 'live ui' });
    await eventually(async () => !!(await f.nativeState()).active);
    const turnId = (await f.nativeState()).active as string;
    await f.streamCommand({ action: 'timeline', entries: [
      { method: 'item/completed', item: item('live-good', surface) },
      { method: 'item/completed', item: item('live-invalid', { version: '9.0' }) },
      { method: 'item/completed', item: item('live-bound', { payload: 'x'.repeat(20_000) }) },
      { method: 'item/completed', item: item('live-huge', null, { result: { content: [{ type: 'text', text: 'PRIVATE_HUGE'.repeat(12_000) }] } }) },
    ] });
    const boundId = uiId(turnId, 'live-bound');
    await eventually(async () => view?.messages.some(message => message.id === boundId) === true
      && view.messages.some(message => message.id === uiId(turnId, 'live-huge')));
    assert.deepEqual(view!.messages.filter(message => message.id === boundId).map(({ id, ui }) => ({ id, ui })), [{ id: boundId, ui: {} }]);
    assert.deepEqual(validateA2UISurface(view!.messages.find(message => message.id === uiId(turnId, 'live-good'))!.ui), surface);
    assert.deepEqual(view!.messages.find(message => message.id === uiId(turnId, 'live-huge'))!.ui, {});
    await f.streamCommand({ action: 'advance', text: 'later text patch' });
    await eventually(async () => view?.messages.some(message => message.text === 'later text patch') === true);
    assert.deepEqual(view!.messages.filter(message => message.id === boundId).map(({ id, ui }) => ({ id, ui })), [{ id: boundId, ui: {} }]);
    assert.deepEqual(view!.messages.find(message => message.id === uiId(turnId, 'live-huge'))!.ui, {});
    assert.deepEqual(view!.messages.find(message => message.id === uiId(turnId, 'live-invalid'))!.ui, { version: '9.0' });
    assert.throws(() => validateA2UISurface(view!.messages.find(message => message.id === uiId(turnId, 'live-invalid'))!.ui));
    assert.equal(JSON.stringify(view).includes('PRIVATE_'), false);

    const picture = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#4488aa' } }).png().toBuffer();
    const audio = wav(), video = await import('node:fs/promises').then(fs => fs.readFile(new URL('./fixtures/workspace-video.mp4', import.meta.url)));
    await writeFile(join(f.workspace, 'picture.png'), picture); await writeFile(join(f.workspace, 'file%20name.wav'), audio); await writeFile(join(f.workspace, 'clip.mp4'), video);
    const imageUrl = workspaceMediaUrl('workspace:picture.png', 'image')!, audioUrl = workspaceMediaUrl('workspace:file%2520name.wav', 'audio')!, videoUrl = workspaceMediaUrl('workspace:clip.mp4', 'video')!;
    assert.ok(imageUrl && audioUrl && videoUrl);
    assert.deepEqual(Buffer.from(await (await fetch(origin + imageUrl)).arrayBuffer()), picture);
    assert.deepEqual(Buffer.from(await (await fetch(origin + videoUrl)).arrayBuffer()), video);
    const range = await fetch(origin + audioUrl, { headers: { range: 'bytes=0-19' } }); assert.equal(range.status, 206);
    const version = range.headers.get('x-cfl-media-version')!; assert.deepEqual(Buffer.from(await range.arrayBuffer()), audio.subarray(0, 20));
    const nextRange = await fetch(origin + audioUrl, { headers: { range: 'bytes=20-', 'if-cfl-media-version': version } });
    assert.equal(nextRange.status, 206); assert.deepEqual(Buffer.from(await nextRange.arrayBuffer()), audio.subarray(20));
    const modifiedAudio = Buffer.from(audio); modifiedAudio[44] ^= 1;
    await writeFile(join(f.workspace, 'file%20name.wav'), modifiedAudio);
    const stale = await fetch(origin + audioUrl, { headers: { range: 'bytes=0-1', 'if-cfl-media-version': version } });
    assert.equal(stale.status, 412, 'a changed file cannot provide old-version bytes');
  } finally { client.close(); await app.close(); await f.close(); }
});
