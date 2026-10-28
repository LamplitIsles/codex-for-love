import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readFile } from 'node:fs/promises';
import { ToolInputs } from '../runtime/post-contract.ts';
import type { EventV1 } from '../runtime/post-contract.ts';

// Fixed canonical examples @ lamplit-post 96f771c08aa7f217dbfb195617f7fd1021071ef3.
export const examples = JSON.parse(await readFile(new URL('./post-examples.json', import.meta.url), 'utf8'));
export const event = (id: string, platform: 'qq' | 'matrix' = 'qq'): EventV1 => {
  const e = structuredClone(examples.event) as EventV1;
  e.delivery_id = `dlv_${id}`; e.message.id = `msg_${id}`;
  e.message.native_message_id = `native_${id}`; e.message.platform = platform;
  e.message.account_id = `${platform}-main`; e.message.sequence++;
  return e;
};
type LookupMode = 'normal' | 'fail' | 'unauthorized' | 'stall-headers' | 'stall-body';
export async function postService() {
  const token = 'test-only-post-agent-token', receiver = 'test-only-post-receiver';
  const requests: Array<{ method?: string; tool?: string; args?: Record<string, unknown>; path?: string; authorization?: string }> = [];
  const bytes = Buffer.from(examples.upload.body_base64, 'base64');
  const assetBytes = new Map<string,Buffer>();
  const active = new Set<McpServer>();
  let assetMode: 'normal' | 'fail' | 'redirect' | 'stall' | 'oversize' | 'mime' | 'corrupt' = 'normal';
  let redirectTo = 'http://127.0.0.1:1/token-leak';
  let accountMode: LookupMode = 'normal';
  let conversationMode: LookupMode = 'normal';
  let conversationOpen = 0;
  let discoveryOpen = 0;
  let assetOpen = 0;
  let conversationResult: unknown = examples.tools.get_conversation.result;
  let conversationPages: Record<string, unknown> | undefined;
  let accountResult: unknown = { items: ['qq', 'matrix'].map(platform => ({ ...examples.tools.list_accounts.result.items[0], account_id: `${platform}-main`, platform })) };
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.url?.startsWith('/assets')) {
      assetOpen++; res.once('close', () => { assetOpen--; });
      if (assetMode === 'fail') { res.writeHead(503).end(); return; }
      if (assetMode === 'redirect') { res.writeHead(302, { location: redirectTo }).end(); return; }
      if (assetMode === 'stall') { res.writeHead(200, { 'content-type': 'image/png' }); res.write(bytes.subarray(0,8)); return; }
      if (req.method === 'POST') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        if (!Buffer.concat(chunks).equals(bytes)) { res.writeHead(400).end(); return; }
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(examples.upload.result)); return;
      }
      res.writeHead(200, { 'content-type': assetMode === 'mime' ? 'text/plain' : 'image/png', ...(assetMode === 'oversize' ? { 'content-length': String(17 * 1024 * 1024) } : {}) });
      res.end(assetMode === 'corrupt' ? Buffer.alloc(bytes.length) : assetBytes.get(decodeURIComponent((req.url ?? '').slice('/assets/'.length))) ?? bytes); return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ method: body.method, tool: body.params?.name, args: body.params?.arguments });
    if (body.params?.name === 'list_accounts' || body.params?.name === 'list_conversations') {
      const discovery = body.params.name === 'list_accounts';
      const mode = discovery ? accountMode : conversationMode;
      if (discovery) discoveryOpen++; else conversationOpen++;
      res.once('close', () => { if (discovery) discoveryOpen--; else conversationOpen--; });
      if (mode === 'unauthorized') { res.writeHead(401).end(); return; }
      if (mode === 'fail') { res.writeHead(503).end(); return; }
      if (mode === 'stall-headers') return;
      if (mode === 'stall-body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    }
    const mcp = new McpServer({ name: 'post', version: '1' });
    for (const [name, input] of Object.entries(ToolInputs)) mcp.registerTool(name, { inputSchema: input }, async (args: { before?: string }) => {
      const value = name === 'list_accounts' ? accountResult : name === 'list_conversations'
        ? conversationPages ? conversationPages[String((args as { before?: string }).before ?? '')] : { items: conversationResult === null ? [] : [conversationResult], next_before: null }
        : examples.tools[name].result;
      return { structuredContent: value as Record<string,unknown>, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    });
    active.add(mcp); res.once('close', () => { active.delete(mcp); void mcp.close(); });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport); await transport.handleRequest(req,res,body);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token, receiver, requests, bytes, assetBytes,
    set assetMode(value: typeof assetMode) { assetMode = value; },
    set redirectTo(value: string) { redirectTo = value; },
    get assetOpen() { return assetOpen; },
    get conversationOpen() { return conversationOpen; },
    set conversationMode(value: typeof conversationMode) { conversationMode = value; },
    get discoveryOpen() { return discoveryOpen; },
    set accountMode(value: typeof accountMode) { accountMode = value; },
    set conversation(value: unknown) { conversationResult = value; },
    set conversationPages(value: Record<string, unknown> | undefined) { conversationPages = value; },
    set accounts(value: unknown) { accountResult = value; },
    async close() { await Promise.all([...active].map(mcp => mcp.close())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
