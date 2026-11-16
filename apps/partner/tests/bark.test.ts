import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBark } from '../runtime/bark.ts';
import { createWebServer } from './web-server.ts';
import { createWebServer as createRealWebServer } from '../runtime/server.ts';
import type { AuthStore } from '../runtime/auth.ts';
import { fixture, eventually } from './fixture.ts';

test('Bark settings use strict owner-only snapshots and atomic action semantics', async () => {
  const f = await fixture();
  const partner = await f.createPartner();
  let authorized = true;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async () => authorized });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const request = (value: unknown) => fetch(`${origin}/api/bark/settings`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const initial = await fetch(`${origin}/api/bark/settings`); assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await initial.json(), { configured: false, enabled: false });
    assert.equal((await request({ action: 'enable' })).status, 409);
    assert.equal((await request({ action: 'set', key: 'secret', owner: 'other' })).status, 400);
    const set = await request({ action: 'set', key: 'synthetic-bark-key' });
    assert.doesNotMatch(await set.clone().text(), /synthetic-bark-key/);
    assert.deepEqual(await set.json(), { configured: true, enabled: true });
    assert.deepEqual(await (await request({ action: 'disable' })).json(), { configured: true, enabled: false });
    assert.deepEqual(await (await request({ action: 'set', key: 'replacement' })).json(), { configured: true, enabled: false });
    assert.deepEqual(await (await request({ action: 'enable' })).json(), { configured: true, enabled: true });
    await assert.rejects(partner.bark.save({ action: 'remove' }, () => false), { code: 'unauthorized' });
    assert.deepEqual(await partner.bark.snapshot(), { configured: true, enabled: true });
    assert.deepEqual(await (await request({ action: 'remove' })).json(), { configured: false, enabled: false });
    authorized = false;
    assert.equal((await fetch(`${origin}/api/bark/settings`)).status, 401);
    assert.equal((await request({ action: 'set', key: 'forbidden' })).status, 401);
  } finally { await app.close(); await f.close(); }
});

