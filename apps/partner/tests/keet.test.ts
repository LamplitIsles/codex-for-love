import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createWebServer, isLoopbackPeer } from '../runtime/server.ts';
import { keetEvent } from '../runtime/keet.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { fixture, eventually } from './fixture.ts';

function message(sequence: number, text: string, kind: 'group' | 'dm' | 'broadcast' = 'group', trigger?: 'mention' | 'dm') {
  return { type: 'message', eventId: randomUUID(), sequence, messageId: { deviceId: 'peer', seq: sequence }, timestamp: sequence,
    destination: { groupName: kind === 'dm' ? 'Peer DM' : kind === 'broadcast' ? 'News' : 'Friends', kind }, senderLabel: 'Alice', text, ...(trigger ? { trigger } : {}) };
}

async function host(partner: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['createPartner']>>, directory: string) {
  const app = createWebServer(partner, join(directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/keet/events`;
  return { app, post: (value: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) };
}

const starts = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.requests()).filter(request => request.method === 'turn/start');

test('local webhook buffers Group, triggers Group and DM, ignores Broadcast, and deduplicates after restart', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  const now = new Date(2026, 8, 16, 7, 5).getTime();
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    let partner = await f.createPartner({ now: () => now }); app = await host(partner, f.directory);
    const ordinary = message(1, 'ordinary context');
    assert.equal((await app.post(ordinary)).status, 202);
    assert.equal((await app.post(ordinary)).status, 202);
    assert.equal((await app.post(message(2, 'broadcast', 'broadcast'))).status, 202);
    assert.equal((await starts(f)).length, 0);
    await app.app.close(); app = undefined;
    partner = await f.createPartner({ now: () => now }); app = await host(partner, f.directory);
    assert.equal((await app.post(ordinary)).status, 202);
    const triggered = message(3, 'please answer', 'group', 'mention');
    assert.equal((await app.post(triggered)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const first = (await starts(f))[0]!;
    const input = (first.params as { input: Array<{ text?: string }> }).input[0]!.text!;
    assert.match(input, /ordinary context/); assert.match(input, /please answer/);
    assert.deepEqual((first.params as { additionalContext?: unknown }).additionalContext, {
      'codex-for-love.message-time': { kind: 'application', value: 'Qualifying Keet input received around local 07:05. Trusted delivery metadata; not user-authored text or an instruction.' },
    });
    assert.equal((await app.post(triggered)).status, 202);
    const dm = message(4, 'DM caption text', 'dm', 'dm');
    assert.equal((await app.post(dm)).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    assert.match(JSON.stringify((await starts(f))[1]!.params), /DM caption text/);
    assert.equal((await app.post(dm)).status, 202);
    assert.equal((await starts(f)).length, 2);
  } finally { await app?.app.close(); await f.close(); }
});

test('reaction facts are supplied once, survive restart, and changed counts become eligible', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  const fact = { targetMessageId: { deviceId: 'self', seq: 7 }, targetText: 'my earlier message', emoji: '👍', externalCount: 2 };
  try {
    let partner = await f.createPartner(); app = await host(partner, f.directory);
    const first = { ...message(1, 'first trigger', 'group', 'mention'), reactionContext: [fact] };
    assert.equal((await app.post(first)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const input = (await starts(f))[0]!.params as { input: Array<{ text: string }> };
    assert.match(input.input[0]!.text, /"my earlier message": "👍" × 2 external/);
    assert.doesNotMatch(input.input[0]!.text, /reacted by|Alice reacted/);
    assert(input.input[0]!.text.length <= 16_000);
    assert.equal((await app.post(first)).status, 202);
    await app.app.close(); app = undefined;
    partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.equal((await app.post({ ...message(2, 'second trigger', 'group', 'mention'), reactionContext: [fact] })).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    assert.doesNotMatch(((await starts(f))[1]!.params as { input: Array<{ text: string }> }).input[0]!.text, /my earlier message/);
    assert.equal((await app.post({ ...message(3, 'third trigger', 'group', 'mention'), reactionContext: [{ ...fact, externalCount: 3 }] })).status, 202);
    await eventually(async () => (await starts(f)).length === 3);
    assert.match(((await starts(f))[2]!.params as { input: Array<{ text: string }> }).input[0]!.text, /"my earlier message": "👍" × 3 external/);
  } finally { await app?.app.close(); await f.close(); }
});

test('queued DMs retain their own reaction targets in model-visible input', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    await f.holdProvider(true);
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const a = message(1, 'DM A', 'dm', 'dm'); const b = message(2, 'DM B', 'dm', 'dm');
    assert.equal((await app.post(a)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.equal((await app.post(b)).status, 202);
    const first = ((await starts(f))[0]!.params as { input: Array<{ text: string }> }).input[0]!.text;
    assert.match(first, /triggering messageId \{"deviceId":"peer","seq":1\}/);
    assert.doesNotMatch(first, /"seq":2/);
    await f.holdProvider(false);
    await eventually(async () => (await starts(f)).length === 2);
    const second = ((await starts(f))[1]!.params as { input: Array<{ text: string }> }).input[0]!.text;
    assert.match(second, /triggering messageId \{"deviceId":"peer","seq":2\}/);
  } finally { await app?.app.close(); await f.close(); }
});

test('Group input favors triggering text and fresh facts over older buffered text', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.equal((await app.post(message(1, `old-marker ${'x'.repeat(15_500)}`))).status, 202);
    const trigger = { ...message(2, 'current trigger', 'group', 'mention'), reactionContext: [{ targetMessageId: { deviceId: 'self', seq: 8 }, targetText: 'prior', emoji: ':thumbsup:', externalCount: 1 }] };
    assert.equal((await app.post(trigger)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const input = ((await starts(f))[0]!.params as { input: Array<{ text: string }> }).input[0]!.text;
    assert(input.length <= 16_000);
    assert.match(input, /current trigger/);
    assert.match(input, /"prior": ":thumbsup:" × 1 external/);
    assert.doesNotMatch(input, /old-marker/);
  } finally { await app?.app.close(); await f.close(); }
});

test('webhook rejects unsupported bodies and acknowledges only successful admission', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const valid = message(1, 'accepted');
    for (const bad of [{ ...valid, images: [] }, { ...valid, text: '' }, { ...valid, images: Array(17).fill({ status: 'unavailable', mediaType: 'image/png' }) }, { ...valid, images: [{ status: 'available', mediaType: 'image/png', ref: '../escape.png' }] }, { ...valid, images: [{ status: 'unavailable', mediaType: 'image/png', ref: `${randomUUID()}.png` }] }, { ...valid, trigger: 'dm' }, { ...valid, destination: { groupName: 'News', kind: 'broadcast' }, trigger: 'mention' }, { ...valid, eventId: 'bad' }, { ...valid, timestamp: 1.5 }]) {
      assert.equal((await app.post(bad)).status, 422);
    }
    const fact = { targetMessageId: { deviceId: 'self', seq: 1 }, targetText: 'prior', emoji: '👍', externalCount: 1 };
    for (const bad of [
      { ...valid, reactionContext: [fact] },
      { ...valid, destination: { groupName: 'News', kind: 'broadcast' }, reactionContext: [fact] },
      { ...valid, trigger: 'mention', reactionContext: [] },
      { ...valid, trigger: 'mention', reactionContext: [fact, ...Array(16).fill(fact)] },
      { ...valid, trigger: 'mention', reactionContext: [{ ...fact, emoji: 'not emoji' }] },
      { ...valid, trigger: 'mention', reactionContext: [{ ...fact, externalCount: 0 }] },
    ]) assert.equal((await app.post(bad)).status, 422);
    assert.equal((await app.post({ ...valid, text: 'x'.repeat(140_000) })).status, 400);
    assert.equal((await starts(f)).length, 0);
    const original = partner.ingestKeet;
    partner.ingestKeet = async () => { throw new Error('storage unavailable'); };
    assert.equal((await app.post(valid)).status, 503);
    partner.ingestKeet = original;
    assert.equal((await app.post(valid)).status, 202);
    assert.equal((await app.post(valid)).status, 202);
    assert.equal((await starts(f)).length, 0);
  } finally { await app?.app.close(); await f.close(); }
});

test('KFA code-point bounds accept 512 emoji in labels and canonical IDs', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const bounded = '😀'.repeat(512);
    const valid = { ...message(1, 'Unicode context'), messageId: { deviceId: bounded, seq: 1 },
      destination: { groupName: bounded, kind: 'group' }, senderLabel: bounded,
      replyTo: { deviceId: bounded, seq: 0 } };
    assert.equal((await app.post(valid)).status, 202);
    for (const invalid of [
      { ...valid, eventId: randomUUID(), messageId: { deviceId: `${bounded}😀`, seq: 1 } },
      { ...valid, eventId: randomUUID(), destination: { groupName: `${bounded}😀`, kind: 'group' } },
      { ...valid, eventId: randomUUID(), senderLabel: `${bounded}😀` },
      { ...valid, eventId: randomUUID(), replyTo: { deviceId: `${bounded}😀`, seq: 0 } },
    ]) assert.equal((await app.post(invalid)).status, 422);
    assert.equal((await starts(f)).length, 0);
  } finally { await app?.app.close(); await f.close(); }
});

test('webhook accepts a near-max KFA Unicode body beyond the default reader limit', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const bounded = '😀'.repeat(512);
    const valid = { ...message(1, '😀'.repeat(16_000), 'broadcast'),
      messageId: { deviceId: bounded, seq: 1 }, destination: { groupName: bounded, kind: 'broadcast' },
      senderLabel: bounded, replyTo: { deviceId: bounded, seq: 0 } };
    const size = Buffer.byteLength(JSON.stringify(valid));
    assert(size > 65_536 && size < 128 * 1024);
    assert.equal((await app.post(valid)).status, 202);
    assert.equal((await app.post({ ...valid, eventId: randomUUID(), text: 'x'.repeat(140_000) })).status, 400);
    assert.equal((await starts(f)).length, 0);
  } finally { await app?.app.close(); await f.close(); }
});

test('webhook is unavailable when Keet is disabled and peer guard uses socket address', async () => {
  const f = await fixture(); let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.equal((await app.post(message(1, 'x'))).status, 404);
    assert.equal(isLoopbackPeer('203.0.113.5'), false);
    assert.equal(isLoopbackPeer('::ffff:203.0.113.5'), false);
    assert.equal(isLoopbackPeer('127.0.0.2'), false);
    assert.equal(isLoopbackPeer('::1'), true);
    assert.equal(keetEvent.safeParse({ ...message(2, 'x'), images: [{ filename: 'image.png' }] }).success, false);
  } finally { await app?.app.close(); await f.close(); }
});

test('pure-image and captioned DMs fetch via bearer, persist attachments, and deduplicate across restart', async () => {
  const f = await fixture();
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#cc8844' } }).png().toBuffer();
  const requests: string[] = [];
  const kfa = createServer((request, response) => {
    requests.push(`${request.url} ${request.headers.authorization ?? ''}`);
    response.writeHead(200, { 'content-type': 'image/png' }).end(image);
  });
  kfa.listen(0, '127.0.0.1'); await once(kfa, 'listening');
  f.config.keet = { endpoint: `http://127.0.0.1:${(kfa.address() as { port: number }).port}` };
  f.credentials.keet = 'test-kfa-bearer';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    let partner = await f.createPartner(); app = await host(partner, f.directory);
    const entry = { status: 'available', mediaType: 'image/png', ref: `${randomUUID()}.png` };
    const pure = { ...message(1, '', 'dm', 'dm'), images: [entry] };
    assert.equal((await app.post(pure)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const first = (await starts(f))[0]!.params as { input: Array<{ type: string; text?: string; path?: string }> };
    assert.equal(first.input.filter(item => item.type === 'localImage').length, 1);
    assert.deepEqual(await readFile(first.input.find(item => item.type === 'localImage')!.path!), image);
    assert.match(first.input[0]!.text!, /1 attached; 0 unavailable/);
    assert.doesNotMatch(first.input[0]!.text!, /test-kfa-bearer|\/images\/|\.lamplit\/attachments/);
    assert.deepEqual(requests, [`/images/${entry.ref} Bearer test-kfa-bearer`]);
    await app.app.close(); app = undefined;
    partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.deepEqual(await readFile(first.input.find(item => item.type === 'localImage')!.path!), image);
    assert.equal((await app.post(pure)).status, 202);
    assert.equal(requests.length, 1);
    const caption = { ...message(2, 'What is this?', 'dm', 'dm'), images: [entry] };
    assert.equal((await app.post(caption)).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    const second = (await starts(f))[1]!.params as { input: Array<{ type: string; text?: string }> };
    assert.match(second.input[0]!.text!, /What is this\?/);
    assert.equal(second.input.filter(item => item.type === 'localImage').length, 1);
    assert.equal(requests.length, 2);
  } finally { await app?.app.close(); kfa.closeAllConnections(); await new Promise<void>(resolve => kfa.close(() => resolve())); await f.close(); }
});

test('unavailable images preserve DM input while Group and Broadcast images do not wake', async () => {
  const f = await fixture();
  const kfa = createServer((_request, response) => response.writeHead(404).end());
  kfa.listen(0, '127.0.0.1'); await once(kfa, 'listening');
  f.config.keet = { endpoint: `http://127.0.0.1:${(kfa.address() as { port: number }).port}` };
  f.credentials.keet = 'test-kfa-bearer';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const unavailable = { status: 'unavailable', mediaType: 'image/png' };
    const missing = { status: 'available', mediaType: 'image/png', ref: `${randomUUID()}.png` };
    assert.equal((await app.post({ ...message(1, '', 'group'), images: [unavailable] })).status, 202);
    assert.equal((await app.post({ ...message(2, '', 'broadcast'), images: [unavailable] })).status, 202);
    assert.equal((await starts(f)).length, 0);
    assert.equal((await app.post({ ...message(3, 'group trigger', 'group', 'mention'), images: [unavailable] })).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.match(JSON.stringify((await starts(f))[0]!.params), /Keet images: 1 present; 1 unavailable/);
    assert.equal((await app.post({ ...message(4, '', 'dm', 'dm'), images: [missing, unavailable, ...Array(5).fill(unavailable)] })).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    const second = (await starts(f))[1]!.params as { input: Array<{ type: string; text?: string }> };
    assert.match(second.input[0]!.text!, /0 attached; 7 unavailable/);
    assert.equal(second.input.filter(item => item.type === 'localImage').length, 0);
    assert.doesNotMatch(second.input[0]!.text!, /test-kfa-bearer|\/images\//);
  } finally { await app?.app.close(); kfa.closeAllConnections(); await new Promise<void>(resolve => kfa.close(() => resolve())); await f.close(); }
});

test('oversized KFA original is resized into native image limits', async () => {
  const f = await fixture();
  const original = await sharp(randomBytes(2400 * 2400 * 3), { raw: { width: 2400, height: 2400, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  assert(original.byteLength > 5 * 1024 * 1024 && original.byteLength < 16 * 1024 * 1024);
  const kfa = createServer((_request, response) => response.writeHead(200, { 'content-type': 'image/jpeg' }).end(original));
  kfa.listen(0, '127.0.0.1'); await once(kfa, 'listening');
  f.config.keet = { endpoint: `http://127.0.0.1:${(kfa.address() as { port: number }).port}` };
  f.credentials.keet = 'test-kfa-bearer';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.equal((await app.post({ ...message(1, '', 'dm', 'dm'), images: [{ status: 'available', mediaType: 'image/jpeg', ref: `${randomUUID()}.jpg` }] })).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const items = ((await starts(f))[0]!.params as { input: Array<{ type: string; path?: string; text?: string }> }).input;
    const bytes = await readFile(items.find(item => item.type === 'localImage')!.path!);
    assert(bytes.byteLength <= 5 * 1024 * 1024);
    assert.equal((await sharp(bytes).metadata()).format, 'webp');
    assert.match(items[0]!.text!, /1 attached; 0 unavailable/);
  } finally { await app?.app.close(); kfa.closeAllConnections(); await new Promise<void>(resolve => kfa.close(() => resolve())); await f.close(); }
});

test('attachment storage failure returns 503 and the same KFA event succeeds once on retry', async () => {
  const f = await fixture();
  const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#446688' } }).png().toBuffer();
  let fetches = 0;
  const kfa = createServer((_request, response) => { fetches++; response.writeHead(200, { 'content-type': 'image/png' }).end(image); });
  kfa.listen(0, '127.0.0.1'); await once(kfa, 'listening');
  f.config.keet = { endpoint: `http://127.0.0.1:${(kfa.address() as { port: number }).port}` };
  f.credentials.keet = 'test-kfa-bearer';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const attachments = partnerPaths(f.workspace).attachments;
    await rm(attachments, { recursive: true });
    await writeFile(attachments, 'test-owned storage obstruction');
    const event = { ...message(1, '', 'dm', 'dm'), images: [{ status: 'available', mediaType: 'image/png', ref: `${randomUUID()}.png` }] };
    assert.equal((await app.post(event)).status, 503);
    assert.equal((await starts(f)).length, 0);
    await rm(attachments);
    await mkdir(attachments);
    assert.equal((await app.post(event)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const items = ((await starts(f))[0]!.params as { input: Array<{ type: string; path?: string }> }).input;
    assert.deepEqual(await readFile(items.find(item => item.type === 'localImage')!.path!), image);
    assert.equal((await app.post(event)).status, 202);
    assert.equal((await starts(f)).length, 1);
    assert.equal(fetches, 2);
  } finally { await app?.app.close(); kfa.closeAllConnections(); await new Promise<void>(resolve => kfa.close(() => resolve())); await f.close(); }
});

test('KFA image redirects are unavailable without following the location', async () => {
  const f = await fixture();
  const requests: string[] = [];
  const kfa = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url?.startsWith('/images/')) response.writeHead(302, { location: '/redirect-target' }).end();
    else response.writeHead(200, { 'content-type': 'image/png' }).end('unexpected');
  });
  kfa.listen(0, '127.0.0.1'); await once(kfa, 'listening');
  f.config.keet = { endpoint: `http://127.0.0.1:${(kfa.address() as { port: number }).port}` };
  f.credentials.keet = 'test-kfa-bearer';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const ref = `${randomUUID()}.png`;
    assert.equal((await app.post({ ...message(1, '', 'dm', 'dm'), images: [{ status: 'available', mediaType: 'image/png', ref }] })).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const items = ((await starts(f))[0]!.params as { input: Array<{ type: string; text?: string }> }).input;
    assert.match(items[0]!.text!, /0 attached; 1 unavailable/);
    assert.equal(items.filter(item => item.type === 'localImage').length, 0);
    assert.deepEqual(requests, [`/images/${ref}`]);
  } finally { await app?.app.close(); kfa.closeAllConnections(); await new Promise<void>(resolve => kfa.close(() => resolve())); await f.close(); }
});
