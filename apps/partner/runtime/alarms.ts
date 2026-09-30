import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const clock = z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), timeZone: z.string().min(1).max(100) }).strict();
export const alarmScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal('interval'), everyMinutes: z.number().int().min(5).max(525600) }).strict(),
  clock.extend({ kind: z.literal('daily') }),
  clock.extend({ kind: z.literal('weekly'), weekday: z.number().int().min(0).max(6) }),
]);
export const alarmMessageSchema = z.string().trim().min(1).max(2000);
export type AlarmSchedule = z.infer<typeof alarmScheduleSchema>;
export type Alarm = { id: string; message: string; schedule: AlarmSchedule; nextAt: number; createdAt: number };

type Row = { id: string; message: string; schedule: string; next_at: number; created_at: number };
function mapRow(row: Row): Alarm { return { id: row.id, message: row.message, schedule: alarmScheduleSchema.parse(JSON.parse(row.schedule)), nextAt: row.next_at, createdAt: row.created_at }; }
function database(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS alarms (id TEXT PRIMARY KEY, message TEXT NOT NULL, schedule TEXT NOT NULL, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS alarms_due ON alarms(next_at)');
  return db;
}
function localParts(at: number, timeZone: string): { hour: number; minute: number; weekday: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (kind: string) => parts.find(part => part.type === kind)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { hour: Number(get('hour')), minute: Number(get('minute')), weekday, date: `${get('year')}-${get('month')}-${get('day')}` };
}
/** The first matching wall-clock minute strictly after `after`; earliest instant wins at a DST fold. */
export function nextAlarmAt(schedule: AlarmSchedule, after: number, previousDate?: string): number {
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at);
    if (!Number.isFinite(at) || at <= after) throw new Error('Alarm date must be in the future');
    return at;
  }
  if (schedule.kind === 'interval') return after + schedule.everyMinutes * 60_000;
  new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone });
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 15 * 24 * 60; minute++, candidate += 60_000) {
    const parts = localParts(candidate, schedule.timeZone);
    if (parts.date !== previousDate && parts.hour === schedule.hour && parts.minute === schedule.minute && (schedule.kind === 'daily' || parts.weekday === schedule.weekday)) return candidate;
  }
  throw new Error('No next alarm time in the chosen time zone');
}
export function createAlarm(path: string, messageValue: unknown, scheduleValue: unknown, now = Date.now()): Alarm {
  const message = alarmMessageSchema.parse(messageValue);
  const schedule = alarmScheduleSchema.parse(scheduleValue);
  const nextAt = nextAlarmAt(schedule, now);
  const alarm: Alarm = { id: randomUUID(), message, schedule, nextAt, createdAt: now };
  const db = database(path);
  try {
    if ((db.prepare('SELECT COUNT(*) AS count FROM alarms').get() as { count: number }).count >= 100) throw new Error('Alarm limit reached');
    db.prepare('INSERT INTO alarms(id,message,schedule,next_at,created_at) VALUES(?,?,?,?,?)').run(alarm.id, message, JSON.stringify(schedule), nextAt, now);
    return alarm;
  } finally { db.close(); }
}
export function listAlarms(path: string): Alarm[] {
  const db = database(path);
  try { return (db.prepare('SELECT * FROM alarms ORDER BY next_at,id').all() as Row[]).map(mapRow); }
  finally { db.close(); }
}
export function editAlarm(path: string, id: string, messageValue: unknown): Alarm | undefined {
  const message = alarmMessageSchema.parse(messageValue);
  const db = database(path);
  try {
    const row = db.prepare('UPDATE alarms SET message=? WHERE id=? RETURNING *').get(message, id) as Row | undefined;
    return row ? mapRow(row) : undefined;
  } finally { db.close(); }
}
export function deleteAlarm(path: string, id: string): boolean {
  const db = database(path);
  try { return db.prepare('DELETE FROM alarms WHERE id=?').run(id).changes > 0; }
  finally { db.close(); }
}
export function dueAlarms(path: string, now = Date.now()): Alarm[] { return listAlarms(path).filter(alarm => alarm.nextAt <= now); }
export function completeAlarmOccurrence(path: string, alarm: Alarm, now = Date.now()): void {
  const db = database(path);
  try {
    if (alarm.schedule.kind === 'once') db.prepare('DELETE FROM alarms WHERE id=? AND next_at=?').run(alarm.id, alarm.nextAt);
    else db.prepare('UPDATE alarms SET next_at=? WHERE id=? AND next_at=?').run(nextAlarmAt(alarm.schedule, now, alarm.schedule.kind === 'interval' ? undefined : localParts(alarm.nextAt, alarm.schedule.timeZone).date), alarm.id, alarm.nextAt);
  } finally { db.close(); }
}