test('revocation while a Bark request body is arriving prevents its commit', async () => {
  const f = await fixture();
  const partner = await f.createPartner();
  let authorized = true, inspected = false;
  const auth = { authorize: () => { inspected = true; return authorized; }, sameOrigin: () => true, close() {} } as unknown as AuthStore;
  const app = createRealWebServer(partner, join(f.directory, 'assets'), { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as {port: number}).port;
  try {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/api/bark/settings', method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } });
    const response = once(request, 'response');
    request.write('{"action":"set",');
    await eventually(async () => inspected);
    authorized = false;
    request.end('"key":"late-secret"}');
    const [result] = await response as [import('node:http').IncomingMessage];
    assert.equal(result.statusCode, 401); result.resume();
    assert.deepEqual(await partner.bark.snapshot(), { configured: false, enabled: false });
  } finally { await app.close(); await f.close(); }
});

test('completed native turn sends one fixed privacy-safe push, including replay after unknown outcome', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  const calls: Array<{url: string; init: RequestInit}> = [];
  const partner = await f.createPartner({ barkFetch: async (url, init) => { calls.push({ url: String(url), init: init! }); throw new Error('synthetic response lost'); } });
  const logs: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await partner.bark.save({ action: 'set', key: 'synthetic-push-key' }, () => true);
    await partner.submit(crypto.randomUUID(), 'Test-owned input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'private first line' });
    assert.equal(calls.length, 0);
    await f.streamCommand({ action: 'complete', text: 'private first line\nprivate second line' });
    await eventually(async () => calls.length === 1);
    const sent = calls[0]!;
    assert.equal(sent.url, 'https://api.day.app/push'); assert.equal(sent.init.redirect, 'manual');
    assert.ok(sent.init.signal); assert.deepEqual(JSON.parse(String(sent.init.body)), { device_key: 'synthetic-push-key', body: 'Your companion replied.', url: 'etosllmstudio://open/chat' });
    const native = await f.nativeState();
    const turn = native.turns.find((entry: { status: string }) => entry.status === 'completed'); assert.ok(turn);
    await f.streamCommand({ action: 'event', notification: { method: 'turn/completed', params: { threadId: native.threadId, turn } } });
    await eventually(async () => !(await partner.snapshot()).typing);
    await partner.bark.completed(native.threadId, turn.id);
    assert.equal(calls.length, 1);
    // A historical completion from before notification tracking must not be
    // treated as live merely because it has no attempt record.
    const db = new DatabaseSync(join(f.directory, 'vault.sqlite'));
    try { db.prepare('DELETE FROM notification_attempts WHERE thread_id=? AND turn_id=?').run(native.threadId, turn.id); }
    finally { db.close(); }
    await f.streamCommand({ action: 'event', notification: { method: 'turn/completed', params: { threadId: native.threadId, turn } } });
    await partner.submit(crypto.randomUUID(), 'new input');
    await eventually(async () => !!(await f.nativeState()).active);
    await f.streamCommand({ action: 'complete', text: 'new answer' });
    await eventually(async () => calls.length >= 2);
    await partner.close();
    assert.equal(calls.length, 2);
    const entries = logs.filter(line => line.includes('bark.notification')).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    const sentAttempt = entries.find(entry => entry.stage === 'send' && entry.reason === 'network_failure')?.attemptId;
    for (const stage of ['eligibility', 'inspection', 'claim', 'send']) assert.ok(entries.some(entry => entry.attemptId === sentAttempt && entry.stage === stage), stage);
    assert.doesNotMatch(logs.filter(line => line.includes('bark.notification')).join('\n'), /synthetic-push-key|synthetic response lost|private first line|Test-owned input/);
    const data = await readFile(join(f.directory, 'vault.sqlite'));
    assert.equal(data.includes(Buffer.from('synthetic-push-key')), false);
  } finally { console.error = original; await f.close(); }
});

