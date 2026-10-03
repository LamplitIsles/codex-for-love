import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openChat } from '@lamplit/contracts/client';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { createWebServer } from '../runtime/server.ts';
import { seedConversationSearch } from './conversation-search-seed.ts';
import { fixture } from './fixture.ts';

test('shared native search maps cards/context, preserves Unicode/full text and workspace ownership', async () => {
  const f = await fixture();
  try {
    const partner = await f.createPartner();
    const s = await seedConversationSearch(f.directory, f.workspace, f.config.codex.home!);
    const backend = createCodexChatBackend(partner, undefined, s.search);
    const before = await backend.read();
    const found = await backend.search({ query: '灯塔' });
    assert.equal(found.estimatedTotalHits, 23); assert.equal(found.limited, true); assert.equal(found.hits.length, 20);
    assert.equal(found.hits.filter(h => h.sessionId === 'archive-session').length, 20);
    assert.equal(found.hits[2]?.kind, 'compaction'); assert.equal('cwd' in found.hits[0]!, false);
    const read = await backend.searchRead({ id: s.recordIds.original });
    assert.equal('cwd' in read.record, false); assert.equal('messageId' in read.context, false);
    assert.equal(read.context.items.some(i => 'phase' in i), false);
    assert.equal(read.context.truncated, true);
    assert.equal(read.context.items.reduce((sum, i) => sum + Array.from(i.content).length, 0), 12000);
    assert.ok(read.context.items.reduce((sum, i) => sum + i.content.length, 0) > 12000, 'astral Unicode is not counted as UTF-16 units');
    const data = JSON.parse(await readFile(s.data, 'utf8'));
    data.records[0].content = 'large selected text '.repeat(10000);
    data.paths[s.recordIds.original][1].content = data.records[0].content;
    await writeFile(s.data, JSON.stringify(data));
    assert.equal((await backend.searchRead({ id: s.recordIds.original })).record.content, data.records[0].content);
    data.records[0].cwd = '/foreign-owner'; await writeFile(s.data, JSON.stringify(data));
    await assert.rejects(backend.searchRead({ id: s.recordIds.original }), /outside this workspace/);
    assert.equal((await backend.search({ query: 'large selected' })).hits.length, 0);
    assert.deepEqual(await backend.read(), before);
    const calls = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(c => c.cwd === f.workspace && c.home === f.config.codex.home));
    assert.ok(calls.some(c => c.args[0] === 'context'));
  } finally { await f.close(); }
});

test('actual socket isolates native failures and oversized reads, retries, and authorizes search delivery', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const s = await seedConversationSearch(f.directory, f.workspace, f.config.codex.home!);
  let authorized = true;
  const app = createWebServer(partner, '', { conversationSearch: s.search, authorize: async () => authorized });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`);
  const client = await openChat(socket, () => {}, () => {});
  try {
    for (const failure of ['search', 'get', 'context']) {
      await writeFile(s.control, JSON.stringify({ [failure]: true }));
      await assert.rejects(failure === 'search' ? client.search({ query: '灯塔' }) : client.searchRead({ id: s.recordIds.original }));
      assert.equal(socket.readyState, WebSocket.OPEN);
    }
    await writeFile(s.control, '{}');
    assert.equal((await client.searchRead({ id: s.recordIds.original })).record.id, s.recordIds.original);
    const data = JSON.parse(await readFile(s.data, 'utf8'));
    data.records[0].content = '🌙'.repeat(600000); data.paths[s.recordIds.original][1].content = data.records[0].content;
    await writeFile(s.data, JSON.stringify(data));
    await assert.rejects(client.searchRead({ id: s.recordIds.original }));
    assert.equal(socket.readyState, WebSocket.OPEN);
    const operationId = crypto.randomUUID();
    assert.equal((await client.submit({ operationId, text: 'normal chat after search failure' })).operationId, operationId);
    const logged = await readFile(s.log, 'utf8');
    authorized = false;
    await assert.rejects(client.search({ query: 'lighthouse' }));
    assert.equal(await readFile(s.log, 'utf8'), logged, 'revoked connection never calls native search');
  } finally { client.close(); socket.close(); await app.close(); await f.close(); }
});
