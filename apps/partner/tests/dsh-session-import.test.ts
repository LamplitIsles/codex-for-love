import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { convertDshSession, DshSessionImportError, inspectDshLog } from '../runtime/dsh-session-import.ts';
import { readRelationshipJournal } from '../runtime/relationship-journal.ts';
import { Store } from '../runtime/store.ts';
import { fixture } from './fixture.ts';

type Row = Record<string, unknown>;

function sessionLog(): string {
  const rows: Row[] = [{ type: 'session', version: 3, id: 'dsh-fixture', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/tmp/dsh-fixture' }];
  const events: Row[] = [];
  let time = 1_780_000_000_000;
  const add = (type: string, data: Row, extra: Row = {}) => { events.push({ type, seq: events.length, time, data, ...extra }); time += 1; };
  const turn = (number: number, user: string, assistant: string, userContent?: unknown[]) => {
    add('turn/start', { turn: number });
    add('user/message', { id: `u${number}`, role: 'user', content: userContent ?? [{ type: 'text', text: user }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    add('tool/call', { turn: number, callId: `tool-${number}`, arguments: 'discard me' });
    time += 2_000;
    add('assistant/message', { turn: number, message: { id: `a${number}`, role: 'assistant', content: [{ type: 'text', text: assistant }], source: { kind: 'model' } }, stream: [] }, { surfaceOp: 'append' });
    add('turn/end', { turn: number, reason: { kind: 'completed' } });
  };
  turn(1, 'one user', 'one assistant');
  turn(2, 'two user', 'two assistant');
  const firstStart = events.length;
  add('compaction/start', { compactionId: 'first', turn: null });
  const firstSummary = events.length;
  add('compaction/summary', { compactionId: 'first', summary: [{ type: 'text', text: 'first summary' }], shadowedRange: { start: 1, end: 8 }, shadowedSeqs: [1, 3, 6, 8], shadowedTokenCount: 10, provider: 'fixture', model: 'fixture' });
  add('user/message', { id: 'c1', role: 'user', content: [{ type: 'text', text: 'source framing one' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'first' } }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 8 }, sourceEventSeqs: [firstStart, firstSummary, 1, 3, 6, 8] });
  add('compaction/end', { compactionId: 'first', turn: null });
  const digest = createHash('sha256').update('historical image').digest('hex');
  turn(3, 'three user', 'three assistant', [{ type: 'text', text: 'three user' }, { type: 'image', attachment: { attachmentId: `sha256:${digest}`, name: 'rain.png', mediaType: 'image/png', bytes: 16 } }]);
  const secondStart = events.length;
  add('compaction/start', { compactionId: 'second', turn: null });
  const secondSummary = events.length;
  add('compaction/summary', { compactionId: 'second', summary: [{ type: 'text', text: 'second summary' }], shadowedRange: { start: 12, end: 17 }, shadowedSeqs: [12, 15, 17], shadowedTokenCount: 10, provider: 'fixture', model: 'fixture' });
  add('user/message', { id: 'c2', role: 'user', content: [{ type: 'text', text: 'source framing two' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'second' } }, { surfaceOp: { op: 'replace', startSeq: 12, endSeq: 17 }, sourceEventSeqs: [secondStart, secondSummary, 12, 15, 17] });
  add('compaction/end', { compactionId: 'second', turn: null });
  turn(4, 'four user', 'four assistant');
  return `${[...rows, ...events].map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function physicalV0Log(): string {
  const rows = sessionLog().trimEnd().split('\n').map((line) => JSON.parse(line) as Row);
  rows[0] = { type: 'session', version: 0, id: 'dsh-physical-v0', createdAt: 1, cwd: '/tmp/dsh-fixture', parentSession: 'parent', seedLength: 0, delegationDepth: 0 };
  const remapSeq = (value: unknown): unknown => Array.isArray(value)
    ? value.map(remapSeq)
    : typeof value === 'number' ? value * 2 : value;
  const physical: Row[] = [rows[0]!];
  for (const [index, row] of rows.slice(1).entries()) {
    const mapped = structuredClone(row);
    mapped.seq = (row.seq as number) * 2;
    if (index === 3 && row.type === 'assistant/message') mapped.sourceEventSeqs = [3];
    if (Array.isArray(row.sourceEventSeqs)) mapped.sourceEventSeqs = remapSeq(row.sourceEventSeqs);
    if (typeof row.surfaceOp === 'object' && row.surfaceOp !== null && !Array.isArray(row.surfaceOp)) {
      const op = row.surfaceOp as Row;
      mapped.surfaceOp = { op: 'replace', start: (op.startSeq as number) * 2, end: (op.endSeq as number) * 2 };
    }
    if (row.type === 'compaction/summary') {
      const data = mapped.data as Row;
      const range = data.shadowedRange as Row;
      data.shadowedRange = { start: (range.start as number) * 2, end: (range.end as number) * 2 };
      data.shadowedSeqs = remapSeq(data.shadowedSeqs);
    }
    physical.push(mapped);
    if (index === 1) physical.push({ type: 'text-chunks', seq0: (mapped.seq as number) + 1, time0: 3, data: { turn: 1, step: 0, index: 0, dt: [], texts: ['discarded'] } });
    if (index === 6) physical.push({ type: 'reasoning-chunks', seq0: (mapped.seq as number) + 1, time0: 8, data: { turn: 1, step: 0, index: 0, dt: [], texts: ['discarded'] } });
    if (index === 12) physical.push({ type: 'tool-call-chunks', seq0: (mapped.seq as number) + 1, time0: 14, data: { turn: 2, step: 0, index: 0, id: 'discarded', dt: [], args: ['{}'] } });
  }
  return `${physical.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

const stateHistory = `${JSON.stringify({ at: '2026-09-13T00:00:00.000Z', changes: { seed: true }, state: { mood: 'neutral', affinity: 50, signature: '' } })}\n${JSON.stringify({ at: '2026-09-13T01:00:00.000Z', changes: { mood: { value: 'bright', note: '下雨了', reason: '一起看雨' }, affinity: { delta: 2, value: 52, reason: '共同期待' }, signature: { value: 'Blueberry', reason: '共同取名' } }, state: { mood: 'bright', note: '下雨了', affinity: 52, signature: 'Blueberry' } })}\n`;

async function sources(f: Awaited<ReturnType<typeof fixture>>) {
  const session = join(f.directory, 'session.jsonl');
  const state = join(f.directory, 'state.jsonl');
  const attachments = join(f.directory, 'attachments-v1');
  const bytes = Buffer.from('historical image');
  const digest = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(attachments, 'objects', digest.slice(0, 2)), { recursive: true });
  await writeFile(join(attachments, 'objects', digest.slice(0, 2), digest), bytes);
  await writeFile(session, sessionLog());
  await writeFile(state, stateHistory);
  return { session, state, attachments, bytes, digest };
}

test('reduces a stable log to complete text and compact boundaries', async () => {
  const f = await fixture();
  try {
    const source = await sources(f);
    const result = await inspectDshLog(source.session);
    assert.deepEqual(result.records.map((record) => record.type), ['user', 'assistant', 'user', 'assistant', 'compact', 'user', 'assistant', 'compact', 'user', 'assistant']);
    assert.deepEqual(result.report.messages, { user: 4, assistant: 4 });
    assert.equal(result.report.compactions.length, 2);
    assert.equal(result.media[0]?.attachmentId, `sha256:${source.digest}`);
    assert.doesNotMatch(JSON.stringify(result.records), /discard me|source framing/);
  } finally { await f.close(); }
});

test('accepts released physical v0 packed rows while preserving logical semantics and strict order', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'physical-v0.jsonl');
    const source = physicalV0Log();
    await writeFile(path, source);
    const result = await inspectDshLog(path);
    assert.equal(result.report.source.formatVersion, 0);
    assert.equal(result.report.omitted.packedChunkRows, 3);
    assert.deepEqual(result.records.map((record) => record.type), ['user', 'assistant', 'user', 'assistant', 'compact', 'user', 'assistant', 'compact', 'user', 'assistant']);
    assert.doesNotMatch(JSON.stringify(result.records), /discarded/);
    assert.equal(await readFile(path, 'utf8'), source);

    const malformed = join(f.directory, 'malformed-packed.jsonl');
    await writeFile(malformed, physicalV0Log().replace('"dt":[]', '"dt":[1]'));
    await assert.rejects(inspectDshLog(malformed), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'invalid-input');

    const futureReference = join(f.directory, 'future-reference-v0.jsonl');
    await writeFile(futureReference, physicalV0Log().replace('"sourceEventSeqs":[3]', '"sourceEventSeqs":[999]'));
    await assert.rejects(inspectDshLog(futureReference), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'invalid-input');

    const unordered = join(f.directory, 'unordered-v0.jsonl');
    const rows = physicalV0Log().trimEnd().split('\n');
    const event = JSON.parse(rows[2]!) as Row;
    event.seq = 0;
    rows[2] = JSON.stringify(event);
    await writeFile(unordered, `${rows.join('\n')}\n`);
    await assert.rejects(inspectDshLog(unordered), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'invalid-input');

    const logicalWithProvenance = join(f.directory, 'logical-assistant-provenance.jsonl');
    const logicalRows = sessionLog().trimEnd().split('\n');
    const assistantIndex = logicalRows.findIndex((line) => line.includes('"type":"assistant/message"'));
    const assistant = JSON.parse(logicalRows[assistantIndex]!) as Row;
    assistant.sourceEventSeqs = [0];
    logicalRows[assistantIndex] = JSON.stringify(assistant);
    await writeFile(logicalWithProvenance, `${logicalRows.join('\n')}\n`);
    await assert.rejects(inspectDshLog(logicalWithProvenance), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'invalid-input');
  } finally { await f.close(); }
});

test('imports only user-authored user messages', async () => {
  const f = await fixture();
  try {
    const rows = sessionLog().trimEnd().split('\n').map((line) => JSON.parse(line) as Row);
    const lastEnd = rows.findLastIndex((row) => row.type === 'turn/end');
    const end = rows[lastEnd]!;
    const seq = end.seq as number;
    end.seq = seq + 2;
    rows.splice(lastEnd, 0, {
      type: 'user/message', seq, time: seq,
      data: { id: 'plugin-message', role: 'user', content: [{ type: 'text', text: '<plugin_context>ignore</plugin_context>' }], source: { kind: 'plugin', plugin: 'legacy-recall', form: 'recall' } },
      surfaceOp: 'append',
    }, {
      type: 'user/message', seq: seq + 1, time: seq + 1,
      data: { id: 'image-only', role: 'user', content: [{ type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'history.png', mediaType: 'image/png' } }], source: { kind: 'user' } },
      surfaceOp: 'append',
    });
    const path = join(f.directory, 'injected.jsonl');
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const result = await inspectDshLog(path);
    assert.equal(result.report.messages.user, 5);
    assert.equal(result.records.some((record) => record.type === 'user' && record.text === ''), true);
    assert.doesNotMatch(JSON.stringify(result.records), /plugin_context|ignore/);
  } finally { await f.close(); }
});

test('retains finalized text from a superseded historical turn but rejects a trailing open turn', async () => {
  const f = await fixture();
  try {
    const historical = join(f.directory, 'superseded-history.jsonl');
    const rows = sessionLog().trimEnd().split('\n');
    const firstEnd = rows.findIndex((line) => line.includes('"type":"turn/end"') && line.includes('"turn":1'));
    rows.splice(firstEnd, 1);
    for (let index = 1; index < rows.length; index += 1) {
      const row = JSON.parse(rows[index]!) as Row;
      const data = row.data as Row;
      if (row.type === 'compaction/summary' && data.compactionId === 'first') {
        data.shadowedRange = { start: 6, end: 8 };
        data.shadowedSeqs = [6, 8];
      }
      if (row.type === 'user/message' && (data.source as Row | undefined)?.compactionId === 'first') {
        row.surfaceOp = { op: 'replace', startSeq: 6, endSeq: 8 };
        row.sourceEventSeqs = [10, 11, 6, 8];
      }
      rows[index] = JSON.stringify(row);
    }
    await writeFile(historical, `${rows.join('\n')}\n`);
    const result = await inspectDshLog(historical);
    assert.deepEqual(result.records.slice(0, 2).map((record) => record.type === 'compact' ? '' : record.text), ['one user', 'one assistant']);
    assert.match(JSON.stringify(result.records.find((record) => record.type === 'compact')?.replacement), /one user|one assistant/);

    const trailing = join(f.directory, 'trailing-open.jsonl');
    const trailingRows = sessionLog().trimEnd().split('\n');
    trailingRows.splice(trailingRows.length - 1, 1);
    await writeFile(trailing, `${trailingRows.join('\n')}\n`);
    await assert.rejects(inspectDshLog(trailing), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'invalid-input');
  } finally { await f.close(); }
});

test('dry-run is side-effect free and conversion creates one native candidate', async () => {
  const f = await fixture();
  try {
    const source = await sources(f);
    const settings = join(f.directory, 'settings.yaml');
    const companionAvatar = Buffer.from('companion avatar');
    const userAvatar = Buffer.from('user avatar');
    f.config.avatars = {
      companion: join(f.workspace, '.lamplit', 'profile', 'companion-avatar.png'),
      user: join(f.workspace, '.lamplit', 'profile', 'user-avatar.png'),
    };
    await writeFile(settings, `dsh-companion:\n  companionAvatar:\n    data: data:image/png;base64,${companionAvatar.toString('base64')}\n    mediaType: image/png\n  userAvatar:\n    data: data:image/png;base64,${userAvatar.toString('base64')}\n    mediaType: image/png\n`);
    const beforeSession = await readFile(source.session);
    const beforeState = await readFile(source.state);
    const beforeMedia = await readFile(join(source.attachments, 'objects', source.digest.slice(0, 2), source.digest));
    const dry = await convertDshSession(f.config, source.session, source.state, source.attachments, f.workspace, { appServer: f.appServer }, { dryRun: true, dshSettingsPath: settings });
    assert.equal(dry.destination.created, false);
    assert.equal(dry.report.relationships, 2);
    assert.equal(dry.report.avatars, 2);
    assert.equal((await f.requests()).length, 0);
    const converted = await convertDshSession(f.config, source.session, source.state, source.attachments, f.workspace, { appServer: f.appServer }, { dshSettingsPath: settings });
    const rolloutPath = converted.destination.rolloutPath!;
    const rollout = (await readFile(rolloutPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Row);
    assert.equal(rollout.filter((line) => line.type === 'compacted').length, 2);
    const started = rollout.filter((line) => line.type === 'event_msg' && (line.payload as Row)?.type === 'task_started')
      .map((line) => ((line.payload as Row).started_at));
    const completed = rollout.filter((line) => line.type === 'event_msg' && (line.payload as Row)?.type === 'task_complete')
      .map((line) => ((line.payload as Row).started_at));
    assert.deepEqual(completed, started);
    const importedUsers = rollout
      .filter((line) => line.type === 'event_msg' && (line.payload as Row)?.type === 'item_completed')
      .map((line) => ((line.payload as Row).item as Row))
      .filter((item) => item.type === 'UserMessage');
    assert.ok(importedUsers.length > 0);
    assert.equal(new Set(importedUsers.map((item) => item.client_id)).size, importedUsers.length);
    assert.ok(importedUsers.every((item) => typeof item.client_id === 'string' && /^[0-9a-f-]{36}$/u.test(item.client_id)));
    const importedImage = importedUsers.flatMap((item) => item.content as Row[]).find((item) => item.type === 'local_image');
    assert.equal(importedImage?.path, join(f.workspace, '.lamplit', 'historical-media', `${source.digest}.png`));
    assert.doesNotMatch(JSON.stringify(rollout), /discard me|source framing/);
    const resume = (await f.requests()).find((request) => request.method === 'thread/resume')!;
    assert.equal((resume.params as Row).path, rolloutPath);
    assert.equal('history' in (resume.params as Row), false);
    const fakeState = JSON.parse(await readFile(f.appServer.env.FAKE_SERVER_STATE!, 'utf8')) as { importedHistory: unknown[]; turns: unknown[] };
    assert.match(JSON.stringify(fakeState.importedHistory), /second summary/);
    assert.match(JSON.stringify(fakeState.importedHistory), /four user|four assistant/);
    assert.doesNotMatch(JSON.stringify(fakeState.importedHistory), /one user|two user|three user/);
    assert.doesNotMatch(JSON.stringify(fakeState.importedHistory), /historical-media|local_image/);
    assert.equal(fakeState.turns.length, 6);
    {
      const history = await readRelationshipJournal(join(f.workspace, '.lamplit', 'relationship.jsonl')); assert.equal(history.length, 2); assert.equal(history.at(-1)?.state.signature, 'Blueberry');
      const store = new Store(join(f.workspace, '.lamplit', 'session.sqlite'));
      const boundaries = await store.compactBoundaries();
      assert.equal(boundaries.length, 2);
      assert.deepEqual(boundaries.map((boundary) => boundary.id), ['dsh:first', 'dsh:second']);
      assert.ok(boundaries.every((boundary) => boundary.position === 'after' && importedUsers.some((item) => item.client_id === boundary.anchorId)));
      await store.close(); }
    assert.deepEqual(await readFile(join(f.workspace, '.lamplit', 'historical-media', `${source.digest}.png`)), source.bytes);
    assert.deepEqual(await readFile(f.config.avatars.companion), companionAvatar);
    assert.deepEqual(await readFile(f.config.avatars.user), userAvatar);
    assert.deepEqual(await readFile(source.session), beforeSession);
    assert.deepEqual(await readFile(source.state), beforeState);
    assert.deepEqual(await readFile(join(source.attachments, 'objects', source.digest.slice(0, 2), source.digest)), beforeMedia);
  } finally { await f.close(); }
});

test('reports the isolated candidate after app-server resume fails', async () => {
  const f = await fixture();
  try {
    const source = await sources(f);
    await writeFile(f.appServer.env.FAKE_SERVER_CONTROL!, JSON.stringify({ failResume: true }));
    await assert.rejects(
      convertDshSession(f.config, source.session, source.state, source.attachments, f.workspace, { appServer: f.appServer }),
      (error: unknown) => {
        assert.ok(error instanceof DshSessionImportError);
        assert.equal(error.kind, 'candidate-created');
        assert.equal(error.candidate?.path, f.workspace);
        assert.equal(error.candidate?.workspacePath, f.workspace);
        assert.match(error.candidate?.rolloutPath ?? '', /\.jsonl$/u);
        assert.match(error.candidate?.provisionalThreadId ?? '', /^[0-9a-f-]{36}$/u);
        assert.match(error.message, /workspace=.*rollout=.*provisionalThreadId=/u);
        return true;
      },
    );
  } finally { await f.close(); }
});

test('rejects malformed state, missing media and incomplete work before writes', async () => {
  const f = await fixture();
  try {
    const source = await sources(f);
    await writeFile(join(f.workspace, 'occupied'), 'owned');
    await assert.rejects(convertDshSession(f.config, source.session, source.state, source.attachments, f.workspace, {}, { dryRun: true }), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'occupied-destination');
    await (await import('node:fs/promises')).rm(join(f.workspace, 'occupied'));
    await writeFile(source.state, '{"bad":true}\n');
    await assert.rejects(convertDshSession(f.config, source.session, source.state, source.attachments, f.workspace, {}, { dryRun: true }), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'invalid-input');
    await writeFile(source.state, stateHistory);
    await (await import('node:fs/promises')).rm(join(source.attachments, 'objects'), { recursive: true });
    await assert.rejects(convertDshSession(f.config, source.session, source.state, source.attachments, f.workspace, {}, { dryRun: true }), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'missing-data');
    const incomplete = join(f.directory, 'incomplete.jsonl');
    const lines = sessionLog().trimEnd().split('\n');
    lines.splice(lines.length - 1, 1);
    await writeFile(incomplete, `${lines.join('\n')}\n`);
    await assert.rejects(inspectDshLog(incomplete), (error: unknown) => error instanceof DshSessionImportError && error.kind === 'invalid-input');
  } finally { await f.close(); }
});
