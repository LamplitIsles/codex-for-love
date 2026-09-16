import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRelationshipJournal } from '../runtime/relationship-journal.ts';

test('Companion MCP serves bounded journal tools over stdio', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'companion-mcp-'));
  const script = fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, workspace], stderr: 'ignore' }));
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['read_relationship_history', 'roll_dice', 'send_voice', 'set_signature', 'update_relationship']);
    const changed = await client.callTool({ name: 'update_relationship', arguments: { affinity: { delta: 10, reason: 'test' }, mood: { value: 'bright', reason: 'test' } } });
    assert.match(JSON.stringify(changed), /\\"affinity\\":60/);
    const invalid = await client.callTool({ name: 'update_relationship', arguments: { affinity: { delta: 11, reason: 'no' } } });
    assert.equal(invalid.isError, true);
    const signature = await client.callTool({ name: 'set_signature', arguments: { signature: 'Mica', reason: 'test' } });
    assert.match(JSON.stringify(signature), /Mica/);
    const history = await client.callTool({ name: 'read_relationship_history', arguments: { limit: 1 } });
    assert.match(JSON.stringify(history), /Mica/);
    const dice = await client.callTool({ name: 'roll_dice', arguments: { sides: 6, count: 2 } });
    assert.match(JSON.stringify(dice), /\\"rolls\\"/);
  } finally { await client.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('separate Companion MCP processes serialize concurrent journal updates', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'companion-mcp-concurrent-'));
  const script = fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url));
  const connect = async () => { const client = new Client({ name: 'test', version: '1.0.0' }); await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, workspace], stderr: 'ignore' })); return client; };
  const [first, second] = await Promise.all([connect(), connect()]);
  try {
    await Promise.all([
      first.callTool({ name: 'update_relationship', arguments: { mood: { value: 'bright', reason: 'first' } } }),
      second.callTool({ name: 'set_signature', arguments: { signature: 'Mica', reason: 'second' } }),
    ]);
    const records = await readRelationshipJournal(join(workspace, '.lamplit', 'relationship.jsonl'));
    assert.equal(records.length, 2);
    assert.equal(records.some((record) => record.changes.mood?.reason === 'first'), true);
    assert.equal(records.some((record) => record.changes.signature?.reason === 'second'), true);
  } finally { await first.close(); await second.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('journal rejects an affinity delta inconsistent with its predecessor', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'companion-mcp-invalid-delta-'));
  const journal = join(workspace, '.lamplit', 'relationship.jsonl');
  try {
    await (await import('node:fs/promises')).mkdir(join(workspace, '.lamplit'));
    await writeFile(journal, `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', changes: { affinity: { value: 60, delta: 5, reason: 'bad' } }, state: { mood: 'neutral', affinity: 60, signature: '' } })}\n`);
    await assert.rejects(readRelationshipJournal(journal), /affinity change/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
