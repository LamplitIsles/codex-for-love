// Isolated actual CFL host. Controls delay/fail delivery; DTOs always come from native helper.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from './fixture.ts';
import { seedNativeConversationSearch } from './conversation-search-native-seed.ts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import type { Partner } from '../runtime/partner.ts';

export async function conversationSearchHost(browser: string, evidence: string) {
  let f = await fixture(), partner: Partner, seeded: Awaited<ReturnType<typeof seedNativeConversationSearch>>;
  const listeners = new Set<() => void>(); let unsubscribe = () => {};
  let calls: string[] = [], failures = new Set<string>(), heldKey: string | undefined;
  const held = new Set<() => void>();
  async function reset() {
    for (const release of held) release(); held.clear(); heldKey = undefined; failures.clear(); calls = [];
    unsubscribe(); await seeded?.close(); await f.close(); f = await fixture();
    seeded = await seedNativeConversationSearch(f.directory, f.workspace, f.config.codex.home!);
    partner = await f.createPartner(); unsubscribe = partner.subscribe(() => { for (const listener of listeners) listener(); });
    for (const listener of listeners) listener();
  }
  await reset();
  const facade = new Proxy({} as Partner, { get(_target, key) {
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const value = partner[key as keyof Partner]; return typeof value === 'function' ? value.bind(partner) : value;
  } });
  async function deliver<T>(method: string, key: string, read: () => Promise<T>): Promise<T> {
    calls.push(`${method === 'search' ? 'search' : 'read'}:${key}`);
    if (failures.has(method)) throw new Error('Test-owned delivery failure');
    const hold = key === heldKey ? new Promise<void>(resolve => held.add(resolve)) : undefined;
    const result = await read();
    if (hold) await hold;
    return result;
  }
  const search = { search: (query: string) => deliver('search', query, () => seeded.search.search(query)),
    read: (id: string) => deliver('searchRead', id, () => seeded.search.read(id)) };
  const app = createWebServer(facade, browser, { conversationSearch: search,
    authorize: async request => request.headers.cookie?.includes('search-test-owner=1') === true });
  app.server.prependListener('request', (request, response) => {
    if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'search-test-owner=1; Path=/; SameSite=Strict');
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const controls = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.action === 'reset') await reset();
      else if (input.action === 'failure') { if (input.enabled) failures.add(input.method); else failures.delete(input.method); }
      else if (input.action === 'hold') heldKey = input.key;
      else if (input.action === 'release') { heldKey = undefined; for (const release of held) release(); held.clear(); }
      else if (input.action !== 'state') throw new Error('Unknown test action');
      const view = await createCodexChatBackend(partner).read();
      const state = { calls, sessionId: view.sessionId, messages: view.messages, archiveSessionId: 'archive-session', recordIds: seeded.recordIds };
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, 'native-state.json'), JSON.stringify({ ...state, workspace: f.workspace,
          cli: await readFile(seeded.log, 'utf8'), engine: await f.requests() }, null, 2));
      }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state));
    } catch (error) { console.error(error); response.writeHead(500); response.end(String(error)); }
  });
  controls.listen(0, '127.0.0.1'); await once(controls, 'listening');
  return { origin: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
    controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}/__test/conversation-search`,
    async close() { for (const release of held) release(); await app.close(); unsubscribe(); await seeded?.close(); await f.close(); await new Promise<void>(done => controls.close(() => done())); } };
}
if (process.argv[1] === import.meta.filename) {
  const h = await conversationSearchHost(resolve(process.argv[2]!), resolve(process.argv[3]!));
  console.log(JSON.stringify(h));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void h.close().then(() => process.exit()); });
}
