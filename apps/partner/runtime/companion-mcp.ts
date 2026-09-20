import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dirname } from 'node:path';
import { canonicalizeChangeReason, canonicalizeHistoryRead, canonicalizeRelationshipUpdate, canonicalizeSignature, MOODS } from '../src/lib/companion/domain.ts';
import { rollDice } from './tools/dice-core.ts';
import { readRelationshipJournal, updateRelationshipJournal } from './relationship-journal.ts';
import { partnerPaths } from './storage-paths.ts';
import { loadConfig, loadCredentials } from './config.ts';
import { synthesizeSpeech } from './speech.ts';
import { pageConversationImages, readConversationImages, withAvailability } from './conversation-images.ts';

const workspace = process.argv[2];
if (!workspace) throw new Error('Companion MCP requires a workspace path');
const configPath = process.argv[3];
const journal = partnerPaths(workspace).relationshipJournal;
const conversationImages = partnerPaths(workspace).conversationImages;
const server = new McpServer({ name: 'companion', version: '0.1.0' });
const reaction = { mood: z.object({ value: z.enum(MOODS), note: z.string().optional(), reason: z.string() }).strict().optional(), affinity: z.object({ delta: z.number().int().min(-10).max(10), reason: z.string() }).strict().optional() };
server.registerTool('update_relationship', { description: 'Record a current mood or relationship reaction with concise factual reasons.', inputSchema: reaction }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(await updateRelationshipJournal(journal, canonicalizeRelationshipUpdate(input))) }] }));
server.registerTool('set_signature', { description: 'Set a short profile signature with a concise factual reason.', inputSchema: { signature: z.string(), reason: z.string() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(await updateRelationshipJournal(journal, { signature: { value: canonicalizeSignature(input.signature), reason: canonicalizeChangeReason(input.reason) } })) }] }));
server.registerTool('read_relationship_history', { description: 'Read recent relationship state records.', inputSchema: { limit: z.number().int().min(1).max(20).optional() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify((await readRelationshipJournal(journal)).reverse().slice(0, canonicalizeHistoryRead(input))) }] }));
server.registerTool('list_photos', { description: 'List our shared photo library: human-sent, Agent-generated, and restored historical conversation images, newest first in bounded pages. Returned local paths may be inspected deliberately with native tools.', inputSchema: { limit: z.number().int().min(1).max(50).optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{54}$/u).optional() } }, async ({ limit, cursor }) => {
  const page = pageConversationImages(await withAvailability(await readConversationImages(conversationImages)), limit ?? 5, cursor);
  return { content: [{ type: 'text', text: JSON.stringify({ images: page.images.map(({ id, filename, path, created, origin, available }) => ({ id, filename, path, directory: dirname(path), created, origin, available })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }) }] };
});
server.registerTool('roll_dice', { description: 'Roll dice with an optional modifier and label.', inputSchema: { count: z.number().int().min(1).max(100).optional(), sides: z.number().int().min(2).max(1_000_000), modifier: z.number().int().min(-1_000_000).max(1_000_000).optional(), label: z.string().max(200).optional() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(rollDice(input)) }] }));
server.registerTool('send_voice', { description: 'Send one standalone Voice message. Use only for a short deliberate spoken message; it never adds a transcript.', inputSchema: { text: z.string().trim().min(1).max(240) } }, async ({ text }) => {
  try {
    if (!configPath) throw new Error('Voice dispatch is unavailable');
    const config = await loadConfig(configPath); const tts = config.speech?.tts;
    if (!tts) throw new Error('Voice dispatch is unavailable');
    const credentials = await loadCredentials(config.state);
    const audioDir = partnerPaths(workspace).audio;
    const id = tts.provider === 'minimax'
      ? await synthesizeSpeech({ ...tts, text, audioDir })
      : await synthesizeSpeech({ ...tts, endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', model: tts.provider === 'alibaba' ? 'qwen3-tts-flash' : 'seed-tts-2.0', credential: tts.provider === 'alibaba' ? credentials.speech ?? '' : credentials.tts ?? '', text, audioDir });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'voice', audioId: id }) }] };
  } catch (error) { return { content: [{ type: 'text' as const, text: 'Voice synthesis failed' }], isError: true }; }
});
await server.connect(new StdioServerTransport());
