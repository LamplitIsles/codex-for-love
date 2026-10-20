import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PostEventV1, ToolOutputs, type EventV1, type ContentV1 } from './post-contract.ts';
import { postEndpoint } from './config.ts';

export type PostAccounts = Map<string, 'qq' | 'matrix'>;
export function receiverAuthorized(header: string | undefined, secret: string): boolean {
  const actual = Buffer.from(header ?? ''), expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function validatePost(value: unknown, agent: string): EventV1 {
  const event = PostEventV1.parse(value), m = event.message;
  if (event.agent_id !== agent || m.direction !== 'inbound' || m.mutation !== null) throw new Error('Invalid Post binding or message');
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
function postPart(m: EventV1['message'], part: ContentV1, media: Record<string, string>): string {
  return part.type === 'text' ? part.text : part.type === 'mention' ? `[mention ${JSON.stringify(part.native_user_id)}]` : `[${part.type} ${JSON.stringify(part.asset_id)}: ${media[part.asset_id] ?? m.assets.find(a => a.asset_id === part.asset_id)!.status}]`;
}
export function postBody(event: EventV1, media: Record<string, string> = {}): string {
  return event.message.content.map(part => postPart(event.message, part, media)).join('\n');
}

/** Display only: retained event facts, never routing or naming authority. */
export function postPresentation(event: EventV1, media: Record<string, string>, conversationName?: string) {
  const m = event.message;
  const label = (value: string | undefined) => value?.trim() ? Array.from(value.trim()).slice(0, 256).join('') : undefined;
  const attached = [...new Set(m.content.flatMap(part => part.type === 'image' && media[part.asset_id] === 'attached' ? [part.asset_id] : []))];
  const senderDisplayName = label(m.sender.name);
  const name = label(conversationName) ?? (m.conversation.type === 'direct' && m.conversation.native_id === m.sender.native_id ? senderDisplayName : undefined);
  return {
    source: { kind: 'post' as const, platform: m.platform, conversationType: m.conversation.type,
      conversationId: m.conversation.id, ...(name ? { conversationName: name } : {}),
      senderId: m.sender.native_id, ...(senderDisplayName ? { senderDisplayName } : {}) },
    parts: m.content.map(part => ({ text: postPart(m, part, media),
      ...(part.type === 'image' && attached.includes(part.asset_id) ? { imageIndex: attached.indexOf(part.asset_id) } : {}) })),
    imageCount: attached.length, timestamp: m.timestamp,
  };
}

export function postInput(event: EventV1, media: Record<string, string> = {}, display?: { conversationName: string | null }): string {
  const m = event.message;
  const text = postBody(event, media);
  if (display) {
    const label = (value: string) => JSON.stringify(Array.from(value.trim()).slice(0, 256).join('')).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const conversation = display.conversationName?.trim() ? label(display.conversationName) : `unknown (conversation ID ${label(m.conversation.id)})`;
    const sender = m.sender.name?.trim() ? label(m.sender.name) : `unknown (ID ${label(m.sender.native_id)})`;
    return `[Post ${m.platform}; ${m.conversation.type} ${conversation}; sender ${sender}]\n${text}`;
  }
  return `[Post ${m.platform}; account ${JSON.stringify(m.account_id)}; conversation ${JSON.stringify(m.conversation.id)}; sender ${JSON.stringify(m.sender.native_id)}]\n${text}`;
}
/** Bounded authenticated MCP reads against the configured Post service. */
async function postTool(endpoint: string, token: string, name: 'list_accounts' | 'get_conversation', args: Record<string, unknown>, ownerSignal?: AbortSignal): Promise<unknown> {
  const client = new Client({ name: 'codex-for-love-post-discovery', version: '1' });
  const retire = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(5_000), retire.signal, ...(ownerSignal ? [ownerSignal] : [])]);
  const requests = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    requests.add(task);
    void task.then(() => requests.delete(task), () => requests.delete(task));
    return task;
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${postEndpoint(endpoint)}/mcp`), {
    // The SDK replaces requestInit.signal. Its public fetch hook must bind
    // both the actual request/body and their settlement to the ingress owner.
    ...(ownerSignal ? { fetch: (url: string | URL, init?: RequestInit) => track((async () => {
      signal.throwIfAborted();
      const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
      if (!response.body) return response;
      const body = new TransformStream<Uint8Array, Uint8Array>();
      track(response.body.pipeTo(body.writable, { signal })).catch(() => undefined);
      return new Response(body.readable, { status: response.status, statusText: response.statusText, headers: response.headers });
    })()) } : {}),
    requestInit: { headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  try {
    await client.connect(transport, { signal, timeout: 5_000 });
    const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 5_000 });
    if (result.isError) throw new Error();
    return result.structuredContent;
  } catch { throw new Error('Post MCP lookup failed'); }
  finally {
    retire.abort();
    await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
    while (requests.size) await Promise.allSettled([...requests]);
  }
}

export async function discoverPost(endpoint: string, token: string, ownerSignal?: AbortSignal): Promise<PostAccounts> {
  try {
    const value = ToolOutputs.list_accounts.parse(await postTool(endpoint, token, 'list_accounts', {}, ownerSignal));
    if (!value.items.length || new Set(value.items.map(a => a.account_id)).size !== value.items.length) throw new Error();
    return new Map(value.items.map(a => [a.account_id, a.platform]));
  } catch { throw new Error('Post startup discovery failed; check endpoint and private agent credential'); }
}

/** Optional display data for already accepted work; never authorizes a message. */
export async function postConversationName(endpoint: string, token: string, event: EventV1, signal: AbortSignal): Promise<string | null> {
  try {
    const m = event.message;
    const value = ToolOutputs.get_conversation.parse(await postTool(endpoint, token, 'get_conversation', { account_id: m.account_id, conversation_id: m.conversation.id }, signal));
    if (value.account_id !== m.account_id || value.conversation_id !== m.conversation.id || value.native_id !== m.conversation.native_id || value.type !== m.conversation.type) return null;
    const name = value.name?.trim();
    return name ? Array.from(name).slice(0, 256).join('') : null;
  } catch { return null; }
}
