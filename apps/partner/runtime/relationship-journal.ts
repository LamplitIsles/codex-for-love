import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalizeChangeReason, canonicalizeMood, canonicalizeSignature, clampAffinity, type CompanionState, type CompanionStateRecord, type RelationshipUpdate } from '../src/lib/companion/domain.ts';

export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export const MAX_JOURNAL_RECORD_BYTES = 4 * 1024;
const initial: CompanionState = { mood: 'neutral', affinity: 50, signature: '' };

function validateRecord(value: unknown, previous: CompanionState = initial): CompanionStateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Relationship journal record is invalid');
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) throw new TypeError('Relationship journal timestamp is invalid');
  if (!record.state || typeof record.state !== 'object' || Array.isArray(record.state)) throw new TypeError('Relationship journal state is invalid');
  const stateValue = record.state as Record<string, unknown>;
  const mood = canonicalizeMood({ mood: stateValue.mood, ...(stateValue.note === undefined ? {} : { note: stateValue.note }) });
  if (typeof stateValue.affinity !== 'number' || !Number.isSafeInteger(stateValue.affinity) || stateValue.affinity < 0 || stateValue.affinity > 100) throw new TypeError('Relationship journal affinity is invalid');
  const signature = canonicalizeSignature(stateValue.signature);
  if (!record.changes || typeof record.changes !== 'object' || Array.isArray(record.changes)) throw new TypeError('Relationship journal changes are invalid');
  const changes = record.changes as Record<string, unknown>;
  if (Object.keys(changes).some((key) => !['seed', 'mood', 'affinity', 'signature'].includes(key))) throw new TypeError('Relationship journal changes contain unknown fields');
  if (changes.seed !== undefined && changes.seed !== true) throw new TypeError('Relationship journal seed is invalid');
  if (changes.mood !== undefined) {
    if (!changes.mood || typeof changes.mood !== 'object' || Array.isArray(changes.mood)) throw new TypeError('Relationship journal mood change is invalid');
    const change = changes.mood as Record<string, unknown>;
    if (Object.keys(change).some((key) => !['value', 'note', 'reason'].includes(key))) throw new TypeError('Relationship journal mood change is invalid');
    const changedMood = canonicalizeMood({ mood: change.value, ...(change.note === undefined ? {} : { note: change.note }) });
    if (change.reason !== undefined) canonicalizeChangeReason(change.reason);
    if (changedMood.mood !== mood.mood || changedMood.note !== mood.note) throw new TypeError('Relationship journal mood does not match state');
  }
  if (changes.affinity) {
    if (typeof changes.affinity !== 'object' || Array.isArray(changes.affinity)) throw new TypeError('Relationship journal affinity change is invalid');
    const change = changes.affinity as Record<string, unknown>;
    if (Object.keys(change).some((key) => !['value', 'delta', 'reason'].includes(key)) || !Number.isSafeInteger(change.value) || !Number.isSafeInteger(change.delta) || change.value !== stateValue.affinity || change.value < 0 || change.value > 100 || change.delta !== stateValue.affinity - previous.affinity) throw new TypeError('Relationship journal affinity change is invalid');
    if (change.reason !== undefined) canonicalizeChangeReason(change.reason);
  }
  if (changes.signature !== undefined) {
    if (!changes.signature || typeof changes.signature !== 'object' || Array.isArray(changes.signature)) throw new TypeError('Relationship journal signature change is invalid');
    const change = changes.signature as Record<string, unknown>;
    if (Object.keys(change).some((key) => !['value', 'reason'].includes(key)) || canonicalizeSignature(change.value) !== signature) throw new TypeError('Relationship journal signature change is invalid');
    if (change.reason !== undefined) canonicalizeChangeReason(change.reason);
  }
  return { at: record.at, changes: changes as CompanionStateRecord['changes'], state: { ...mood, affinity: stateValue.affinity as number, signature } };
}

async function acquireJournalLock(path: string): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempts = 0; attempts < 2_000; attempts += 1) {
    try { await mkdir(lock, { mode: 0o700 }); return async () => { await rmdir(lock).catch(() => undefined); }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Relationship Journal lock is held at ${lock}; recover the stale lock explicitly before retrying`);
}

/** Read the complete bounded append-only journal in chronological order. */
export async function readRelationshipJournal(path: string): Promise<CompanionStateRecord[]> {
  let data: string;
  try { data = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (Buffer.byteLength(data) > MAX_JOURNAL_BYTES) throw new TypeError('Relationship journal exceeds 4 MiB');
  if (!data) return [];
  let previous = initial;
  return data.split('\n').filter(Boolean).map((line) => {
    if (Buffer.byteLength(line) > MAX_JOURNAL_RECORD_BYTES) throw new TypeError('Relationship journal record exceeds 4 KiB');
    const record = validateRecord(JSON.parse(line), previous); previous = record.state; return record;
  });
}

export async function replaceRelationshipJournal(path: string, records: readonly CompanionStateRecord[]): Promise<void> {
  let previous = initial;
  const text = records.map((record) => { const validated = validateRecord(record, previous); previous = validated.state; return JSON.stringify(validated); }).join('\n') + (records.length ? '\n' : '');
  if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES || text.split('\n').some((line) => Buffer.byteLength(line) > MAX_JOURNAL_RECORD_BYTES)) throw new TypeError('Relationship journal exceeds its bounds');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => undefined); }
}

export async function updateRelationshipJournal(path: string, update: RelationshipUpdate & { signature?: { value: string; reason: string } }): Promise<CompanionState> {
  const release = await acquireJournalLock(path);
  try {
  const records = await readRelationshipJournal(path);
  const previous = records.at(-1)?.state ?? initial;
  const state: CompanionState = { ...previous };
  const changes: CompanionStateRecord['changes'] = {};
  if (update.mood) { state.mood = update.mood.value; state.note = update.mood.note; changes.mood = update.mood; }
  if (update.affinity) { state.affinity = clampAffinity(previous.affinity + update.affinity.delta); changes.affinity = { value: state.affinity, delta: state.affinity - previous.affinity, reason: update.affinity.reason }; }
  if (update.signature) { state.signature = update.signature.value; changes.signature = update.signature; }
  records.push({ at: new Date().toISOString(), changes, state });
  await replaceRelationshipJournal(path, records);
  return state;
  } finally { await release(); }
}
