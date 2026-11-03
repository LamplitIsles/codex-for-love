import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listDiary, readDiary } from './diary.ts';
import { panelCursors } from './panel-cursor.ts';
import { dirname } from 'node:path';
import { canonicalizeChangeReason, canonicalizeHistoryRead, canonicalizeRelationshipUpdate, canonicalizeSignature, MOODS } from './relationship-domain.ts';
import { rollDice } from './tools/dice-core.ts';
import { readRelationshipJournal, updateRelationshipJournal } from './relationship-journal.ts';
import { partnerPaths } from './storage-paths.ts';
import { loadConfig, loadCredentials } from './config.ts';
import { synthesizeSpeech } from './speech.ts';
import { elevenLabsSpeech } from './elevenlabs-voice.ts';
import { pageConversationImages, readConversationImages, withAvailability } from './conversation-images.ts';
import { StickerCatalog, stickerMetadataSchema } from './sticker-catalog.ts';
import { inspectStickerImage } from './sticker-image.ts';
import { stickerToolDescriptions } from './sticker-tool-descriptions.ts';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ImageInput } from './images.ts';
import { createConversationSearch } from './conversation-search.ts';
import { alarmMessageSchema, alarmScheduleSchema, createAlarm, deleteAlarm, editAlarm, listAlarms } from './alarms.ts';

