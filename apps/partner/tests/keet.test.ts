import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createWebServer, isLoopbackPeer } from '../runtime/server.ts';
import { classifyKeetTrigger, keetEvent } from '../runtime/keet.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { Store } from '../runtime/store.ts';
import { fixture, eventually } from './fixture.ts';

function message(sequence: number, text: string, kind: 'group' | 'dm' | 'broadcast' = 'group', mentionsIdentity = false) {
  return { type: 'message', eventId: randomUUID(), sequence, messageId: { deviceId: 'peer', seq: sequence }, timestamp: sequence,
    destination: { groupName: kind === 'dm' ? 'Peer DM' : kind === 'broadcast' ? 'News' : 'Friends', kind }, senderLabel: 'Alice', text, addressing: { mentionsIdentity } };
}

async function host(partner: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['createPartner']>>, directory: string) {
  const app = createWebServer(partner, join(directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { app, base, post: (value: unknown) => fetch(`${base}/api/keet/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) };
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
    const triggered = message(3, 'please answer', 'group', true);
    assert.equal((await app.post(triggered)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const first = (await starts(f))[0]!;
    const input = (first.params as { input: Array<{ text?: string }> }).input[0]!.text!;
    assert.equal(input, 'please answer');
    const context = (first.params as { additionalContext: Record<string, { kind: string; value: string }> }).additionalContext;
    assert.match(context['codex-for-love.keet-group-context']!.value, /ordinary context/);
    assert.equal(context['codex-for-love.keet-group-context']!.kind, 'untrusted');
    assert.equal(context['codex-for-love.keet-kind']!.kind, 'application');
    assert.equal(context['codex-for-love.keet-destination']!.value, 'Friends');
    assert.equal(context['codex-for-love.keet-sender-label']!.value, 'Alice');
    assert.match(context['codex-for-love.keet-message-id']!.value, /"seq":3/);
    assert.equal(context['codex-for-love.keet-local-time']!.value, '07:05');
    const snapshot = await partner.snapshot();
    const keet = snapshot.messages.find(row => row.id === `keet:webhook:${triggered.eventId}`)?.keet;
    assert.deepEqual(keet && { kind: keet.kind, destination: keet.destination, senderLabel: keet.senderLabel, text: keet.text }, { kind: 'group', destination: 'Friends', senderLabel: 'Alice', text: 'please answer' });
    assert.equal((await app.post(triggered)).status, 202);
    const dm = message(4, 'DM caption text', 'dm');
    assert.equal((await app.post(dm)).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    assert.match(JSON.stringify((await starts(f))[1]!.params), /DM caption text/);
    assert.equal((await app.post(dm)).status, 202);
    assert.equal((await starts(f)).length, 2);
  } finally { await app?.app.close(); await f.close(); }
});

test('factual Group addressing admits one turn with local precedence and preserves ordinary facts', async () => {
  const f = await fixture();
  f.config.keet = { endpoint: 'http://127.0.0.1:8765', trigger_aliases: ['shio'] }; f.credentials.keet = 'test-only';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  const fact = { targetMessageId: { deviceId: 'self', seq: 7 }, targetText: 'earlier reply', emoji: '👍', externalCount: 1 };
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const replyTo = { deviceId: 'self', seq: 7 };
    for (const addressing of [{ mentionsIdentity: false }, { mentionsIdentity: false, replyToIdentity: false }, { mentionsIdentity: false, identityLabel: 'LUNA' }]) {
      assert.equal((await app.post({ ...message(1, 'unknown or non-own reply'), eventId: randomUUID(), replyTo, addressing, reactionContext: [fact] })).status, 202);
    }
    assert.equal((await starts(f)).length, 0);
    const cases = [
      { text: 'shio Luna', addressing: { mentionsIdentity: true, identityLabel: 'Luna', replyToIdentity: true }, reason: 'mention' },
      { text: 'hello Luna', addressing: { mentionsIdentity: false, identityLabel: 'Luna', replyToIdentity: true }, reason: 'label' },
      { text: 'shio', addressing: { mentionsIdentity: false, replyToIdentity: true }, reason: 'reply' },
      { text: 'hello shio', addressing: { mentionsIdentity: false }, reason: 'label' },
    ];
    for (const [index, entry] of cases.entries()) {
      const event = { ...message(index + 2, entry.text), replyTo, addressing: entry.addressing, reactionContext: [fact] };
      assert.equal(classifyKeetTrigger(keetEvent.parse(event), ['shio']), entry.reason);
      assert.equal((await app.post(event)).status, 202);
      await eventually(async () => (await starts(f)).length === index + 1);
      assert.equal((await app.post(event)).status, 202);
      const turn = (await starts(f))[index]!.params as { input: Array<{ text: string }>; additionalContext: Record<string, { value: string }> };
      assert.equal(turn.input[0]!.text, entry.text);
      if (index === 0) {
        assert.match(turn.additionalContext['codex-for-love.keet-group-context']!.value, /unknown or non-own reply/);
        assert.match(turn.additionalContext['codex-for-love.keet-reactions']!.value, /earlier reply/);
      } else assert.equal(turn.additionalContext['codex-for-love.keet-reactions'], undefined);
    }
    assert.equal((await starts(f)).length, cases.length);
    const broadcast = { ...message(9, 'Luna shio', 'broadcast'), replyTo, addressing: cases[0]!.addressing };
    assert.equal(classifyKeetTrigger(keetEvent.parse(broadcast), ['shio']), undefined);
    assert.equal((await app.post(broadcast)).status, 202);
    assert.equal((await starts(f)).length, cases.length);
    const blank = { ...message(10, '   '), images: [{ status: 'unavailable', mediaType: 'image/png' }], addressing: { mentionsIdentity: false, identityLabel: 'Luna' } };
    assert.equal(classifyKeetTrigger(keetEvent.parse(blank), ['shio']), undefined);
    assert.equal((await app.post(blank)).status, 202);
    assert.equal((await starts(f)).length, cases.length);
  } finally { await app?.app.close(); await f.close(); }
});

test('webhook rejects missing, malformed, private and obsolete addressing fields', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'test-only';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const valid = message(1, 'hello');
    const { addressing: _addressing, ...missing } = valid;
    for (const event of [missing, ...[
      null, {}, { mentionsIdentity: 'true' }, { mentionsIdentity: false, replyToIdentity: 'false' },
      { mentionsIdentity: false, replyToIdentity: true }, { mentionsIdentity: false, identityLabel: '' },
      { mentionsIdentity: false, identityLabel: ' Luna' }, { mentionsIdentity: false, identityLabel: 'Luna\nname' },
      { mentionsIdentity: false, identityLabel: '😀'.repeat(513) }, { mentionsIdentity: false, memberId: 'private' },
    ].map(addressing => ({ ...valid, addressing })),
      { ...valid, trigger: 'mention' }, { ...message(2, 'DM', 'dm'), trigger: 'dm' },
    ]) assert.equal((await app.post(event)).status, 422);
    assert.equal((await app.post({ ...valid, addressing: { mentionsIdentity: false, identityLabel: '😀'.repeat(512) } })).status, 202);
    assert.equal((await starts(f)).length, 0);
  } finally { await app?.app.close(); await f.close(); }
});

test('an older Companion page retains Keet source attribution after Partner restart', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const trigger = message(1, 'original Keet text', 'group', true);
    assert.equal((await app.post(trigger)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    await app.app.close(); app = undefined;
    await partner.close();
    const store = new Store(partnerPaths(f.workspace).database);
    try {
      // Later test-owned records make the real Keet trigger fall off the newest page.
      for (let index = 0; index < 51; index++) await store.ensureMessage(randomUUID(), Date.now());
    } finally { await store.close(); }
    const resumed = await f.createPartner(); app = await host(resumed, f.directory);
    const newest = await (await fetch(`${app.base}/api/session`)).json() as { hasMore: boolean; before: number; messages: Array<{ id: string }> };
    assert.equal(newest.hasMore, true);
    assert(!newest.messages.some(row => row.id === `keet:webhook:${trigger.eventId}`));
    const older = await (await fetch(`${app.base}/api/session?before=${newest.before}`)).json() as { messages: Array<{ id: string; input: string; keet?: { text: string; kind: string; senderLabel: string; destination: string } }> };
    const source = older.messages.find(row => row.id === `keet:webhook:${trigger.eventId}`);
    assert(source);
    assert.equal(source.input, trigger.text);
    assert.deepEqual(source.keet && { text: source.keet.text, kind: source.keet.kind, senderLabel: source.keet.senderLabel, destination: source.keet.destination },
      { text: 'original Keet text', kind: 'group', senderLabel: 'Alice', destination: 'Friends' });
  } finally { await app?.app.close(); await f.close(); }
});

test('reaction facts are supplied once, survive restart, and changed counts become eligible', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  const fact = { targetMessageId: { deviceId: 'self', seq: 7 }, targetText: 'my earlier message', emoji: '👍', externalCount: 2 };
  try {
    let partner = await f.createPartner(); app = await host(partner, f.directory);
    const first = { ...message(1, 'first trigger', 'group', true), reactionContext: [fact] };
    assert.equal((await app.post(first)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const input = (await starts(f))[0]!.params as { input: Array<{ text: string }> };
    assert.equal(input.input[0]!.text, 'first trigger');
    assert.match(JSON.stringify((input as unknown as { additionalContext: unknown }).additionalContext), /my earlier message.*👍.*2 external/);
    assert.doesNotMatch(input.input[0]!.text, /reacted by|Alice reacted/);
    assert(input.input[0]!.text.length <= 16_000);
    assert.equal((await app.post(first)).status, 202);
    await app.app.close(); app = undefined;
    partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.equal((await app.post({ ...message(2, 'second trigger', 'group', true), reactionContext: [fact] })).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    assert.doesNotMatch(JSON.stringify(((await starts(f))[1]!.params as { additionalContext: unknown }).additionalContext), /my earlier message/);
    assert.equal((await app.post({ ...message(3, 'third trigger', 'group', true), reactionContext: [{ ...fact, externalCount: 3 }] })).status, 202);
    await eventually(async () => (await starts(f)).length === 3);
    assert.match(JSON.stringify(((await starts(f))[2]!.params as { additionalContext: unknown }).additionalContext), /my earlier message.*👍.*3 external/);
  } finally { await app?.app.close(); await f.close(); }
});

test('queued DMs retain their own reaction targets in model-visible input', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    await f.holdProvider(true);
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const a = message(1, 'DM A', 'dm'); const b = message(2, 'DM B', 'dm');
    assert.equal((await app.post(a)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.equal((await app.post(b)).status, 202);
    const first = (await starts(f))[0]!.params as { input: Array<{ text: string }>; additionalContext: unknown };
    assert.equal(first.input[0]!.text, 'DM A');
    assert.match(JSON.stringify(first.additionalContext), /seq\\":1/);
    assert.doesNotMatch(JSON.stringify(first.additionalContext), /seq\\":2/);
    await f.holdProvider(false);
    await eventually(async () => (await starts(f)).length === 2);
    const second = (await starts(f))[1]!.params as { input: Array<{ text: string }>; additionalContext: unknown };
    assert.equal(second.input[0]!.text, 'DM B');
    assert.match(JSON.stringify(second.additionalContext), /seq\\":2/);
  } finally { await app?.app.close(); await f.close(); }
});

test('Group input favors triggering text and fresh facts over older buffered text', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.equal((await app.post(message(1, `old-marker ${'x'.repeat(15_500)}`))).status, 202);
    const trigger = { ...message(2, 'current trigger', 'group', true), reactionContext: [{ targetMessageId: { deviceId: 'self', seq: 8 }, targetText: 'prior', emoji: ':thumbsup:', externalCount: 1 }] };
    assert.equal((await app.post(trigger)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const input = ((await starts(f))[0]!.params as { input: Array<{ text: string }> }).input[0]!.text;
    assert(input.length <= 16_000);
    assert.match(input, /current trigger/);
    const context = ((await starts(f))[0]!.params as { additionalContext: Record<string, { value: string }> }).additionalContext;
    assert.match(context['codex-for-love.keet-reactions']!.value, /"prior": ":thumbsup:" × 1 external/);
    assert(Buffer.byteLength(context['codex-for-love.keet-group-context']!.value) <= 800);
  } finally { await app?.app.close(); await f.close(); }
});

test('trusted Groups are a standing conversation rule and aliases promote only admitted Group text', async () => {
  const f = await fixture(); f.config.keet = { endpoint: 'http://127.0.0.1:8765', trusted_groups: ['Friends'], trigger_aliases: ['shio', '汐'] }; f.credentials.keet = 'mcp-only-credential';
  let app: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); app = await host(partner, f.directory);
    const threadStart = (await f.requests()).find(request => request.method === 'thread/start')!;
    const instructions = JSON.stringify((threadStart.params as { baseInstructions: string }).baseInstructions);
    assert.match(instructions, /Keet DMs are ordinary one-to-one conversations/);
    assert.match(instructions, /Friends/);
    assert.match(instructions, /never inherit the web Human/);
    assert.equal((await app.post(message(1, 'quiet line'))).status, 202);
    assert.equal((await app.post(message(2, 'SHIO'))).status, 202);
    assert.equal((await starts(f)).length, 0);
    const alias = message(3, 'hello shio');
    assert.equal((await app.post(alias)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const first = (await starts(f))[0]!.params as { input: Array<{ text: string }>; additionalContext: Record<string, { kind: string; value: string }> };
    assert.equal(first.input[0]!.text, 'hello shio');
    assert.match(first.additionalContext['codex-for-love.keet-group-context']!.value, /quiet line.*SHIO/s);
    assert.equal(first.additionalContext['codex-for-love.keet-group-context']!.kind, 'untrusted');
    assert.equal(first.additionalContext['codex-for-love.keet-reactions'], undefined);
    assert.doesNotMatch(JSON.stringify(first), /send_message requires|Untrusted Keet Group quotation/);
    assert.equal((await app.post(alias)).status, 202);
    await app.app.close(); app = undefined;
    const resumed = await f.createPartner(); app = await host(resumed, f.directory);
    assert.equal((await app.post(alias)).status, 202);
    assert.equal((await starts(f)).length, 1);
    assert.equal((await app.post(message(4, '汐 is here'))).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    assert.equal(((await starts(f))[1]!.params as { input: Array<{ text: string }> }).input[0]!.text, '汐 is here');
    const snapshot = await resumed.snapshot();
    assert.equal(snapshot.messages.filter(row => row.keet).length, 2);
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
      { ...valid, destination: { groupName: 'News', kind: 'broadcast' }, reactionContext: [fact] },
      { ...valid, reactionContext: [] },
      { ...valid, reactionContext: [fact, ...Array(16).fill(fact)] },
      { ...valid, reactionContext: [{ ...fact, emoji: 'not emoji' }] },
      { ...valid, reactionContext: [{ ...fact, externalCount: 0 }] },
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
    const pure = { ...message(1, '', 'dm'), images: [entry] };
    assert.equal((await app.post(pure)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const first = (await starts(f))[0]!.params as { input: Array<{ type: string; text?: string; path?: string }> };
    assert.equal(first.input.filter(item => item.type === 'localImage').length, 1);
    assert.deepEqual(await readFile(first.input.find(item => item.type === 'localImage')!.path!), image);
    assert.match(first.input[0]!.text!, /1 attached; 0 unavailable/);
    assert.doesNotMatch(first.input[0]!.text!, /test-kfa-bearer|\/images\/|\.lamplit\/attachments/);
    assert.deepEqual(requests, [`/images/${entry.ref} Bearer test-kfa-bearer`]);
    const firstImage = (await partner.snapshot()).messages.find(row => row.id === `keet:webhook:${pure.eventId}`)?.inputImages[0];
    assert(firstImage);
    const firstResponse = await fetch(`${app.base}${firstImage.url}`);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await firstResponse.arrayBuffer()), image);
    await app.app.close(); app = undefined;
    partner = await f.createPartner(); app = await host(partner, f.directory);
    assert.deepEqual(await readFile(first.input.find(item => item.type === 'localImage')!.path!), image);
    const restoredImage = (await partner.snapshot()).messages.find(row => row.id === `keet:webhook:${pure.eventId}`)?.inputImages[0];
    assert(restoredImage);
    assert.equal(restoredImage.url, firstImage.url);
    const restoredResponse = await fetch(`${app.base}${restoredImage.url}`);
    assert.equal(restoredResponse.status, 200);
    assert.deepEqual(Buffer.from(await restoredResponse.arrayBuffer()), image);
    assert.equal((await app.post(pure)).status, 202);
    assert.equal(requests.length, 1);
    const caption = { ...message(2, 'What is this?', 'dm'), images: [entry] };
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
    assert.equal((await app.post({ ...message(3, 'group trigger', 'group', true), images: [unavailable] })).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.match(JSON.stringify((await starts(f))[0]!.params), /Keet images: 1 present; 1 unavailable/);
    assert.equal((await app.post({ ...message(4, '', 'dm'), images: [missing, unavailable, ...Array(5).fill(unavailable)] })).status, 202);
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
    assert.equal((await app.post({ ...message(1, '', 'dm'), images: [{ status: 'available', mediaType: 'image/jpeg', ref: `${randomUUID()}.jpg` }] })).status, 202);
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
    const event = { ...message(1, '', 'dm'), images: [{ status: 'available', mediaType: 'image/png', ref: `${randomUUID()}.png` }] };
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
    assert.equal((await app.post({ ...message(1, '', 'dm'), images: [{ status: 'available', mediaType: 'image/png', ref }] })).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const items = ((await starts(f))[0]!.params as { input: Array<{ type: string; text?: string }> }).input;
    assert.match(items[0]!.text!, /0 attached; 1 unavailable/);
    assert.equal(items.filter(item => item.type === 'localImage').length, 0);
    assert.deepEqual(requests, [`/images/${ref}`]);
  } finally { await app?.app.close(); kfa.closeAllConnections(); await new Promise<void>(resolve => kfa.close(() => resolve())); await f.close(); }
});
