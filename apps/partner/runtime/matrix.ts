import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const boundedId = z.string().refine(value => value.length <= 255);
const id = boundedId.refine(value => value.length > 0);
export const matrixEvent = z.object({
  type: z.literal('message'), event_id: id, room_id: id, sender_id: id,
  sender_display_name: boundedId, timestamp: z.number().int().refine(Number.isSafeInteger),
  body: z.string().refine(value => value.length <= 16_000), mentions: z.array(boundedId).max(100),
  reply_to_event_id: boundedId.optional(),
  reply_to_sender_id: boundedId.regex(/^@[^\s:]+:[^\s]+$/u).optional(), truncated: z.boolean(),
}).strict().refine(event => event.reply_to_sender_id === undefined || Boolean(event.reply_to_event_id), {
  message: 'Reply author requires a nonempty reply target', path: ['reply_to_sender_id'],
});
export type MatrixEvent = z.infer<typeof matrixEvent>;
export type MatrixContext = { provenance: MatrixEvent; trigger: 'mention' | 'reply' | 'alias'; roomContext?: string };
export function matrixInputId(event: MatrixEvent): string {
  return `matrix:webhook:${createHash('sha256').update(JSON.stringify([event.room_id, event.event_id])).digest('hex')}`;
}
export function classifyMatrixTrigger(event: MatrixEvent, self: string, aliases: readonly string[] = []): MatrixContext['trigger'] | undefined {
  if (event.sender_id === self || !event.body.trim()) return undefined;
  if (event.mentions.includes(self)) return 'mention';
  if (event.reply_to_sender_id === self) return 'reply';
  if (aliases.some(alias => event.body.includes(alias))) return 'alias';
  return undefined;
}
export function matrixInput(event: MatrixEvent): string {
  return `[Matrix sender ${JSON.stringify(event.sender_id)} (${JSON.stringify(event.sender_display_name)}), room ${JSON.stringify(event.room_id)}]\n${event.body}`;
}

/** One bounded startup probe. Never retain gateway errors containing credentials. */
export async function discoverMatrixSelf(endpoint: string, token: string): Promise<string> {
  const client = new Client({ name: 'codex-for-love-matrix-discovery', version: '1.0.0' });
  const signal = AbortSignal.timeout(5_000);
  const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  try {
    await client.connect(transport, { signal, timeout: 5_000 });
    const result = await client.callTool({ name: 'whoami', arguments: {} }, undefined, { signal, timeout: 5_000 });
    if (result.isError || !Array.isArray(result.content)) throw new Error();
    const part = result.content.find(part => part.type === 'text');
    const identity = JSON.parse(typeof part?.text === 'string' ? part.text : 'null');
    return z.string().regex(/^@[^\s:]+:[^\s]+$/u).refine(value => value.length <= 255).parse(identity?.user_id);
  } catch { throw new Error('Matrix startup discovery failed; check the local gateway endpoint and private matrix credential'); }
  finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
}
