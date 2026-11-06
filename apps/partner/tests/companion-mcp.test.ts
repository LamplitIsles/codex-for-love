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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['create_alarm', 'delete_alarm', 'edit_alarm', 'favorite_sticker', 'inspect_sticker', 'list_alarms', 'list_diary', 'list_pack_stickers', 'list_photos', 'list_sticker_favorites', 'list_sticker_packs', 'read_conversation_record', 'read_diary', 'read_relationship_history', 'roll_dice', 'search_conversation', 'search_stickers', 'send_sticker', 'send_ui', 'send_voice', 'set_signature', 'update_relationship', 'update_sticker_metadata']);
    assert.match(tools.tools.find(tool => tool.name === 'send_ui')?.description ?? '', /local tabs, media playback and modal opening/u);
    const uiTool = tools.tools.find(tool => tool.name === 'send_ui');
    const uiSchema = JSON.stringify(uiTool?.inputSchema);
    assert.match(uiSchema, /workspace:images%2Fphoto\.png/u);
    assert.match(uiSchema, /workspace:music%2Fsong\.wav/u);
    assert.match(uiSchema, /workspace:video%2Fclip\.mp4/u);
    assert.match(uiSchema, /live files/u);
    assert.equal((await client.callTool({ name: 'send_ui', arguments: { ui: {} } })).isError, true);
    const created = await client.callTool({ name: 'create_alarm', arguments: { message: 'Check the tea', schedule: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() } } }) as { content: Array<{ text: string }> };
    const alarm = JSON.parse(created.content[0]!.text) as { id: string; message: string; schedule: unknown; nextAt: number; createdAt: number };
    assert.equal(alarm.message, 'Check the tea');
    const edited = await client.callTool({ name: 'edit_alarm', arguments: { id: alarm.id, message: 'Check the kettle' } }) as { content: Array<{ text: string }> };
    const editedAlarm = JSON.parse(edited.content[0]!.text) as typeof alarm;
    assert.deepEqual(editedAlarm, { ...alarm, message: 'Check the kettle' });
    const listed = await client.callTool({ name: 'list_alarms', arguments: {} }) as { content: Array<{ text: string }> };
    assert.equal((JSON.parse(listed.content[0]!.text) as Array<{ id: string; message: string }>)[0]?.message, 'Check the kettle');
    const deleted = await client.callTool({ name: 'delete_alarm', arguments: { id: alarm.id } }) as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(deleted.content[0]!.text), { deleted: true });
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