test('disabled turns and failed pushes are not replayed', async () => {
  const state = await mkdtemp(join(tmpdir(), 'cfl-bark-')); let calls = 0;
  try {
    const bark = createBark(state, async () => { calls++; return new Response(null, { status: 503 }); });
    await bark.completed('thread', 'disabled');
    await bark.save({ action: 'set', key: 'synthetic-key' }, () => true);
    await bark.completed('thread', 'disabled');
    await bark.save({ action: 'disable' }, () => true);
    await bark.completed('thread', 'configured-disabled');
    await bark.save({ action: 'enable' }, () => true);
    await bark.completed('thread', 'configured-disabled');
    await bark.completed('thread', 'failed'); await bark.completed('thread', 'failed');
    assert.equal(calls, 1);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('failed or empty native turns do not send notifications', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  let calls = 0;
  const partner = await f.createPartner({ barkFetch: async () => { calls++; return new Response(null, { status: 200 }); } });
  const logs: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await partner.bark.save({ action: 'set', key: 'synthetic-key' }, () => true);
    await partner.submit(crypto.randomUUID(), 'first input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'not a completed reply' });
    await f.streamCommand({ action: 'fail' });
    await eventually(async () => !(await partner.snapshot()).typing);
    assert.equal(calls, 0);
    await partner.submit(crypto.randomUUID(), 'second input');
    await eventually(async () => !!(await f.nativeState()).active);
    await f.streamCommand({ action: 'complete', text: '' });
    await eventually(async () => !(await partner.snapshot()).typing);
    await eventually(async () => logs.some(line => line.includes('"reason":"no_reply"')));
    assert.equal(calls, 0);
    assert.ok(logs.some(line => line.includes('"reason":"not_completed"')));
  } finally { console.error = original; await f.close(); }
});

test('test API enforces authentication, origin, validation and independent single attempts', async () => {
  const f = await fixture();
  let calls = 0, mode: 'accepted' | 'rejected' | 'disconnect' | 'timeout' = 'accepted';
  const partner = await f.createPartner({ barkFetch: async (_url, init) => {
    calls++;
    if (calls !== 2) assert.match(String(init?.body), /test notification/);
    if (mode === 'rejected') return new Response('secret-response-marker', { status: 503 });
    if (mode === 'disconnect') throw new Error('secret-exception-marker');
    if (mode === 'timeout') return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('secret-timeout-marker')), { once: true }));
    return new Response(null, { status: 202 });
  } });
  let authorized = true;
  const auth = { authorize: () => authorized, sameOrigin: (request: import('node:http').IncomingMessage) => request.headers.origin === `http://${request.headers.host}`, close() {} } as unknown as AuthStore;
  const app = createRealWebServer(partner, join(f.directory, 'assets'), { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (value: unknown = {}, requestOrigin = origin) => fetch(`${origin}/api/bark/test`, { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const check = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status); const text = await response.text();
    assert.doesNotMatch(text, /secret-|synthetic-push-key/); assert.equal(JSON.parse(text).error.code, code);
  };
  const logs: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    authorized = false; await check(await request(), 401, 'unauthorized'); authorized = true;
    await check(await request({}, 'https://evil.invalid'), 403, 'forbidden_origin');
    await check(await request({ extra: true }), 400, 'invalid_request');
    await check(await request(), 409, 'bark_not_configured');
    await partner.bark.save({ action: 'set', key: 'synthetic-push-key' }, () => true);
    await partner.bark.save({ action: 'disable' }, () => true);
    await check(await request(), 409, 'bark_disabled');
    assert.equal(calls, 0);
    await partner.bark.save({ action: 'enable' }, () => true);
    const response = await request(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'accepted' });
    await partner.bark.completed('thread-marker', 'turn-marker');
    await partner.bark.completed('thread-marker', 'turn-marker');
    assert.equal(calls, 2); // one test and one normal, despite duplicate normal completion
    mode = 'rejected'; await check(await request(), 502, 'bark_upstream_rejected');
    mode = 'disconnect'; await check(await request(), 504, 'outcome_unknown');
    mode = 'timeout'; await check(await request(), 504, 'outcome_unknown');
    assert.equal(calls, 5);
    assert.doesNotMatch(logs.join('\n'), /secret-|synthetic-push-key|thread-marker|turn-marker|api\.day\.app|test notification/);
    const entries = logs.filter(line => line.includes('bark.notification')).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    for (const reason of ['not_configured', 'disabled', 'accepted', 'upstream_rejected', 'network_failure', 'timeout', 'duplicate']) assert.ok(entries.some(entry => entry.reason === reason), reason);
    const claim = entries.find(entry => entry.kind === 'normal' && entry.reason === 'claimed');
    const normal = entries.filter(entry => entry.kind === 'normal' && entry.attemptId === claim?.attemptId);
    assert.ok(normal.some(entry => entry.reason === 'claimed'));
    assert.ok(normal.some(entry => entry.reason === 'accepted'));
    assert.ok(entries.some(entry => entry.kind === 'normal' && entry.reason === 'duplicate' && entry.attemptId !== claim.attemptId));
    assert.ok(entries.every(entry => entry.time && Number.isFinite(entry.elapsedMs)));
  } finally { console.error = original; await app.close(); await f.close(); }
});

