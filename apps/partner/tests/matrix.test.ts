import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, loadCredentials, matrixEndpoint } from '../runtime/config.ts';
import { ensureHookDeclaration } from '../runtime/context-bootstrap.ts';
import { classifyMatrixTrigger, discoverMatrixSelf, matrixEvent, matrixInputId, type MatrixEvent } from '../runtime/matrix.ts';
import { createWebServer, isLoopbackPeer } from '../runtime/server.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { Store } from '../runtime/store.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { fixture, eventually } from './fixture.ts';
import { matrixGateway } from './matrix-fixture.ts';

function event(id: string, body = 'ordinary', room = '!room:test', mentions: string[] = []): MatrixEvent {
  return { type: 'message', event_id: id, room_id: room, sender_id: '@other:test', sender_display_name: 'Alice', timestamp: 1_790_000_000_000, body, mentions, truncated: false };
}
async function host(partner: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['createPartner']>>, directory: string) {
  const app = createWebServer(partner, join(directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { app, base, post: (value: unknown) => fetch(`${base}/api/matrix/events`, { method: 'POST', body: JSON.stringify(value) }) };
}
const starts = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.requests()).filter(request => request.method === 'turn/start');
type Turn = { clientUserMessageId: string; input: Array<{ text: string }>; additionalContext: Record<string, { kind: string; value: string }> };

async function setup() {
  const gateway = await matrixGateway(), f = await fixture();
  f.config.matrix = { endpoint: gateway.endpoint, trigger_aliases: ['PartnerAlias'] }; f.credentials.matrix = gateway.token;
  return { gateway, f, async close() { await f.close(); await gateway.close(); } };
}

test('marked DM admission protects SQLite, native context and public history across list changes and restart', async () => {
  const s = await setup(), { f } = s;
  f.config.matrix!.dm_allow_list = ['@other:test'];
  let http: Awaited<ReturnType<typeof host>> | undefined;
  const denied = 'DENIED_DM_PRIVATE_SENTINEL';
  const allowed = { ...event('$allowed-dm', 'ordinary DM'), conversation_type: 'dm' as const };
  try {
    let partner = await f.createPartner(); http = await host(partner, f.directory);
    for (const [n, addressing] of [
      { mentions: ['@self:test'] },
      { reply_to_event_id: '$self', reply_to_sender_id: '@self:test' },
      { body: `${denied} PartnerAlias` },
    ].entries()) assert.equal((await http.post({ ...allowed, event_id: `$denied-${n}`, sender_id: '@denied:test', body: denied, ...addressing })).status, 202);
    for (const [n, body] of ['', ' \n\t'].entries()) assert.equal((await http.post({ ...allowed, event_id: `$blank-dm-${n}`, body, mentions: ['@self:test'] })).status, 202);
    assert.equal((await http.post({ ...allowed, event_id: '$own-dm', sender_id: '@self:test', mentions: ['@self:test'] })).status, 202);
    assert.equal((await starts(f)).length, 0);
    assert.equal((await http.post(allowed)).status, 202);
    await eventually(async () => (await starts(f)).length === 1 && !(await partner.snapshot()).typing);
    const first = (await starts(f))[0]!.params as Turn;
    assert.equal(JSON.parse(first.additionalContext['codex-for-love.matrix-metadata']!.value).trigger, 'dm');
    assert.doesNotMatch(JSON.stringify(first), new RegExp(denied));
    const original = (await partner.snapshot()).messages.find(row => row.id === matrixInputId(allowed));
    assert(original);
    assert.doesNotMatch(JSON.stringify(await createCodexChatBackend(partner).read()), new RegExp(denied));
    await http.app.close(); http = undefined;
    f.config.matrix!.dm_allow_list = [];
    partner = await f.createPartner(); http = await host(partner, f.directory);
    for (const value of [allowed, { ...allowed, body: 'conflicting admitted retry' },
      { ...allowed, event_id: '$empty-list', body: `${denied} PartnerAlias`, mentions: ['@self:test'] }]) assert.equal((await http.post(value)).status, 202);
    assert.equal((await starts(f)).length, 1);
    assert.deepEqual((await partner.snapshot()).messages.find(row => row.id === matrixInputId(allowed)), original);
    const room = { ...event('$later-room', 'PartnerAlias later room'), conversation_type: 'room' as const };
    assert.equal((await http.post(room)).status, 202);
    await eventually(async () => (await starts(f)).length === 2 && !(await partner.snapshot()).typing);
    assert.doesNotMatch(JSON.stringify(await f.requests()), new RegExp(denied));
    assert.doesNotMatch(JSON.stringify(await createCodexChatBackend(partner).read()), new RegExp(denied));
    await http.app.close(); http = undefined;
    const db = new DatabaseSync(partnerPaths(f.workspace).database, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM matrix_receipts WHERE event_id LIKE '$denied-%' OR event_id='$empty-list'").get()!.n, 0);
      for (const table of ['matrix_room_buffers', 'matrix_sources', 'pending_inputs', 'message_meta'])
        assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), new RegExp(denied));
    } finally { db.close(); }
    assert(!Buffer.from(await readFile(partnerPaths(f.workspace).database)).includes(Buffer.from(denied)), 'denied body never persisted, including freed SQLite pages');
  } finally { await http?.app.close(); await s.close(); }
});

