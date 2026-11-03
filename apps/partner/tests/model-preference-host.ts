/** Temporary browser integration host: synthetic owner, fake native, test-owned workspace only. */
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fixture } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import type { AuthStore } from '../runtime/auth.ts';

const assets = process.argv[2];
if (!assets) throw new Error('Usage: node apps/partner/tests/model-preference-host.ts <App static assets> [port]');
const f = await fixture();
const partner = await f.createPartner();
let origin = '';
const auth = {
  close() {},
  get origin() { return origin; },
  status: (request: import('node:http').IncomingMessage) => request.headers.cookie?.includes('model-test-owner=1') ? 'signed_in' : 'signed_out',
  authorize: (request: import('node:http').IncomingMessage) => request.headers.cookie?.split(';').some(cookie => cookie.trim() === 'model-test-owner=1') === true,
  sameOrigin: (request: import('node:http').IncomingMessage) => request.headers.origin === origin && request.headers['sec-fetch-site'] !== 'cross-site',
} as unknown as AuthStore;
const app = createWebServer(partner, resolve(assets), { auth });
app.server.listen(Number(process.argv[3] ?? 0), '127.0.0.1'); await once(app.server, 'listening');
origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
console.log(`Fake-native integration host: ${origin}\nSynthetic browser cookie: model-test-owner=1; Path=/; SameSite=Strict\nTest workspace: ${f.workspace}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); await f.close(); }
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