test('Companion returns the existing Voice projection for cached ElevenLabs audio', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'companion-voice-'));
  const script = fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url));
  const config = join(workspace, 'partner.toml');
  const id = createHash('sha256').update(JSON.stringify([2, 'elevenlabs', 'eleven_v4', 'fake-voice', 1, 'hello'])).digest('hex');
  const bytes = Buffer.alloc(417); bytes.set([0xff, 0xfb, 0x90, 0]);
  await mkdir(join(workspace, '.lamplit/audio'), { recursive: true });
  await writeFile(join(workspace, '.lamplit/audio', `${id}.mp3`), bytes);
  await writeFile(config, 'name = "test"\nprompts = { persona = "persona.md" }\nstate = "state"\n[speech]\nendpoint = false\n[speech.tts]\nprovider = "elevenlabs"\nvoice = "fake-voice"\n');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, workspace, config], stderr: 'ignore' }));
  try {
    const result = await client.callTool({ name: 'send_voice', arguments: { text: 'hello' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0].text), { kind: 'voice', audioId: id });
    const nextId = createHash('sha256').update(JSON.stringify([2, 'minimax', 'speech-2.8-hd', 'next-voice', 1.5, 'hello'])).digest('hex');
    await writeFile(join(workspace, '.lamplit/audio', `${nextId}.mp3`), bytes);
    const { createTtsSettings } = await import('../runtime/tts-settings.ts');
    await createTtsSettings(join(workspace, 'state'), () => ({ credentials: {} })).save({ provider: 'minimax', voice: 'next-voice', speed: 1.5 });
    const next = await client.callTool({ name: 'send_voice', arguments: { text: 'hello' } });
    assert.deepEqual(JSON.parse((next.content as Array<{ text: string }>)[0].text), { kind: 'voice', audioId: nextId });
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

test('Companion discovers bounded packs, keeps Agent favorites separate and returns a representative frame', async () => {
  const sharp = (await import('sharp')).default;
  const { StickerCatalog, packStickerId } = await import('../runtime/sticker-catalog.ts');
  const workspace = await mkdtemp(join(tmpdir(), 'sticker-mcp-'));
  const bytes = await sharp(Buffer.from([255,0,0,255, 0,255,0,255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100,100], loop: 0 }).toBuffer();
  const catalog = await StickerCatalog.open(workspace);
  await catalog.importPack({ id: 'cats', name: '猫', description: '可爱', stickers: [{ id: 'one', file: 'one.gif', name: '挥手', tags: ['开心'] }] }, new Map([['one.gif', { bytes, mediaType: 'image/gif' }]]));
  const stickerId = packStickerId('cats', 'one');
  const client = new Client({ name: 'test', version: '1.0.0' });
  const script = fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, workspace], stderr: 'ignore' }));
  try {
    const packs = await client.callTool({ name: 'list_sticker_packs', arguments: { limit: 1, query: '猫' } });
    assert.match(JSON.stringify(packs), /可爱/u);
    const members = await client.callTool({ name: 'list_pack_stickers', arguments: { packId: 'cats', limit: 1 } });
    assert.match(JSON.stringify(members), /挥手/u);
    const found = await client.callTool({ name: 'search_stickers', arguments: { query: '开心', limit: 1 } });
    assert.match(JSON.stringify(found), /挥手/u);
    await client.callTool({ name: 'favorite_sticker', arguments: { stickerId, favorite: true } });
    assert.equal((await catalog.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.length, 0);
    assert.equal((await catalog.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers[0]?.id, stickerId);
    const sent = await client.callTool({ name: 'send_sticker', arguments: { stickerId } }) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    assert.equal(JSON.parse(sent.content[0]!.text!).kind, 'sticker');
    assert.equal(sent.content[1]!.mimeType, 'image/jpeg');
    assert.equal((await sharp(Buffer.from(sent.content[1]!.data!, 'base64'), { animated: true }).metadata()).pages ?? 1, 1);
    assert.equal((await sharp(bytes, { animated: true }).metadata()).pages, 2);
    assert.equal((await client.callTool({ name: 'favorite_sticker', arguments: { conversationImageId: 'a'.repeat(64), favorite: true, name: 'bad', tags: [] } })).isError, true);
    const imageId = createHash('sha256').update('test-owned-chat-image').digest('hex');
    const imagePath = join(workspace, 'chat.gif'); await writeFile(imagePath, bytes);
    await writeFile(join(workspace, '.lamplit', 'conversation-images.json'), JSON.stringify([{ id: imageId, filename: 'chat.gif', path: imagePath, mediaType: 'image/gif', created: Date.now(), origin: 'human', available: true }]));
    const saved = await client.callTool({ name: 'favorite_sticker', arguments: { conversationImageId: imageId, favorite: true, name: '聊天', tags: ['收藏'] } });
    assert.equal(saved.isError, undefined);
    assert.equal((await catalog.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.length, 2);
    assert.equal((await catalog.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.length, 0);
    assert.deepEqual(await (await import('node:fs/promises')).readFile(imagePath), bytes);
    const uploaded = await client.callTool({ name: 'favorite_sticker', arguments: { data: bytes.toString('base64'), mediaType: 'image/gif', favorite: true, name: '上传', tags: [] } });
    assert.equal(uploaded.isError, undefined);
    assert.equal((await catalog.listStickers({ participant: 'agent', cursor: null, limit: 10 })).stickers.length, 3);
    assert.equal((await catalog.listStickers({ participant: 'human', cursor: null, limit: 10 })).stickers.length, 0);
    assert.equal((await client.callTool({ name: 'favorite_sticker', arguments: { data: 'bad!', mediaType: 'image/gif', favorite: true, name: 'bad', tags: [] } })).isError, true);
  } finally { await client.close(); catalog.close(); await rm(workspace, { recursive: true, force: true }); }
});