test('DM lists are receiver-local, missing means deny-all, and unmarked rooms keep group rules', async () => {
  for (const allowList of [undefined, [], ['@other:test'], ['@Other:test']]) {
    const s = await setup(), { f } = s;
    f.config.matrix!.dm_allow_list = allowList;
    let http: Awaited<ReturnType<typeof host>> | undefined;
    try {
      const partner = await f.createPartner(); http = await host(partner, f.directory);
      const dm = { ...event('$same', 'ordinary'), conversation_type: 'dm' };
      assert.equal((await http.post(dm)).status, 202);
      const expected = allowList?.includes('@other:test') ? 1 : 0;
      if (expected) await eventually(async () => (await starts(f)).length === expected);
      assert.equal((await starts(f)).length, expected);
      assert.equal((await http.post({ ...dm, event_id: '$addressed', body: 'PartnerAlias', mentions: ['@self:test'] })).status, 202);
      if (expected) await eventually(async () => (await starts(f)).length === 2);
      assert.equal((await starts(f)).length, expected * 2);
      assert.equal((await http.post(event('$unmarked', 'unmarked room context'))).status, 202);
      assert.equal((await http.post(event('$group', 'PartnerAlias'))).status, 202);
      await eventually(async () => (await starts(f)).length === expected * 2 + 1);
      const turn = (await starts(f)).at(-1)!.params as Turn;
      assert.equal(JSON.parse(turn.additionalContext['codex-for-love.matrix-metadata']!.value).trigger, 'alias');
      assert.match(turn.additionalContext['codex-for-love.matrix-room-context']!.value, /unmarked room context/);
    } finally { await http?.app.close(); await s.close(); }
  }
});

test('strict optional conversation kind rejects invalid facts before policy denial', async () => {
  const s = await setup(); let http: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await s.f.createPartner(); http = await host(partner, s.f.directory);
    for (const conversation_type of [null, false, '', 'DM', 'unknown', [], {}])
      assert.equal((await http.post({ ...event('$invalid'), conversation_type })).status, 400);
    assert.equal((await http.post({ ...event('$invalid-envelope'), conversation_type: 'dm', extra: true })).status, 422);
    assert.equal((await fetch(`${http.base}/api/matrix/events`, { method: 'POST', body: JSON.stringify({ ...event('$denied-origin'), conversation_type: 'dm' }), headers: { origin: 'http://untrusted.invalid' } })).status, 403);
    assert.equal((await starts(s.f)).length, 0);
  } finally { await http?.app.close(); await s.close(); }
});

