import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
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
  try {
    await partner.bark.save({ action: 'set', key: 'synthetic-push-key' }, () => true);
    await partner.submit(crypto.randomUUID(), 'Test-owned input');
    await eventually(async () => !!(await f.nativeState()).streamingItem);
    await f.streamCommand({ action: 'advance', text: 'private first line' });
    assert.equal(calls.length, 0);
    await f.streamCommand({ action: 'complete', text: 'private first line\nprivate second line' });
    await eventually(async () => calls.length === 1);
    const sent = calls[0]!;
    assert.equal(sent.url, 'https://api.day.app/push'); assert.equal(sent.init.redirect, 'error');
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
    const data = await readFile(join(f.directory, 'vault.sqlite'));
    assert.equal(data.includes(Buffer.from('synthetic-push-key')), false);
  } finally { await f.close(); }
});

test('disabled turns and failed pushes are not replayed', async () => {
  const state = await mkdtemp(join(tmpdir(), 'cfl-bark-')); let calls = 0;
  try {
    const bark = createBark(state, async () => { calls++; return new Response(null, { status: 503 }); });
    await bark.completed('thread', 'disabled');
    await bark.save({ action: 'set', key: 'synthetic-key' }, () => true);
    await bark.completed('thread', 'disabled');
    await bark.completed('thread', 'failed'); await bark.completed('thread', 'failed');
    assert.equal(calls, 1);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('failed or empty native turns do not send notifications', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STREAM_FIXTURE = 'true';
  let calls = 0;
  const partner = await f.createPartner({ barkFetch: async () => { calls++; return new Response(null, { status: 200 }); } });
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
    assert.equal(calls, 0);
  } finally { await f.close(); }
});
