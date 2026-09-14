import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canonicalizeChangeReason, canonicalizeHistoryRead, canonicalizeRelationshipUpdate, canonicalizeSignature, MOODS } from '../src/lib/companion/domain.ts';
import { rollDice } from './tools/dice-core.ts';
import { readRelationshipJournal, updateRelationshipJournal } from './relationship-journal.ts';
import { partnerPaths } from './storage-paths.ts';

const workspace = process.argv[2];
if (!workspace) throw new Error('Companion MCP requires a workspace path');
const journal = partnerPaths(workspace).relationshipJournal;
const server = new McpServer({ name: 'companion', version: '0.1.0' });
const reaction = { mood: z.object({ value: z.enum(MOODS), note: z.string().optional(), reason: z.string() }).strict().optional(), affinity: z.object({ delta: z.number().int().min(-10).max(10), reason: z.string() }).strict().optional() };
server.registerTool('companion_update_relationship', { description: 'Record a current mood or relationship reaction with concise factual reasons.', inputSchema: reaction }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(await updateRelationshipJournal(journal, canonicalizeRelationshipUpdate(input))) }] }));
server.registerTool('companion_set_signature', { description: 'Set a short profile signature with a concise factual reason.', inputSchema: { signature: z.string(), reason: z.string() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(await updateRelationshipJournal(journal, { signature: { value: canonicalizeSignature(input.signature), reason: canonicalizeChangeReason(input.reason) } })) }] }));
server.registerTool('companion_read_history', { description: 'Read recent relationship state records.', inputSchema: { limit: z.number().int().min(1).max(20).optional() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify((await readRelationshipJournal(journal)).reverse().slice(0, canonicalizeHistoryRead(input))) }] }));
server.registerTool('roll_dice', { description: 'Roll dice with an optional modifier and label.', inputSchema: { count: z.number().int().min(1).max(100).optional(), sides: z.number().int().min(2).max(1_000_000), modifier: z.number().int().min(-1_000_000).max(1_000_000).optional(), label: z.string().max(200).optional() } }, async (input) => ({ content: [{ type: 'text', text: JSON.stringify(rollDice(input)) }] }));
await server.connect(new StdioServerTransport());
