import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Real stateless HTTP MCP with synthetic credentials, no installed service. */
export async function matrixGateway() {
  const token = 'synthetic-matrix-only-token';
  const requests: Array<{ method: string; tool?: string }> = [];
  const active = new Set<McpServer>();
  const sockets = new Set<import('node:net').Socket>();
  let identity: unknown = { user_id: '@self:test', device_id: 'TEST' };
  let mode: 'normal' | 'error' | 'hang' = 'normal';
  let closed = 0;
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ method: body.method, ...(body.params?.name ? { tool: body.params.name } : {}) });
    if (mode === 'hang') return;
    const server = new McpServer({ name: 'matrix', version: '1.0.0' });
    for (const name of ['whoami', 'list_rooms', 'list_room_members', 'read_messages', 'send_message']) {
      server.registerTool(name, { inputSchema: {} }, async () => ({
        ...(mode === 'error' ? { isError: true } : {}),
        content: [{ type: 'text' as const, text: mode === 'error' ? token : JSON.stringify(name === 'whoami' ? identity : []) }],
      }));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    active.add(server);
    res.once('close', () => { active.delete(server); closed++; void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  http.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  return {
    endpoint: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token, requests,
    get closed() { return closed; }, get sockets() { return sockets.size; }, get active() { return active.size; },
    set identity(value: unknown) { identity = value; }, set mode(value: typeof mode) { mode = value; },
    async close() {
      await Promise.all([...active].map(server => server.close()));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
}
