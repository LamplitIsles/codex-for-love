import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import type { Partner } from '../runtime/partner.ts';

/** Test-only facade: every observation travels through the fake official SDK process. */
export async function quietCompactionFixture(chatAssets: string, nativeAssets: string, port = 0) {
  let f = await fixture();
  let partner: Partner;
  let control: Record<string, unknown> = { holdCompact: true };
  const retired: Array<typeof f> = [];
  const listeners = new Set<() => void>();
  const subscriptions = new Set<() => void>();
  async function writeControl() {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path + '.next', JSON.stringify(control)); await rename(path + '.next', path);
  }
  async function start(sessionId: string) {
    f.appServer.env.FAKE_QUIET_COMPACT = 'true';
    await mkdir(partnerPaths(f.workspace).managedRoot, { recursive: true });
    await writeFile(join(partnerPaths(f.workspace).managedRoot, 'thread.json'), JSON.stringify({ threadId: sessionId, model: f.config.codex.model }));
    await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify({ threadId: sessionId, next: 1, turns: [] }));
    await writeControl(); partner = await f.createPartner();
    subscriptions.add(partner.subscribe(() => { for (const listener of listeners) listener(); }));
    for (const listener of listeners) listener();
  }
  await start('fixture-session');
  const facade = new Proxy({} as Partner, { get(_target, key) {
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const value = partner[key as keyof Partner]; return typeof value === 'function' ? value.bind(partner) : value;
  } });
  const app = createWebServer(facade, nativeAssets, { chatAssets, authorize: async request => request.headers.cookie?.includes('quiet-test-owner=1') === true });
  app.server.prependListener('request', (request, response) => {
    if (!request.url?.startsWith('/api')) response.setHeader('Set-Cookie', 'quiet-test-owner=1; Path=/; SameSite=Strict');
  });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  async function command(action: string, fields: Record<string, unknown> = {}) {
    const id = crypto.randomUUID(); control.command = { id, action, ...fields }; await writeControl();
    await eventually(async () => { try { return await readFile(join(f.directory, 'command-done'), 'utf8') === id; } catch { return false; } });
    await partner.snapshot();
  }
  async function state() {
    const view = await createCodexChatBackend(partner).read();
    const requests = await f.requests();
    if (process.env.COMPACT_FIXTURE_EVIDENCE) {
      await mkdir(process.env.COMPACT_FIXTURE_EVIDENCE, { recursive: true });
      await writeFile(join(process.env.COMPACT_FIXTURE_EVIDENCE, `native-${f.directory.split('/').at(-1)}.json`), JSON.stringify({ workspace: f.workspace, requests, view }, null, 2));
    }
    return { sessionId: view.sessionId, contextUsage: view.contextUsage, compaction: view.compaction,
      calls: requests.filter(r => r.method === 'thread/compact/start').length,
      executions: requests.filter(r => r.fixtureCompactExecution).length,
      submissions: requests.filter(r => r.method === 'turn/start' || r.method === 'turn/steer') };
  }
  async function action(input: { action: string; sessionId?: string; enabled?: boolean; failed?: boolean; tokens?: number | null; capacity?: number | null; threadId?: string }) {
    switch (input.action) {
      case 'reset':
        control.holdCompactReply = false; control.holdCompact = false; await writeControl();
        await f.close(); for (const old of retired.splice(0)) await old.close();
        f = await fixture(); control = { holdCompact: true }; await start('fixture-session'); break;
      case 'session':
        retired.push(f); f = await fixture(); control = { holdCompact: true }; await start(input.sessionId!); break;
      case 'usage': await command('usage', { tokens: input.tokens, capacity: input.capacity, threadId: input.threadId }); break;
      case 'busy': await command('busy', { enabled: input.enabled }); break;
      case 'refuse': control.refuseCompact = input.enabled; await writeControl(); break;
      case 'hold': control.holdCompactReply = input.enabled; await writeControl(); break;
      case 'release':
        control.holdCompactReply = false; await writeControl();
        for (const old of retired) {
          const path = old.appServer.env.FAKE_SERVER_CONTROL!;
          const data = JSON.parse(await readFile(path, 'utf8')); data.holdCompactReply = false; data.holdCompact = false;
          await writeFile(path + '.next', JSON.stringify(data)); await rename(path + '.next', path);
        }
        break;
      case 'auto': control.holdCompact = true; control.compactFailed = false; await writeControl(); await command('auto');
        await eventually(async () => (await partner.snapshot()).lifecycle.latest?.status === 'running'); break;
      case 'finish': control.compactFailed = input.failed; control.holdCompact = false; await writeControl();
        await eventually(async () => (await partner.snapshot()).lifecycle.latest?.status === (input.failed ? 'failed' : 'complete'));
        control.holdCompact = true; await writeControl(); break;
      case 'state': break;
      default: throw new Error('Unknown test action');
    }
    return state();
  }
  const controls = createServer(async (request, response) => {
    try {
      if (request.url?.endsWith('/disconnect')) {
        // Test-owned browser connections only; native execution keeps running.
        app.server.emit('quiet-test-disconnect');
        response.end(JSON.stringify({ disconnected: true })); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await action(JSON.parse(Buffer.concat(chunks).toString()))));
    } catch (error) { console.error(error); response.writeHead(500); response.end(String(error)); }
  });
  const connected = new Set<import('node:stream').Duplex>();
  app.server.on('upgrade', (_request, socket) => { connected.add(socket); socket.on('close', () => connected.delete(socket)); });
  app.server.on('quiet-test-disconnect', () => { for (const socket of connected) socket.destroy(); });
  controls.listen(0, '127.0.0.1'); await once(controls, 'listening');
  return { get f() { return f; }, get partner() { return partner; }, action,
    origin: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
    controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}/__test/quiet-compaction`,
    async close() { control.holdCompactReply = false; control.holdCompact = false; await writeControl(); await app.close(); for (const off of subscriptions) off(); await f.close(); for (const old of retired) await old.close(); await new Promise<void>(done => controls.close(() => done())); } };
}
if (process.argv[1] === import.meta.filename) {
  const host = await quietCompactionFixture(resolve(process.argv[2]!), resolve(process.argv[3]!));
  console.log(JSON.stringify({ origin: host.origin, controlUrl: host.controlUrl, workspace: host.f.workspace }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().then(() => process.exit()); });
}
