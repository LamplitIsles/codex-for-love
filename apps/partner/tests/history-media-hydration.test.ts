import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, eventually } from './fixture.ts';

test('incomplete or cyclic native history never publishes a partial media directory', async t => {
  const f = await fixture(); let partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId;
  const index = join(f.workspace, '.lamplit', 'conversation-media.json');
  const control = f.appServer.env.FAKE_SERVER_CONTROL!;
  const mcp = new Client({ name: 'history-media-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url)), f.workspace], stderr: 'ignore' }));
  try {
    // A real terminal empty page still yields a usable empty directory.
    assert.deepEqual((await partner.conversationMedia(sessionId, 'voice')).items, []);
    for (const text of ['send voice first', 'send voice second']) {
      const id = crypto.randomUUID(); await partner.submit(id, text);
      await eventually(async () => { const view = await partner.snapshot(); return !view.typing && view.results.some(result => result.sourceIds.includes(id) && result.voices.length === 1); });
    }
    const expected = (await partner.conversationMedia(sessionId, 'voice')).items;
    assert.equal(expected.length, 2);
    for (const fault of ['turns-empty', 'turns-cycle', 'items-empty', 'items-cycle'] as const) {
      await t.test(fault, async () => {
        const oldSnapshot = await readFile(index, 'utf8');
        await partner.close();
        await writeFile(control, JSON.stringify({ historyHydrationFault: fault }));
        const before = (await f.requests()).length;
        await assert.rejects(f.createPartner(), /Incomplete or cyclic turn (?:history|item) pagination/);
        const requests = (await f.requests()).slice(before);
        const method = fault.startsWith('turns-') ? 'thread/turns/list' : 'thread/items/list';
        const pages = requests.filter(request => request.method === method && (method !== 'thread/items/list' || (request.params as {turnId?: string}).turnId));
        assert.equal(pages.length, fault.endsWith('empty') ? 2 : 3);
        assert.equal(await readFile(index, 'utf8'), oldSnapshot, 'failed hydration must not publish its partial view');
        const result = await mcp.callTool({ name: 'list_conversation_media', arguments: { kind: 'voice' } });
        assert.equal(result.isError, true, 'old snapshot must not be readable after failed startup');
        await writeFile(control, '{}');
        partner = await f.createPartner();
        assert.deepEqual((await partner.conversationMedia(sessionId, 'voice')).items, expected);
      });
    }
  } finally { await mcp.close(); await partner.close(); await f.close(); }
});
