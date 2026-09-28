import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWebServer, isLoopbackPeer } from '../runtime/server.ts';
import { keetEvent } from '../runtime/keet.ts';
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
    for (const bad of [{ ...valid, images: [] }, { ...valid, text: '' }, { ...valid, trigger: 'dm' }, { ...valid, destination: { groupName: 'News', kind: 'broadcast' }, trigger: 'mention' }, { ...valid, eventId: 'bad' }, { ...valid, timestamp: 1.5 }]) {
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