test('completed turn inspection failure is logged without leaking the error or sending', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  let calls = 0;
  const partner = await f.createPartner({ barkFetch: async () => { calls++; return new Response(); } });
  const logs: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await partner.bark.save({ action: 'set', key: 'inspection-secret-key' }, () => true);
    await partner.submit(crypto.randomUUID(), 'private-inspection-input');
    await eventually(async () => !!(await f.nativeState()).active);
    await f.streamCommand({ action: 'complete', text: 'private-inspection-reply', historyItemsError: true });
    await eventually(async () => logs.some(line => line.includes('"stage":"inspection"') && line.includes('"reason":"failed"')));
    const entries = logs.filter(line => line.includes('bark.notification')).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    const failed = entries.find(entry => entry.stage === 'inspection' && entry.reason === 'failed');
    assert.ok(entries.some(entry => entry.attemptId === failed.attemptId && entry.stage === 'eligibility' && entry.reason === 'eligible'));
    assert.ok(entries.some(entry => entry.attemptId === failed.attemptId && entry.stage === 'inspection' && entry.reason === 'started'));
    assert.doesNotMatch(logs.filter(line => line.includes('bark.notification')).join('\n'), /inspection-secret-key|private-inspection|fixture history read failure/);
    assert.equal(calls, 0);
  } finally { console.error = original; await f.close(); }
});

test('test API rechecks authorization after receiving the request body', async () => {
  const f = await fixture(); let calls = 0;
  const partner = await f.createPartner({ barkFetch: async () => { calls++; return new Response(); } });
  await partner.bark.save({ action: 'set', key: 'synthetic-key' }, () => true);
  let authorized = true, inspected = false;
  const auth = { authorize: () => { inspected = true; return authorized; }, sameOrigin: () => true, close() {} } as unknown as AuthStore;
  const app = createRealWebServer(partner, join(f.directory, 'assets'), { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  try {
    const request = httpRequest({ host: '127.0.0.1', port: (app.server.address() as {port: number}).port, path: '/api/bark/test', method: 'POST', headers: { 'content-type': 'application/json' } });
    const response = once(request, 'response'); request.write('{');
    await eventually(async () => inspected); authorized = false; request.end('}');
    const [result] = await response as [import('node:http').IncomingMessage];
    assert.equal(result.statusCode, 401); result.resume(); assert.equal(calls, 0);
  } finally { await app.close(); await f.close(); }
});

test('Bark redirects are reported as upstream rejection without following the location', async () => {
  const f = await fixture();
  let received = 0, followed = 0;
  const upstream = createServer((request, response) => {
    if (request.url === '/push') {
      received++;
      response.writeHead(302, { location: '/redirected-secret-marker' });
      response.end('upstream-secret-marker');
    } else { followed++; response.writeHead(200); response.end(); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/push`;
  const partner = await f.createPartner({ barkFetch: (_url, init) => fetch(upstreamUrl, init) });
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const logs: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await partner.bark.save({ action: 'set', key: 'redirect-key-marker' }, () => true);
    const response = await fetch(`${origin}/api/bark/test`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(body).error.code, 'bark_upstream_rejected');
    assert.equal(received, 1); assert.equal(followed, 0);
    const entries = logs.filter(line => line.includes('bark.notification')).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    assert.ok(entries.some(entry => entry.stage === 'send' && entry.reason === 'upstream_rejected' && entry.httpStatus === 302));
    assert.doesNotMatch(`${body}\n${logs.join('\n')}`, /redirect-key-marker|redirected-secret-marker|upstream-secret-marker/);
  } finally {
    console.error = original;
    await app.close(); await f.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('completed event without a thread ID is rejected before notification processing', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  let calls = 0;
  const partner = await f.createPartner({ barkFetch: async () => { calls++; return new Response(); } });
  const logs: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await partner.bark.save({ action: 'set', key: 'synthetic-key' }, () => true);
    await partner.submit(crypto.randomUUID(), 'synthetic input');
    await eventually(async () => !!(await f.nativeState()).active);
    const native = await f.nativeState();
    const turn = native.turns.find((entry: { id: string }) => entry.id === native.active);
    assert.ok(turn);
    await f.streamCommand({ action: 'event', notification: { method: 'turn/completed', params: { turn: { ...turn, status: 'completed' } } } });
    await eventually(async () => logs.some(line => line.includes('app_server.sdk_error') && line.includes('validation failed')));
    assert.equal(logs.some(line => line.includes('bark.notification')), false);
    assert.equal(calls, 0);
  } finally { console.error = original; await f.close(); }
});