test('actual HTTP buffers all rooms, mention wins, exact aliases qualify, and immutable room receipts survive restart', async () => {
  const s = await setup(), { f, gateway } = s;
  let http: Awaited<ReturnType<typeof host>> | undefined;
  try {
    let partner = await f.createPartner(); http = await host(partner, f.directory);
    const ordinary = event('$ordinary', 'preceding room text');
    for (const value of [ordinary, ordinary, event('$false', 'hello Self partneralias', '!room:test', ['', '@self:elsewhere', '@self:test ']),
      { ...event('$reply', 'reply alone'), reply_to_event_id: '$own' }, event('$dm', 'DM room has no implicit trigger', '!dm:test'),
      { ...event('$self', 'PartnerAlias', '!room:test', ['@self:test']), sender_id: '@self:test' }]) assert.equal((await http.post(value)).status, 202);
    assert.equal((await starts(f)).length, 0);
    assert.equal(gateway.requests.filter(item => item.tool === 'whoami').length, 1);
    await http.app.close(); http = undefined;
    partner = await f.createPartner(); http = await host(partner, f.directory);
    const trigger = { ...event('$trigger', 'PartnerAlias please answer', '!room:test', ['@self:test']), reply_to_event_id: '$own', truncated: true };
    assert.equal((await http.post(trigger)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const first = (await starts(f))[0]!.params as Turn;
    assert.equal(first.clientUserMessageId, matrixInputId(trigger));
    assert.match(first.input[0]!.text, /^\[Matrix sender "@other:test" \("Alice"\), room "!room:test"\]\nPartnerAlias please answer$/);
    assert.match(first.additionalContext['codex-for-love.matrix-room-context']!.value, /preceding room text/);
    assert.match(first.additionalContext['codex-for-love.matrix-room-context']!.value, /reply alone/);
    assert.doesNotMatch(first.additionalContext['codex-for-love.matrix-room-context']!.value, /DM room/);
    assert.equal(first.additionalContext['codex-for-love.matrix-room-context']!.kind, 'untrusted');
    assert.equal(first.additionalContext['codex-for-love.matrix-authored']!.kind, 'untrusted');
    const metadata = JSON.parse(first.additionalContext['codex-for-love.matrix-metadata']!.value);
    assert.equal(metadata.trigger, 'mention'); assert.equal(metadata.reply_to_event_id, '$own'); assert.equal(metadata.truncated, true);
    assert.equal(metadata.timestamp, trigger.timestamp);
    assert.match(first.additionalContext['codex-for-love.matrix-source']!.value, /does not inherit.*Human/);
    assert.equal((await http.post({ ...trigger, body: 'changed retry' })).status, 202);
    const alias = event('$alias', 'hello PartnerAlias', '!dm:test');
    assert.equal((await http.post(alias)).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    const second = (await starts(f))[1]!.params as Turn;
    assert.equal(JSON.parse(second.additionalContext['codex-for-love.matrix-metadata']!.value).trigger, 'alias');
    assert.match(second.additionalContext['codex-for-love.matrix-room-context']!.value, /DM room/);
    // Same event ID is independent across rooms and context clearing is local.
    assert.equal((await http.post({ ...trigger, room_id: '!another:test' })).status, 202);
    await eventually(async () => (await starts(f)).length === 3);
    assert.equal(((await starts(f))[2]!.params as Turn).additionalContext['codex-for-love.matrix-room-context'], undefined);
    const snapshot = await partner.snapshot();
    const row = snapshot.messages.find(row => row.id === matrixInputId(trigger))!;
    assert.equal(row.created, trigger.timestamp); assert.match(row.input!, /Matrix sender/); assert.equal(row.keet, undefined);
    await http.app.close(); http = undefined;
    partner = await f.createPartner(); http = await host(partner, f.directory);
    assert.equal((await http.post(trigger)).status, 202); assert.equal((await http.post(alias)).status, 202);
    assert.equal((await starts(f)).length, 3);
    assert.equal((await partner.snapshot()).messages.find(row => row.id === matrixInputId(trigger))!.input, row.input);
    assert.equal(gateway.requests.filter(item => item.tool === 'whoami').length, 3, 'discovery occurs once per startup only');
  } finally { await http?.app.close(); await s.close(); }
});

test('actual HTTP reply wake keeps precedence, private provenance, room isolation and immutable restart receipts', async () => {
  const s = await setup(), { f, gateway } = s;
  let http: Awaited<ReturnType<typeof host>> | undefined;
  try {
    let partner = await f.createPartner(); http = await host(partner, f.directory);
    const own = { ...event('$own-reply', 'ordinary reply'), reply_to_event_id: '$target', reply_to_sender_id: '@self:test' };
    for (const value of [
      { ...own, event_id: '$other-reply', body: 'nonown context', reply_to_sender_id: '@self:elsewhere' },
      { ...event('$unknown-reply', 'unknown context'), reply_to_event_id: '$target' },
      { ...own, event_id: '$isolated', room_id: '!isolated:test', body: 'other-room context', reply_to_sender_id: '@another:test' },
      { ...own, event_id: '$self-reply', sender_id: '@self:test', body: 'PartnerAlias', mentions: ['@self:test'] },
      ...['', ' \n\t'].map((body, n) => ({ ...own, event_id: `$blank-reply-${n}`, body, mentions: ['@self:test'] })),
    ]) assert.equal((await http.post(value)).status, 202);
    assert.equal((await starts(f)).length, 0);
    assert.equal((await http.post(own)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const first = (await starts(f))[0]!.params as Turn;
    assert.equal(first.clientUserMessageId, matrixInputId(own));
    assert.equal(first.input[0]!.text.split('\n').slice(1).join('\n'), own.body);
    const metadata = JSON.parse(first.additionalContext['codex-for-love.matrix-metadata']!.value);
    assert.equal(metadata.trigger, 'reply'); assert.equal(metadata.reply_to_sender_id, own.reply_to_sender_id);
    assert.equal(metadata.reply_to_event_id, own.reply_to_event_id); assert.equal(metadata.timestamp, own.timestamp);
    assert.match(first.additionalContext['codex-for-love.matrix-room-context']!.value, /nonown context/);
    assert.match(first.additionalContext['codex-for-love.matrix-room-context']!.value, /unknown context/);
    assert.doesNotMatch(first.additionalContext['codex-for-love.matrix-room-context']!.value, /other-room context/);
    for (const [n, value, reason] of [
      [2, { ...own, event_id: '$precedence-mention', body: 'PartnerAlias', mentions: ['@self:test'] }, 'mention'],
      [3, { ...own, event_id: '$precedence-reply', body: 'PartnerAlias' }, 'reply'],
      [4, { ...own, event_id: '$precedence-alias', body: 'PartnerAlias', reply_to_sender_id: '@another:test' }, 'alias'],
      [5, { ...own, event_id: '$unknown-alias', body: 'PartnerAlias', reply_to_sender_id: undefined }, 'alias'],
      [6, { ...own, event_id: '$nonown-mention', mentions: ['@self:test'], reply_to_sender_id: '@another:test' }, 'mention'],
      [7, { ...own, room_id: '!isolated:test' }, 'reply'],
    ] as const) {
      assert.equal((await http.post(value)).status, 202);
      await eventually(async () => (await starts(f)).length === n);
      assert.equal(JSON.parse(((await starts(f))[n - 1]!.params as Turn).additionalContext['codex-for-love.matrix-metadata']!.value).trigger, reason);
    }
    const row = (await partner.snapshot()).messages.find(row => row.id === matrixInputId(own))!;
    assert.equal(row.created, own.timestamp); assert.equal(row.matrix?.body, own.body);
    assert.doesNotMatch(JSON.stringify(row.matrix), /reply_to/);
    await http.app.close(); http = undefined;
    partner = await f.createPartner(); http = await host(partner, f.directory);
    for (const value of [own, { ...own, body: 'changed conflict', reply_to_sender_id: '@another:test' },
      { ...own, event_id: '$other-reply', body: 'PartnerAlias', reply_to_sender_id: '@self:test' }])
      assert.equal((await http.post(value)).status, 202);
    assert.equal((await starts(f)).length, 7);
    assert.deepEqual((await partner.snapshot()).messages.find(row => row.id === matrixInputId(own))!.matrix, row.matrix);
    await http.app.close(); http = undefined;
    const db = new DatabaseSync(partnerPaths(f.workspace).database, { readOnly: true });
    try {
      const context = JSON.parse(String(db.prepare('SELECT context FROM matrix_sources WHERE message_id=?').get(matrixInputId(own))!.context));
      assert.deepEqual(context.provenance, own);
    } finally { db.close(); }
    assert.equal(gateway.requests.filter(item => item.tool === 'whoami').length, 2);
  } finally { await http?.app.close(); await s.close(); }
});

test('real HTTP enforces producer schema/bounds, excludes blank native mentions, and reports unavailable admission safely', async (t) => {
  const s = await setup(), { f } = s;
  let http: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); http = await host(partner, f.directory);
    const valid = event('$valid');
    assert.equal(classifyMatrixTrigger(event('$space', '   '), '@self:test', [' ']), undefined);
    const { mentions: _mentions, ...missing } = valid;
    for (const value of [missing, { ...valid, extra: true }, { ...valid, mentions: [false] }, { ...valid, mentions: ['x'.repeat(256)] },
      { ...valid, mentions: Array(101).fill('') }, { ...valid, body: '😀'.repeat(8001) }, { ...valid, sender_display_name: 'x'.repeat(256) }, { ...valid, sender_display_name: '😀'.repeat(128) },
      { ...valid, timestamp: '1' }, { ...valid, timestamp: 1.5 }, { ...valid, truncated: 1 }, { ...valid, reply_to_event_id: null }, { ...valid, event_id: '' }])
      assert.equal((await http.post(value)).status, 422);
    for (const author of [null, false, '', '@missing', 'display name', '@self:test ', '@self:te\nst', '@a:b'.padEnd(256, 'x'), `@${'😀'.repeat(125)}:test`])
      assert.equal((await http.post({ ...valid, reply_to_event_id: '$target', reply_to_sender_id: author })).status, 422);
    for (const target of [undefined, ''])
      assert.equal((await http.post({ ...valid, reply_to_event_id: target, reply_to_sender_id: '@self:test' })).status, 422);
    assert(matrixEvent.safeParse({ ...valid, reply_to_event_id: '$target', reply_to_sender_id: '@a:b'.padEnd(255, 'x') }).success);
    assert.equal((await fetch(`${http.base}/api/matrix/events`, { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) })).status, 400);
    assert.equal((await http.post({ ...event('$empty', ''), sender_display_name: '', mentions: ['', 'not-a-user'] })).status, 202);
    assert.equal((await http.post({ ...event('$white', '   '), sender_display_name: '   ' })).status, 202);
    assert.equal((await starts(f)).length, 0);
    for (const [index, body] of ['', '   ', '😀'.repeat(8000)].entries()) {
      const value = { ...event(`$blank-${index}`, body, '!blank:test', ['@self:test']), sender_display_name: '' };
      assert.equal((await http.post(value)).status, 202);
      if (body.trim()) {
        await eventually(async () => (await starts(f)).length === 1);
        assert.equal(((await starts(f))[0]!.params as Turn).input[0]!.text.split('\n').slice(1).join('\n'), body);
      } else assert.equal((await starts(f)).length, 0);
    }
    t.mock.method(partner, 'ingestMatrix', async () => { throw new Error('synthetic-matrix-only-token'); });
    const failed = await http.post(valid); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /synthetic-matrix-only-token/);
    t.mock.restoreAll();
    await partner.close(); assert.equal((await http.post(event('$closed'))).status, 503);
    assert(isLoopbackPeer('127.0.0.1')); assert(isLoopbackPeer('::1')); assert(!isLoopbackPeer('192.0.2.1'));
  } finally { await http?.app.close(); await s.close(); }
  const disabled = await fixture();
  try {
    const partner = await disabled.createPartner(); http = await host(partner, disabled.directory);
    assert.equal((await http.post(event('$disabled'))).status, 404);
  } finally { await http?.app.close(); await disabled.close(); }
});

test('Matrix and Keet pending inputs resume with original source/time and never start concurrently', async () => {
  const s = await setup(), { f } = s;
  f.appServer.env.FAKE_RESUME_ACTIVE = 'true';
  f.config.keet = { endpoint: 'http://127.0.0.1:8765' }; f.credentials.keet = 'test-only-keet';
  f.config.matrix!.dm_allow_list = ['@other:test'];
  let http: Awaited<ReturnType<typeof host>> | undefined;
  try {
    await f.holdProvider(true);
    let partner = await f.createPartner(); http = await host(partner, f.directory);
    const first = event('$first', 'PartnerAlias hold');
    const queued = { ...event('$queued', 'ordinary DM queued'), conversation_type: 'dm' as const }; queued.timestamp -= 100_000;
    assert.equal((await http.post(first)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.equal((await http.post(queued)).status, 202);
    const keet = { type: 'message' as const, eventId: '11111111-1111-4111-8111-111111111111', sequence: 1, messageId: { deviceId: 'peer', seq: 1 }, timestamp: 1,
      destination: { groupName: '!room:test', kind: 'dm' as const }, senderLabel: 'Keet peer', text: 'Keet queued', addressing: { mentionsIdentity: false } };
    await partner.ingestKeet(keet);
    assert.equal((await starts(f)).length, 1); assert(!(await f.requests()).some(request => request.method === 'turn/steer'));
    await http.app.close(); http = undefined;
    await f.holdProvider(false);
    partner = await f.createPartner(); http = await host(partner, f.directory);
    await eventually(async () => (await starts(f)).length === 3);
    const turns = (await starts(f)).map(row => row.params as Turn);
    assert.equal(turns[1]!.clientUserMessageId, matrixInputId(queued));
    assert.equal(JSON.parse(turns[1]!.additionalContext['codex-for-love.matrix-metadata']!.value).timestamp, queued.timestamp);
    assert.equal(JSON.parse(turns[1]!.additionalContext['codex-for-love.matrix-metadata']!.value).trigger, 'dm');
    assert.match(turns[1]!.additionalContext['codex-for-love.message-time']!.value, /Qualifying Matrix input/);
    assert.equal(turns[1]!.additionalContext['codex-for-love.keet-kind'], undefined);
    assert.equal(turns[2]!.additionalContext['codex-for-love.keet-kind']!.value, 'Keet dm');
    assert.equal((await http.post(queued)).status, 202); assert.equal((await starts(f)).length, 3);
  } finally { await http?.app.close(); await s.close(); }
});

test('failed native Matrix starts stay durable without retrying in-process and recover with provenance after restart', async () => {
  const s = await setup(), { f } = s;
  let http: Awaited<ReturnType<typeof host>> | undefined;
  try {
    await f.rejectStart(true);
    let partner = await f.createPartner(); http = await host(partner, f.directory);
    const first = event('$failed-start', 'PartnerAlias first');
    assert.equal((await http.post(first)).status, 202);
    await eventually(async () => (await starts(f)).length === 1 && (await partner.snapshot()).messages[0]?.delivery === 'unresolved');
    assert.equal((await http.post(first)).status, 202);
    // A later wake must not blindly resubmit the uncertain earlier attempt.
    await f.rejectStart(false);
    const second = event('$later-start', 'PartnerAlias later');
    assert.equal((await http.post(second)).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    assert.equal(((await starts(f))[1]!.params as Turn).clientUserMessageId, matrixInputId(second));
    await http.app.close(); http = undefined;
    partner = await f.createPartner(); http = await host(partner, f.directory);
    await eventually(async () => (await starts(f)).length === 3);
    const recovered = (await starts(f))[2]!.params as Turn;
    assert.equal(recovered.clientUserMessageId, matrixInputId(first));
    assert.equal(JSON.parse(recovered.additionalContext['codex-for-love.matrix-metadata']!.value).timestamp, first.timestamp);
    assert.match(recovered.input[0]!.text, /Matrix sender/);
  } finally { await http?.app.close(); await s.close(); }
});

test('Matrix arrivals wait during compaction and drain after native idle completion', async () => {
  const s = await setup(), { f } = s;
  let http: Awaited<ReturnType<typeof host>> | undefined;
  try {
    await f.holdCompaction(true, true);
    const partner = await f.createPartner(); http = await host(partner, f.directory);
    await partner.compact();
    assert.equal((await http.post(event('$compact', 'PartnerAlias after compact'))).status, 202);
    assert.equal((await starts(f)).length, 0);
    await f.holdCompaction(false);
    await eventually(async () => (await starts(f)).length === 1);
    assert.match(((await starts(f))[0]!.params as Turn).input[0]!.text, /Matrix sender/);
  } finally { await http?.app.close(); await s.close(); }
});

test('SQLite transactions roll back failed intake, cap room context and retain original full provenance', async () => {
  const f = await fixture(); await mkdir(join(f.workspace, '.lamplit'), { recursive: true });
  const store = new Store(partnerPaths(f.workspace).database);
  try {
    for (let n = 0; n < 70; n++) await store.recordMatrixEvent(event(`$${n}`, `${n} small context`));
    const trigger = event('$cap', 'PartnerAlias');
    await store.recordMatrixEvent(trigger, 'alias');
    const context = await store.matrixContext(matrixInputId(trigger));
    assert(context?.roomContext); assert(Buffer.byteLength(context.roomContext) <= 800);
    assert.match(context.roomContext, /69 small context/); assert.doesNotMatch(context.roomContext, /\n0 small context/);
    assert.deepEqual(context.provenance, trigger);
    for (let n = 0; n < 2; n++) await store.recordMatrixEvent(event(`$big-${n}`, 'x'.repeat(9000)));
    const next = event('$next', 'PartnerAlias'); await store.recordMatrixEvent(next, 'alias');
    assert.equal((await store.matrixContext(matrixInputId(next)))!.roomContext!.length <= 800, true);
    const bad = { ...event('$rollback', 'PartnerAlias'), timestamp: NaN };
    await assert.rejects(store.recordMatrixEvent(bad, 'alias'));
    const corrected = { ...bad, timestamp: 1 }; assert.equal(await store.recordMatrixEvent(corrected, 'alias'), true);
    assert.equal(await store.recordMatrixEvent({ ...corrected, body: 'different content' }, 'mention'), false);
    assert.equal((await store.matrixContext(matrixInputId(corrected)))!.provenance.body, 'PartnerAlias');
    assert.notEqual(matrixInputId(event('$a', '', '!b:c')), matrixInputId(event('$a:!b', '', 'c')));
  } finally { await store.close(); await f.close(); }
});

test('durable room buffers enforce count and character caps before any trigger', async () => {
  const f = await fixture(); await mkdir(join(f.workspace, '.lamplit'), { recursive: true });
  const path = partnerPaths(f.workspace).database, store = new Store(path);
  let closed = false;
  try {
    for (let n = 0; n < 70; n++) await store.recordMatrixEvent(event(`$${n}`, String(n), '!count:test'));
    await store.recordMatrixEvent(event('$big-one', 'a'.repeat(9000), '!size:test'));
    await store.recordMatrixEvent(event('$big-two', 'b'.repeat(9000), '!size:test'));
    await store.recordMatrixEvent(event('$oversized-record', 'c'.repeat(16000), '!oversize:test'));
    await store.close(); closed = true;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const buffers = new Map(database.prepare('SELECT room_id,records FROM matrix_room_buffers').all().map(row => [row.room_id, JSON.parse(String(row.records)) as MatrixEvent[]]));
      assert.equal(buffers.get('!count:test')!.length, 64); assert.equal(buffers.get('!count:test')![0]!.event_id, '$6');
      assert.equal(buffers.get('!size:test')!.length, 1); assert.equal(buffers.get('!size:test')![0]!.event_id, '$big-two');
      assert.deepEqual(buffers.get('!oversize:test'), []);
    } finally { database.close(); }
  } finally { if (!closed) await store.close(); await f.close(); }
});

test('Matrix DM config validates exact bounded unique full IDs without normalization', async () => {
  const f = await fixture(), path = join(f.directory, 'partner.toml');
  const base = 'name="Mica"\npersona="persona.md"\n[matrix]\n';
  try {
    for (const list of [[], ['@Other:test', '@other:test'], [`@${'😀'.repeat(124)}:test`], Array.from({ length: 64 }, (_, n) => `@${n}:${'x'.repeat(253 - String(n).length)}`)]) {
      await writeFile(path, `${base}dm_allow_list=${JSON.stringify(list)}\n`);
      assert.deepEqual((await loadConfig(path)).matrix!.dm_allow_list, list);
    }
    for (const list of [null, false, '@other:test', [1], ['@other:test', '@other:test'],
      ['other:test'], ['@missing'], ['@a:b '], [' @a:b'], ['@a:te\nst'], ['@a:b'.padEnd(256, 'x')],
      [`@${'😀'.repeat(125)}:test`], Array.from({ length: 65 }, (_, n) => `@${n}:test`)]) {
      await writeFile(path, `${base}dm_allow_list=${JSON.stringify(list)}\n`);
      await assert.rejects(loadConfig(path));
    }
    await writeFile(path, `${base}dm_allow_list=["@a:b"]\nunknown=true\n`); await assert.rejects(loadConfig(path));
    await writeFile(path, 'name="Mica"\npersona="persona.md"\n[keet]\ndm_allow_list=["@a:b"]\n'); await assert.rejects(loadConfig(path));
  } finally { await f.close(); }
});

test('Matrix config, private credential, MCP ownership and environment preserve unrelated settings', async () => {
  const s = await setup(), { f, gateway } = s;
  const path = join(f.directory, 'partner.toml');
  try {
    const base = `name="Mica"\npersona="persona.md"\nstate="."\n[matrix]\nendpoint="${gateway.endpoint}"\ntrigger_aliases=["Alias"]\n`;
    await writeFile(path, base); assert.deepEqual((await loadConfig(path)).matrix, { endpoint: gateway.endpoint, trigger_aliases: ['Alias'], dm_allow_list: [] });
    for (const aliases of ['["Alias","Alias"]', '[""]', '[" untrimmed"]', JSON.stringify(Array.from({ length: 33 }, (_, i) => `A${i}`))]) {
      await writeFile(path, base.replace('["Alias"]', aliases)); await assert.rejects(loadConfig(path));
    }
    for (const endpoint of ['https://127.0.0.1:80', 'http://localhost:80', 'http://127.0.0.1:80/mcp', 'http://user:secret@127.0.0.1:80', 'http://127.0.0.1:80?token=secret']) assert.throws(() => matrixEndpoint(endpoint), /Matrix endpoint/);
    await writeFile(path, base);
    await writeFile(join(f.directory, 'credentials.json'), JSON.stringify({ speech: 'test-only-speech' }));
    const credential = spawnSync(process.execPath, [join(import.meta.dirname, '../runtime/cli.ts'), 'credential', path, 'matrix', '--stdin'], { input: gateway.token, encoding: 'utf8' });
    assert.equal(credential.status, 0, credential.stderr); assert(!credential.stdout.includes(gateway.token));
    assert.deepEqual(await loadCredentials(f.directory, {}), { matrix: gateway.token, speech: 'test-only-speech' });
    assert.equal((await stat(join(f.directory, 'credentials.json'))).mode & 0o777, 0o600);
    await mkdir(join(f.workspace, '.codex'), { recursive: true });
    const configPath = join(f.workspace, '.codex/config.toml');
    await writeFile(configPath, 'model_reasoning_effort="low"\n[mcp_servers.web]\ncommand="operator-web"\n');
    const stored = JSON.stringify({ speech: 'test-only-speech', matrix: 'test-only-stale-token' });
    await writeFile(join(f.directory, 'credentials.json'), stored);
    Object.assign(f.credentials, await loadCredentials(f.directory, { MATRIX_ACCESS_TOKEN: gateway.token }));
    f.appServer.env.FAKE_EXPECT_MATRIX_TOKEN = gateway.token;
    const partner = await f.createPartner();
    const raw = await readFile(configPath, 'utf8'), config = parse(raw);
    assert.equal(config.model_reasoning_effort, 'low');
    assert.deepEqual((config.mcp_servers as Record<string, unknown>).matrix, { url: `${gateway.endpoint}/mcp`, bearer_token_env_var: 'CFL_MATRIX_TOKEN' });
    assert.equal(((config.mcp_servers as Record<string, Record<string, unknown>>).web!).command, 'operator-web');
    assert.doesNotMatch(raw, new RegExp(gateway.token));
    assert.equal(JSON.parse(await readFile(f.appServer.env.FAKE_SERVER_CONTEXT!, 'utf8')).matrixTokenMatches, true);
    assert.equal(await readFile(join(f.directory, 'credentials.json'), 'utf8'), stored);
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.endpoint}/mcp`), { requestInit: { headers: { authorization: `Bearer ${gateway.token}` } } }));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['list_room_members', 'list_rooms', 'read_messages', 'send_message', 'whoami']);
    } finally { await client.close(); }
    await partner.close(); f.config.matrix = undefined; f.credentials.matrix = undefined;
    await f.createPartner();
    assert.equal((parse(await readFile(configPath, 'utf8')).mcp_servers as Record<string, unknown>).matrix, undefined);
    await writeFile(configPath, '[mcp_servers.matrix]\ncommand="operator-matrix"\n');
    await ensureHookDeclaration(f.workspace, join(f.workspace, '.lamplit/context.json'));
    assert.equal(((parse(await readFile(configPath, 'utf8')).mcp_servers as Record<string, Record<string, unknown>>).matrix!).command, 'operator-matrix');
    await assert.rejects(ensureHookDeclaration(f.workspace, join(f.workspace, '.lamplit/context.json'), undefined, undefined, gateway.endpoint), /belongs to an operator/);
    assert.equal(gateway.active, 0);
  } finally { await s.close(); }
});

test('startup refuses partial/invalid/unavailable MCP configuration, bounds timeout and closes probe resources', async () => {
  const s = await setup(), { f, gateway } = s;
  try {
    f.credentials.matrix = undefined; await assert.rejects(f.createPartner(), /requires both/);
    f.config.matrix = undefined; f.credentials.matrix = gateway.token; await assert.rejects(f.createPartner(), /requires both/);
    f.config.matrix = { endpoint: gateway.endpoint };
    for (const identity of [null, { user_id: '' }, { user_id: '@wrong' }, { user_id: '@x:test'.repeat(50) }]) {
      gateway.identity = identity; await assert.rejects(f.createPartner(), /Matrix startup discovery failed/);
      assert.equal(gateway.active, 0);
    }
    gateway.mode = 'error'; await assert.rejects(f.createPartner(), error => error instanceof Error && !error.message.includes(gateway.token));
    gateway.mode = 'hang'; const start = Date.now();
    await assert.rejects(discoverMatrixSelf(gateway.endpoint, gateway.token), /Matrix startup discovery failed/);
    assert(Date.now() - start < 6500); await eventually(async () => gateway.sockets === 0);
    await gateway.close();
    await assert.rejects(discoverMatrixSelf(gateway.endpoint, gateway.token), /Matrix startup discovery failed/);
  } finally { await s.close(); }
});
