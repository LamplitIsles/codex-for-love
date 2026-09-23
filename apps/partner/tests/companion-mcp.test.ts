import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRelationshipJournal } from '../runtime/relationship-journal.ts';

test('Companion MCP serves bounded journal tools over stdio', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'companion-mcp-'));
  const script = fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url));
  const images = [
    { id: createHash('sha256').update('new').digest('hex'), filename: 'new.png', path: join(workspace, 'images', 'new.png'), mediaType: 'image/png', created: 30, origin: 'agent', available: true },
    { id: createHash('sha256').update('middle').digest('hex'), filename: 'middle.png', path: join(workspace, 'images', 'middle.png'), mediaType: 'image/png', created: 20, origin: 'human', available: true },
    { id: createHash('sha256').update('old').digest('hex'), filename: 'old.png', path: join(workspace, 'images', 'old.png'), mediaType: 'image/png', created: 10, origin: 'historical', available: true },
    { id: createHash('sha256').update('older').digest('hex'), filename: 'older.png', path: join(workspace, 'images', 'older.png'), mediaType: 'image/png', created: 9, origin: 'historical', available: true },
    { id: createHash('sha256').update('oldest').digest('hex'), filename: 'oldest.png', path: join(workspace, 'images', 'oldest.png'), mediaType: 'image/png', created: 8, origin: 'historical', available: true },
    { id: createHash('sha256').update('first').digest('hex'), filename: 'first.png', path: join(workspace, 'images', 'first.png'), mediaType: 'image/png', created: 7, origin: 'historical', available: true },
  ];
  await mkdir(join(workspace, '.lamplit'), { recursive: true }); await mkdir(join(workspace, 'images'), { recursive: true });
  for (const image of images) await writeFile(image.path, 'test');
  await writeFile(join(workspace, '.lamplit', 'conversation-images.json'), JSON.stringify(images));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, workspace], stderr: 'ignore' }));
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['list_photos', 'read_conversation_record', 'read_relationship_history', 'roll_dice', 'search_conversation', 'send_voice', 'set_signature', 'update_relationship']);
    assert.match(tools.tools.find((tool) => tool.name === 'list_photos')?.description ?? '', /our shared photo library: human-sent, Agent-generated, and restored historical conversation images/u);
    const defaultPage = await client.callTool({ name: 'list_photos', arguments: {} }) as { content: Array<{ text: string }> };
    assert.equal((JSON.parse((defaultPage.content[0] as { text: string }).text) as { images: unknown[] }).images.length, 5);
    const firstPage = await client.callTool({ name: 'list_photos', arguments: { limit: 2 } }) as { content: Array<{ text: string }> };
    const first = JSON.parse((firstPage.content[0] as { text: string }).text) as { images: Array<{ filename: string; path: string; directory: string; available: boolean }>; nextCursor?: string };
    assert.deepEqual(first.images.map((image) => image.filename), ['new.png', 'middle.png']); assert.equal(first.images[0]?.path, images[0]?.path); assert.equal(first.images[0]?.directory, join(workspace, 'images')); assert.equal(first.images[0]?.available, true); assert.ok(first.nextCursor); assert.match(first.nextCursor!, /^[A-Za-z0-9_-]{54}$/u); assert.doesNotMatch(first.nextCursor!, /new|middle|30/); assert.doesNotMatch(JSON.stringify(first), /data|base64/);
    const secondPage = await client.callTool({ name: 'list_photos', arguments: { limit: 2, cursor: first.nextCursor } }) as { content: Array<{ text: string }> };
    assert.deepEqual((JSON.parse((secondPage.content[0] as { text: string }).text) as { images: Array<{ filename: string }> }).images.map((image) => image.filename), ['old.png', 'older.png']);
    const invalidCursor = await client.callTool({ name: 'list_photos', arguments: { cursor: 'a'.repeat(53) } });
    assert.equal(invalidCursor.isError, true);
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
