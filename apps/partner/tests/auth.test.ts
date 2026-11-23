import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { authenticator } from './synthetic-auth.ts';
import { AuthStore } from '../runtime/auth.ts';
import { createWebServer } from '../runtime/server.ts';
import type { Partner } from '../runtime/partner.ts';

const origin = 'http://localhost:3082';

/** Enroll through the same cookie-backed Better Auth flow used by the browser. */
async function enroll(base: string, auth: AuthStore) {
  await auth.initialize();
  const post = (path: string, value: unknown, cookies: string[] = []) => fetch(base + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookies.length ? { cookie: cookies.join('; ') } : {}) }, body: JSON.stringify(value) });
  const getCookie = (response: Response, name: string) => {
    const result = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
    assert.ok(result); return result.split(';')[0]!;
  };
  const pair = await post('/api/auth/pairing', { code: auth.issuePairing() });
  assert.equal(pair.status, 200); const pairCookie = getCookie(pair, 'cfl_pairing');
  const options = await fetch(base + '/api/auth/passkey/generate-register-options', { headers: { origin, cookie: pairCookie } });
  assert.equal(options.status, 200); const challenge = (await options.json() as { challenge: string }).challenge;
  const result = await post('/api/auth/passkey/verify-registration', { createSession: true, response: authenticator().register(challenge) }, [pairCookie, getCookie(options, 'better-auth.better-auth-passkey')]);
  assert.equal(result.status, 200, await result.clone().text());
  return getCookie(result, 'better-auth.session_token');
}

