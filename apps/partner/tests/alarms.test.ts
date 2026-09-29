import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeAlarmOccurrence, createAlarm, deleteAlarm, listAlarms, nextAlarmAt } from '../runtime/alarms.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { fixture, eventually } from './fixture.ts';

test('alarm definitions persist with private storage and explicit recurrence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lamplit-alarms-'));
  const path = join(dir, 'alarms.sqlite');
  const now = Date.parse('2026-09-30T00:00:00Z');
  try {
    const once = createAlarm(path, 'check tomorrow', { kind: 'once', at: '2026-10-01T09:00:00+08:00' }, now);
    const daily = createAlarm(path, 'drink tea', { kind: 'daily', hour: 9, minute: 0, timeZone: 'Asia/Taipei' }, now);
    assert.equal(once.nextAt, Date.parse('2026-10-01T01:00:00Z'));
    assert.equal(daily.nextAt, Date.parse('2026-09-30T01:00:00Z'));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(listAlarms(path).map(alarm => alarm.id), [daily.id, once.id]);
    assert.equal(deleteAlarm(path, daily.id), true);
    assert.deepEqual(listAlarms(path).map(alarm => alarm.id), [once.id]);
    assert.throws(() => createAlarm(path, 'past', { kind: 'once', at: '2026-09-29T09:00:00Z' }, now), /future/);
    assert.throws(() => createAlarm(path, 'too frequent', { kind: 'interval', everyMinutes: 1 }, now));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('calendar recurrence respects time zones and a DST gap', () => {
  const weekly = { kind: 'weekly' as const, weekday: 0, hour: 2, minute: 30, timeZone: 'America/New_York' };
  const after = Date.parse('2026-03-08T06:00:00Z');
  // 02:30 on spring-forward Sunday does not exist; the next Sunday is due.
  assert.equal(nextAlarmAt(weekly, after), Date.parse('2026-03-15T06:30:00Z'));
});

test('daily alarm does not fire twice in a fall-back hour', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lamplit-alarm-fold-'));
  const path = join(dir, 'alarms.sqlite');
  try {
    const first = Date.parse('2026-11-01T05:30:00Z');
    const alarm = createAlarm(path, 'morning', { kind: 'daily', hour: 1, minute: 30, timeZone: 'America/New_York' }, first - 30 * 60_000);
    assert.equal(alarm.nextAt, first);
    completeAlarmOccurrence(path, alarm, first + 60_000);
    assert.equal(listAlarms(path)[0]?.nextAt, Date.parse('2026-11-02T06:30:00Z'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one-shot alarm catches up into the one Codex thread with self provenance', async () => {
  const f = await fixture();
  let clock = Date.parse('2026-09-30T00:00:00Z');
  try {
    const alarm = createAlarm(partnerPaths(f.workspace).alarms, 'Remember the picnic', { kind: 'once', at: '2026-09-30T09:00:00+08:00' }, clock);
    clock += 2 * 60 * 60_000;
    const partner = await f.createPartner({ now: () => clock });
    await eventually(async () => (await f.requests()).some(request => request.method === 'turn/start' && JSON.stringify(request.params).includes('Remember the picnic')));
    const starts = (await f.requests()).filter(request => request.method === 'turn/start');
    assert.equal(starts.length, 1);
    const params = starts[0]!.params as { additionalContext: Record<string, { kind: string; value: string }> };
    assert.match(JSON.stringify(starts[0]!.params), /Partner self-set reminder/);
    assert.equal(params.additionalContext['codex-for-love.alarm']?.kind, 'application');
    assert.match(params.additionalContext['codex-for-love.alarm']?.value ?? '', /not a message.*Human/);
    const snapshot = await partner.snapshot();
    const reminder = snapshot.messages.find(message => message.id === `alarm:${alarm.id}:${alarm.nextAt}`);
    assert.equal(reminder?.alarm, true);
    assert.equal(reminder?.input, 'Remember the picnic');
    assert.equal(listAlarms(partnerPaths(f.workspace).alarms).length, 0);
    await partner.checkAlarms();
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 1);
    await partner.close();
    const resumed = await f.createPartner({ now: () => clock });
    const afterRestart = (await resumed.snapshot()).messages.find(message => message.id === `alarm:${alarm.id}:${alarm.nextAt}`);
    assert.equal(afterRestart?.alarm, true);
    assert.equal(afterRestart?.input, 'Remember the picnic');
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 1);
  } finally { await f.close(); }
});

test('a rejected one-shot start retries when Codex becomes available', async () => {
  const f = await fixture();
  const clock = Date.parse('2026-09-30T02:00:00Z');
  try {
    createAlarm(partnerPaths(f.workspace).alarms, 'Try again later', { kind: 'once', at: '2026-09-30T09:00:00+08:00' }, clock - 2 * 60 * 60_000);
    await f.rejectStart(true);
    const partner = await f.createPartner({ now: () => clock });
    await eventually(async () => (await f.requests()).some(request => request.method === 'turn/start'));
    await partner.checkAlarms();
    assert.equal((await partner.snapshot()).draft, undefined);
    await f.rejectStart(false);
    await partner.checkAlarms();
    await eventually(async () => (await partner.snapshot()).results?.some(result => result.answers.length > 0) === true);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 3);
    assert.equal(listAlarms(partnerPaths(f.workspace).alarms).length, 0);
  } finally { await f.close(); }
});

test('an ambiguous one-shot start waits for restart reconciliation and never becomes a Human draft', async () => {
  const f = await fixture();
  const clock = Date.parse('2026-09-30T02:00:00Z');
  f.appServer.env!.FAKE_HOLD_METHOD = 'turn/start';
  f.appServer.requestTimeoutMs = 250;
  let partner: Awaited<ReturnType<typeof f.createPartner>> | undefined;
  try {
    const alarm = createAlarm(partnerPaths(f.workspace).alarms, 'Resume the picnic reminder', { kind: 'once', at: '2026-09-30T09:00:00+08:00' }, clock - 2 * 60 * 60_000);
    partner = await f.createPartner({ now: () => clock });
    await eventually(async () => (await partner!.snapshot()).messages.some(message => message.id === `alarm:${alarm.id}:${alarm.nextAt}` && message.delivery === 'unresolved'));
    assert.equal((await partner.snapshot()).draft, undefined);
    await partner.checkAlarms();
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 1);
    await partner.close();
    f.appServer.env!.FAKE_HOLD_METHOD = '';
    partner = await f.createPartner({ now: () => clock });
    await eventually(async () => (await partner!.snapshot()).results?.some(result => result.sourceIds.includes(`alarm:${alarm.id}:${alarm.nextAt}`) && result.answers.length > 0) === true);
    assert.equal((await partner.snapshot()).draft, undefined);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 2);
    assert.equal(listAlarms(partnerPaths(f.workspace).alarms).length, 0);
  } finally { await f.close(); }
});

test('overdue recurring occurrences are skipped after restart', async () => {
  const f = await fixture();
  let clock = Date.parse('2026-09-30T00:00:00Z');
  try {
    const path = partnerPaths(f.workspace).alarms;
    createAlarm(path, 'Daily note', { kind: 'daily', hour: 9, minute: 0, timeZone: 'Asia/Taipei' }, clock);
    clock += 3 * 24 * 60 * 60_000;
    const partner = await f.createPartner({ now: () => clock });
    await partner.checkAlarms();
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 0);
    assert.equal(listAlarms(path).length, 1);
    assert(listAlarms(path)[0]!.nextAt > clock);
  } finally { await f.close(); }
});
