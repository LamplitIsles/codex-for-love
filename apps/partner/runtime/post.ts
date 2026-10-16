import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PostEventV1, ToolOutputs, type EventV1 } from './post-contract.ts';
import { postEndpoint } from './config.ts';

export type PostAccounts = Map<string, 'qq' | 'matrix'>;
export function receiverAuthorized(header: string | undefined, secret: string): boolean {
  const actual = Buffer.from(header ?? ''), expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function validatePost(value: unknown, agent: string, accounts: PostAccounts): EventV1 {
  const event = PostEventV1.parse(value), m = event.message;
  if (event.agent_id !== agent || accounts.get(m.account_id) !== m.platform || m.direction !== 'inbound' || m.mutation !== null) throw new Error('Invalid Post binding or message');
  const refs = new Set(m.content.flatMap(part => 'asset_id' in part ? [part.asset_id] : []));
  const assets = new Set(m.assets.map(asset => asset.asset_id));
  if (assets.size !== m.assets.length || refs.size !== assets.size || [...refs].some(id => !assets.has(id))) throw new Error('Invalid Post asset references');
  for (const asset of m.assets) {
    if (asset.status === 'available' ? asset.size === null || asset.download_path !== `/assets/${encodeURIComponent(asset.asset_id)}` : asset.size !== null || asset.download_path !== null) throw new Error('Invalid Post asset metadata');
  }
  return event;
}
export function postInputId(service: string, event: EventV1): string {
  const m = event.message;
  return `post:v1:${createHash('sha256').update(JSON.stringify([service, event.agent_id, m.account_id, m.conversation.id, m.id])).digest('hex')}`;
}
export function postInput(event: EventV1, media: Record<string, string> = {}): string {
  const m = event.message;
  const text = m.content.map(part => part.type === 'text' ? part.text : part.type === 'mention' ? `[mention ${JSON.stringify(part.native_user_id)}]` : `[${part.type} ${JSON.stringify(part.asset_id)}: ${media[part.asset_id] ?? m.assets.find(a => a.asset_id === part.asset_id)!.status}]`).join('\n');
  return `[Post ${m.platform}; account ${JSON.stringify(m.account_id)}; conversation ${JSON.stringify(m.conversation.id)}; sender ${JSON.stringify(m.sender.native_id)}]\n${text}`;
}
/** Authenticated account discovery uses the same native MCP transport contract. */
export async function discoverPost(endpoint: string, token: string): Promise<PostAccounts> {
  const client = new Client({ name: 'codex-for-love-post-discovery', version: '1' });
  const signal = AbortSignal.timeout(5_000);
  const transport = new StreamableHTTPClientTransport(new URL(`${postEndpoint(endpoint)}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  try {
    await client.connect(transport, { signal, timeout: 5_000 });
    const result = await client.callTool({ name: 'list_accounts', arguments: {} }, undefined, { signal, timeout: 5_000 });
    if (result.isError) throw new Error();
    const value = ToolOutputs.list_accounts.parse(result.structuredContent);
    if (!value.items.length || new Set(value.items.map(a => a.account_id)).size !== value.items.length) throw new Error();
    return new Map(value.items.map(a => [a.account_id, a.platform]));
  } catch { throw new Error('Post startup discovery failed; check endpoint and private agent credential'); }
  finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
}