test('independent service credentials do not authorize human requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-passkey-'));
  const assets = join(root, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), 'login');
  const auth = new AuthStore(root, origin); await auth.initialize();
  const partner = { close: async () => {}, postEnabled: true, keetEnabled: true, authorizePost: (header: string) => header === 'Bearer post-secret', ingestPost: async () => {}, ingestKeet: async () => {} } as unknown as Partner;
  const app = createWebServer(partner, assets, { auth, keetReceiver: 'keet-secret' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + '/api/session')).status, 401);
    for (const path of ['/api/bark/settings','/api/background-settings','/api/background-settings/landscape','/api/backgrounds/landscape']) for (const method of ['GET', 'POST']) {
      const response = await fetch(base + path, {method, headers:{origin, authorization:'Bearer post-secret'}, ...(method === 'POST' ? {body:JSON.stringify({region:'beijing',apiKey:'secret'})} : {})});
      assert.equal(response.status,401);
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    assert.equal((await fetch(base + '/api/chat/media/anything')).status, 401);
    assert.equal((await fetch(base + `/api/audio/${'a'.repeat(64)}.mp3`)).status, 401);
    for (const path of ['/api/chat/socket']) {
      const ws = new WebSocket(base.replace('http', 'ws') + path, { origin });
      ws.on('error', () => {}); const [, res] = await once(ws, 'unexpected-response'); assert.equal((res as unknown as { statusCode: number }).statusCode, 403); ws.terminate();
    }
    assert.equal((await fetch(base + '/api/keet/events', { method: 'POST', headers: { authorization: 'Bearer post-secret', 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/keet/events', { method: 'POST', headers: { authorization: 'Bearer keet-secret', 'content-type': 'application/json' }, body: '{}' })).status, 422);
    assert.equal((await fetch(base + '/api/post/events', { method: 'POST', headers: { authorization: 'Bearer keet-secret', 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/post/events', { method: 'POST', headers: { authorization: 'Bearer post-secret', 'content-type': 'application/json' }, body: '{}' })).status, 202);
    assert.equal((await fetch(base + '/api/session', { headers: { authorization: 'Bearer keet-secret', 'x-forwarded-for': '127.0.0.1' } })).status, 401);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('audio HTTP ranges preserve bytes, no-store and authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-audio-http-'));
  const auth = new AuthStore(root, origin), id = 'a'.repeat(64);
  const bytes = Buffer.from('0123456789abcdef');
  let data: Buffer | undefined = bytes;
  let holdRead = false, releaseRead: (() => void) | undefined, notifyRead: (() => void) | undefined;
  const readStarted = new Promise<void>(resolve => { notifyRead = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const partner = { close: async () => {}, audio: async (requestedId: string) => {
    assert.equal(requestedId, id);
    if (holdRead) { notifyRead!(); await readGate; }
    return data;
  } } as unknown as Partner;
  const app = createWebServer(partner, root, { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, url = `${base}/api/audio/${id}.mp3`;
  try {
    assert.equal((await fetch(url, { headers: { range: 'bytes=0-1' } })).status, 401);
    const cookie = await enroll(base, auth);
    const get = (range?: string) => fetch(url, { headers: { cookie, ...(range === undefined ? {} : { range }) } });
    const full = await get();
    assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'audio/mpeg');
    assert.equal(full.headers.get('cache-control'), 'no-store'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), String(bytes.length)); assert.equal(full.headers.get('content-range'), null);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    for (const [header, start, end] of [['bytes=0-1', 0, 1], ['Bytes=0-1', 0, 1], ['bytes=5-', 5, 15], ['bytes=-4', 12, 15], ['bytes=10-100', 10, 15], ['bytes=-99', 0, 15], ['bytes=10-99999999999999999999', 10, 15], ['bytes=-99999999999999999999', 0, 15]] as const) {
      const response = await get(header);
      assert.equal(response.status, 206, header); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
      assert.equal(response.headers.get('content-length'), String(end - start + 1));
      assert.equal(response.headers.get('accept-ranges'), 'bytes'); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    for (const header of ['bytes=16-', 'bytes=3-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=9007199254740992-']) {
      const response = await get(header);
      assert.equal(response.status, 416, header); assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    data = Buffer.alloc(0);
    const empty = await get(); assert.equal(empty.status, 200); assert.equal(empty.headers.get('content-length'), '0');
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    for (const header of ['bytes=0-', 'bytes=-1']) {
      const response = await get(header); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */0');
      await response.arrayBuffer();
    }
    data = undefined; assert.equal((await get()).status, 404);
    data = bytes; holdRead = true;
    const pending = get('bytes=0-1'); await readStarted;
    assert.equal((await fetch(base + '/api/auth/sign-out', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: '{}' })).status, 200);
    releaseRead!(); assert.equal((await pending).status, 401);
  } finally { releaseRead?.(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('successful recovery closes existing authenticated chat and event connections', async () => {
  const { fixture } = await import('./fixture.ts');
  const f = await fixture();
  const partner = await f.createPartner(), auth = new AuthStore(f.directory, origin);
  const app = createWebServer(partner, join(f.directory, 'assets'), { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const sockets: WebSocket[] = [];
  try {
    const cookie = await enroll(base, auth);
    for (const path of ['/api/chat/socket']) {
      const ws = new WebSocket(base.replace('http', 'ws') + path, { origin, headers: { cookie } });
      sockets.push(ws); ws.on('error', () => {}); await once(ws, 'open');
    }
    const events = await fetch(base + '/api/events', { headers: { cookie } });
    assert.equal(events.status, 200); const reader = events.body!.getReader(); await reader.read();
    const closed = sockets.map(ws => once(ws, 'close'));
    await enroll(base, auth);
    await Promise.all(closed);
    assert.equal((await reader.read()).done, true);
    assert.equal((await fetch(base + '/api/auth/status', { headers: { cookie } }).then(r => r.json()) as { state: string }).state, 'signed_out');
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close(); await f.close();
  }
});

for (const revocation of ['logout', 'recovery'] as const) test(`${revocation} prevents delayed human requests and data reads`, async () => {
  const { request } = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'cfl-auth-race-'));
  const auth = new AuthStore(root, origin);
  const counts = { submit: 0, cancel: 0 };
  const imageId = 'a'.repeat(64);
  let releaseRead: (() => void) | undefined;
  let notifyRead: (() => void) | undefined;
  const readStarted = new Promise<void>(resolve => { notifyRead = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  let holdRead = false;
  const partner = {
    close: async () => {},
    submit: async () => { counts.submit++; }, cancel: async () => { counts.cancel++; },
    image: async () => { if (holdRead) { notifyRead!(); await readGate; } return { media_type: 'image/png', data: Buffer.from('synthetic') }; },
    conversationImage: async () => ({ media_type: 'image/png', data: Buffer.from('synthetic') }),
    audio: async () => Buffer.from('synthetic-audio'),
  } as unknown as Partner;
  const app = createWebServer(partner, root, { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const post = (path: string, value: unknown, cookie?: string) => fetch(base + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  const pending: Array<{ finish: () => void; result: Promise<number> }> = [];
  try {
    const cookie = await enroll(base, auth);
    for (const path of [`/api/images/${imageId}`, `/api/conversation-images/${imageId}`, `/api/audio/${imageId}.mp3`]) {
      const response = await fetch(base + path, { headers: { cookie } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.arrayBuffer();
    }
    const originalAuthorize = auth.authorize.bind(auth);
    let seen: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { seen = resolve; });
    let entries = 0;
    auth.authorize = req => { const result = originalAuthorize(req); if (result && req.url === '/api/cancel') { entries++; if (entries === 2) seen!(); } return result; };
    for (const [path, type, content] of [
      ['/api/cancel', 'application/json', JSON.stringify({ id: 'other-turn' })],
      ['/api/cancel', 'application/json', JSON.stringify({ id: 'turn' })],
    ]) {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { origin, cookie, 'content-type': type } });
      const result = new Promise<number>((resolve, reject) => { req.on('response', res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); });
      req.write(content[0]);
      pending.push({ finish: () => req.end(content.slice(1)), result });
    }
    await entered;
    holdRead = true;
    const delayedRead = fetch(base + `/api/images/${imageId}`, { headers: { cookie } });
    await readStarted;
    if (revocation === 'logout') assert.equal((await post('/api/auth/sign-out', {}, cookie)).status, 200);
    else await enroll(base, auth);
    for (const item of pending) item.finish();
    releaseRead!();
    assert.deepEqual(await Promise.all(pending.map(item => item.result)), [401, 401]);
    assert.equal((await delayedRead).status, 401);
    for (const path of [`/api/images/${imageId}`, `/api/conversation-images/${imageId}`, `/api/audio/${imageId}.mp3`]) {
      assert.equal((await fetch(base + path, { headers: { cookie } })).status, 401);
    }
    assert.deepEqual(counts, { submit: 0, cancel: 0 });
  } finally { releaseRead?.(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('serialized human admission rechecks authorization inside the store transaction', async () => {
  const { fixture } = await import('./fixture.ts');
  const f = await fixture();
  const partner = await f.createPartner();
  const id = crypto.randomUUID();
  let checks = 0;
  try {
    await assert.rejects(partner.submit(id, 'never admitted', [], () => ++checks < 4), /Unauthorized/);
    assert.equal(checks, 4);
    assert.equal((await partner.snapshot()).messages.some(message => message.id === id), false);
    const sharedId = crypto.randomUUID();
    await assert.rejects(partner.submitNativeDelivery({ operationId: sharedId, text: 'revoked socket' }, async () => true, () => false), /Unauthorized/);
    assert.equal((await partner.snapshot()).messages.some(message => message.id === sharedId), false);
    assert.equal((await f.requests()).some(request => request.method === 'turn/start'), false);
  } finally { await f.close(); }
});