const workspace = process.argv[2];
if (!workspace) throw new Error('Companion MCP requires a workspace path');
const configPath = process.argv[3];
const journal = partnerPaths(workspace).relationshipJournal;
const conversationImages = partnerPaths(workspace).conversationImages;
const alarms = partnerPaths(workspace).alarms;
const conversationSearch = createConversationSearch({ workspace });
const cursors = panelCursors();
const stickers = await StickerCatalog.open(workspace);
const server = new McpServer({ name: 'companion', version: '0.1.0' });
const reaction = { mood: z.object({ value: z.enum(MOODS), note: z.string().optional(), reason: z.string() }).strict().optional(), affinity: z.object({ delta: z.number().int().min(-10).max(10), reason: z.string() }).strict().optional() };
server.registerTool('update_relationship', { description: 'Record a current mood or relationship reaction with concise factual reasons.', inputSchema: reaction }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(await updateRelationshipJournal(journal, canonicalizeRelationshipUpdate(input))) }] }));
server.registerTool('set_signature', { description: 'Set a short profile signature with a concise factual reason.', inputSchema: { signature: z.string(), reason: z.string() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(await updateRelationshipJournal(journal, { signature: { value: canonicalizeSignature(input.signature), reason: canonicalizeChangeReason(input.reason) } })) }] }));
server.registerTool('read_relationship_history', { description: 'Read recent relationship state records.', inputSchema: { limit: z.number().int().min(1).max(20).optional(), cursor: z.string().min(1).max(2048).optional() } }, async (input) => {
  const records = await readRelationshipJournal(journal);
  const position = cursors.decode('relationshipHistory', workspace, input.cursor ?? null);
  const end = position === undefined ? records.length : Number(position);
  if (!Number.isSafeInteger(end) || end < 0 || end > records.length) throw new Error('Invalid cursor');
  const start = Math.max(0, end - canonicalizeHistoryRead(input.limit === undefined ? {} : { limit: input.limit }));
  return { content: [{ type: 'text', text: JSON.stringify({ records: records.slice(start, end).reverse(), predecessor: records[start - 1] ?? null, nextCursor: start ? cursors.encode('relationshipHistory', workspace, String(start)) : null }) }] };
});
server.registerTool('list_diary', { description: 'List dated memory diary entries in bounded newest-first pages.', inputSchema: { cursor: z.string().min(1).max(2048).optional() } }, async ({ cursor }) => {
  const after = cursors.decode('diaryList', workspace, cursor ?? null);
  const all = (await listDiary(workspace)).filter(name => after === undefined || name < after);
  const entries = all.slice(0, 30);
  return { content: [{ type: 'text', text: JSON.stringify({ entries, nextCursor: all.length > entries.length ? cursors.encode('diaryList', workspace, entries.at(-1)!) : null }) }] };
});
server.registerTool('read_diary', { description: 'Read one dated memory diary entry within the UTF-8 byte limit.', inputSchema: { name: z.string().regex(/^\d{4}-\d{2}-\d{2}\.md$/u) } }, async ({ name }) => {
  const entry = await readDiary(workspace, name);
  return { content: [{ type: 'text', text: JSON.stringify(entry) }] };
});
server.registerTool('list_photos', { description: 'List our shared photo library: human-sent, Agent-generated, and restored historical conversation images, newest first in bounded pages. Returned local paths may be inspected deliberately with native tools.', inputSchema: { limit: z.number().int().min(1).max(50).optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{54}$/u).optional() } }, async ({ limit, cursor }) => {
  const page = pageConversationImages(await withAvailability(await readConversationImages(conversationImages)), limit ?? 5, cursor);
  return { content: [{ type: 'text', text: JSON.stringify({ images: page.images.map(({ id, filename, path, created, origin, available }) => ({ id, filename, path, directory: dirname(path), created, origin, available })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }) }] };
});
server.registerTool('search_conversation', { description: 'Find text in our conversation records. Returns bounded highlighted excerpts; read a selected record for its full text and nearby context.', inputSchema: { query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).optional() } }, async ({ query, limit }) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await conversationSearch.search(query, limit ?? 5)) }] }; }
  catch { return { content: [{ type: 'text' as const, text: 'Conversation search is unavailable' }], isError: true }; }
});
server.registerTool('read_conversation_record', { description: 'Read one selected conversation search result in full with nearby context.', inputSchema: { id: z.uuid() } }, async ({ id }) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await conversationSearch.read(id)) }] }; }
  catch { return { content: [{ type: 'text' as const, text: 'Conversation record is unavailable' }], isError: true }; }
});
server.registerTool('roll_dice', { description: 'Roll dice with an optional modifier and label.', inputSchema: { count: z.number().int().min(1).max(100).optional(), sides: z.number().int().min(2).max(1_000_000), modifier: z.number().int().min(-1_000_000).max(1_000_000).optional(), label: z.string().max(200).optional() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(rollDice(input)) }] }));
server.registerTool('create_alarm', { description: 'Schedule a message to yourself. At the due time it wakes this same conversation as your own reminder, not as a Human message. Choose once (ISO datetime with offset), interval (everyMinutes, minimum 5), daily (hour, minute, IANA timeZone), or weekly (same plus weekday 0=Sunday). It does not automatically send to Keet.', inputSchema: { message: alarmMessageSchema, schedule: alarmScheduleSchema } }, async ({ message, schedule }) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(createAlarm(alarms, message, schedule)) }] }; }
  catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Could not create alarm' }], isError: true }; }
});
server.registerTool('list_alarms', { description: 'List your current alarms and their next due times.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(listAlarms(alarms)) }] }));
server.registerTool('edit_alarm', { description: 'Change the message of an existing alarm without changing its schedule or next due time. An already admitted reminder keeps its original message.', inputSchema: { id: z.uuid(), message: alarmMessageSchema } }, async ({ id, message }) => {
  const alarm = editAlarm(alarms, id, message);
  return alarm ? { content: [{ type: 'text' as const, text: JSON.stringify(alarm) }] } : { content: [{ type: 'text' as const, text: 'Alarm not found' }], isError: true };
});
server.registerTool('delete_alarm', { description: 'Cancel one of your alarms by ID.', inputSchema: { id: z.uuid() } }, async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify({ deleted: deleteAlarm(alarms, id) }) }] }));
server.registerTool('send_voice', { description: 'Send one standalone Voice message. Use only for a short deliberate spoken message; it never adds a transcript.', inputSchema: { text: z.string().trim().min(1).max(240) } }, async ({ text }, extra) => {
  try {
    if (!configPath) throw new Error('Voice dispatch is unavailable');
    const config = await loadConfig(configPath); const tts = config.speech?.tts;
    if (!tts) throw new Error('Voice dispatch is unavailable');
    const audioDir = partnerPaths(workspace).audio;
    const id = tts.provider === 'minimax'
      ? await synthesizeSpeech({ ...tts, text, audioDir, signal: extra.signal })
      : tts.provider === 'elevenlabs'
        ? await synthesizeSpeech({ ...tts, text, audioDir, signal: extra.signal, elevenLabs: (normalized, signal) => elevenLabsSpeech({ workspace, socketPath: config.codex.socket_path, text: normalized, voice: tts.voice, signal }) })
        : await (async () => { const credentials = await loadCredentials(config.state); return synthesizeSpeech({ ...tts, endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', model: tts.provider === 'alibaba' ? 'qwen3-tts-flash' : 'seed-tts-2.0', credential: tts.provider === 'alibaba' ? credentials.speech ?? '' : credentials.tts ?? '', text, audioDir, signal: extra.signal }); })();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'voice', audioId: id }) }] };
  } catch (error) { return { content: [{ type: 'text' as const, text: 'Voice synthesis failed' }], isError: true }; }
});
const stickerPage = { limit: z.number().int().min(1).max(30).optional(), cursor: z.string().min(1).max(16).optional(), query: z.string().max(100).optional() };
const stickerId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
server.registerTool('list_sticker_packs', { description: stickerToolDescriptions.listPacks, inputSchema: stickerPage }, async input => ({ content: [{ type: 'text', text: JSON.stringify(await stickers.listPacks({ cursor: input.cursor ?? null, limit: input.limit ?? 10, query: input.query })) }] }));
server.registerTool('list_pack_stickers', { description: stickerToolDescriptions.listPackStickers, inputSchema: { packId: stickerId, limit: stickerPage.limit, cursor: stickerPage.cursor } }, async input => {
  if (!await stickers.getPack(input.packId)) throw new Error('Pack unavailable');
  return { content: [{ type: 'text', text: JSON.stringify(await stickers.listStickers({ packId: input.packId, cursor: input.cursor ?? null, limit: input.limit ?? 10 })) }] };
});
server.registerTool('search_stickers', { description: stickerToolDescriptions.searchStickers, inputSchema: stickerPage }, async input => ({ content: [{ type: 'text', text: JSON.stringify(await stickers.listStickers({ cursor: input.cursor ?? null, limit: input.limit ?? 10, query: input.query })) }] }));
server.registerTool('list_sticker_favorites', { description: stickerToolDescriptions.listFavorites, inputSchema: stickerPage }, async input => ({ content: [{ type: 'text', text: JSON.stringify(await stickers.listStickers({ participant: 'agent', cursor: input.cursor ?? null, limit: input.limit ?? 10, query: input.query })) }] }));
server.registerTool('inspect_sticker', { description: stickerToolDescriptions.inspect, inputSchema: { stickerId } }, async input => {
  try {
    const current = await stickers.get(input.stickerId);
    if (!current?.available) throw new Error('unavailable');
    const asset = await stickers.asset(current.id, current.version);
    const result = await inspectStickerImage(asset.original, asset.sticker.mediaType);
    return { content: [
      { type: 'text' as const, text: JSON.stringify({ id: asset.sticker.id, version: asset.sticker.version, name: asset.sticker.name, tags: asset.sticker.tags, mediaType: asset.sticker.mediaType, animated: result.frames > 1, frameCount: result.frames, sampledFrames: result.sampledFrames, ...(result.frames > 1 ? { notice: 'Sampled frames may omit animation content.' } : {}) }) },
      ...result.images.map(image => ({ type: 'image' as const, mimeType: 'image/jpeg', data: image.toString('base64') })),
    ] };
  } catch { return { content: [{ type: 'text' as const, text: 'Sticker unavailable, unreadable or exceeds image limits' }], isError: true }; }
});
server.registerTool('update_sticker_metadata', { description: stickerToolDescriptions.updateMetadata, inputSchema: { stickerId, ...stickerMetadataSchema.shape } }, async ({ stickerId, ...changes }) => ({ content: [{ type: 'text', text: JSON.stringify(await stickers.updateMetadata(stickerId, changes)) }] }));
server.registerTool('favorite_sticker', { description: stickerToolDescriptions.favorite, inputSchema: { stickerId: stickerId.optional(), conversationImageId: z.string().regex(/^[a-f0-9]{64}$/u).optional(), data: z.string().max(Math.ceil(5 * 1024 * 1024 / 3) * 4).optional(), mediaType: z.enum(['image/png','image/jpeg','image/webp','image/gif']).optional(), favorite: z.boolean(), name: z.string().min(1).refine(value => [...value].length <= 160).optional(), tags: z.array(z.string().min(1).refine(value => [...value].length <= 80)).max(32).optional() } }, async input => {
  if ([input.stickerId, input.conversationImageId, input.data].filter(Boolean).length !== 1) throw new Error('Choose one sticker, conversation image or upload');
  if (input.stickerId) return { content: [{ type: 'text' as const, text: JSON.stringify({ sticker: await stickers.favorite('agent', input.stickerId, input.favorite), favorite: input.favorite }) }] };
  if (!input.favorite || !input.name || !input.tags) throw new Error('Image favorite requires a name and tags');
  if (input.data) {
    const bytes = Buffer.from(input.data, 'base64');
    if (!input.mediaType || !bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== input.data) throw new Error('Invalid image upload');
    const sticker = await stickers.favoriteImage('agent', { kind: 'upload' }, { name: input.name, tags: input.tags, bytes, mediaType: input.mediaType });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ sticker, favorite: true }) }] };
  }
  const images = await withAvailability(await readConversationImages(conversationImages));
  const image = images.find(entry => entry.id === input.conversationImageId);
  if (!image?.available) throw new Error('Conversation image unavailable');
  const file = await open(image.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) throw new Error('Conversation image unavailable'); bytes = await file.readFile(); if (bytes.length !== stat.size) throw new Error('Conversation image changed'); } finally { await file.close(); }
  const sticker = await stickers.favoriteImage('agent', { kind: 'chat', imageId: image.id }, { name: input.name, tags: input.tags, bytes, mediaType: image.mediaType as ImageInput['mediaType'] });
  return { content: [{ type: 'text' as const, text: JSON.stringify({ sticker, favorite: true }) }] };
});
server.registerTool('send_sticker', { description: stickerToolDescriptions.send, inputSchema: { stickerId } }, async input => {
  const current = await stickers.get(input.stickerId);
  if (!current?.available) throw new Error('Sticker unavailable');
  const asset = await stickers.asset(current.id, current.version);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'sticker', id: current.id, version: current.version, name: current.name, tags: current.tags, mediaType: current.mediaType }) }, { type: 'image' as const, mimeType: 'image/jpeg', data: asset.model.toString('base64') }] };
});
await server.connect(new StdioServerTransport());
