import type { HistorySyncInput, HistorySyncRecord, HistorySyncResult } from '@lamplit/contracts';
import { historyPrefix, historySeed, type HistoryIndexEntry, type HistoryIndexInput, type HistoryIndexState } from './store.ts';

/** Only the indexed page and its owning turns are requested from the projection. */
export interface HistorySyncSource {
  state(sessionId: string): Promise<HistoryIndexState | undefined>;
  entries(sessionId: string, after: number, through: number, limit: number, descending?: boolean): Promise<HistoryIndexEntry[]>;
  project(entries: readonly HistoryIndexEntry[]): Promise<Array<{ record: Omit<HistorySyncRecord, 'orderKey'>; stable: string }>>;
}
export class HistoryProjectionMismatch extends Error {}

type Position = { n: number; hash: string };
type Cursor = { v: 1; session: string; history: string; kind: 'older' | 'newer'; position: Position; target?: Position };
const HASH = /^[a-f0-9]{64}$/u;
const MAX_BATCH = 128, SOFT_BYTES = 256 * 1024, MAX_BYTES = 2 * 1024 * 1024 - 8192;

function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decode(value: string): Cursor | undefined {
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) return;
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    const valid = (p: Position | undefined) => !!p && Number.isSafeInteger(p.n) && p.n >= 0 && typeof p.hash === 'string' && HASH.test(p.hash);
    if (cursor.v !== 1 || typeof cursor.session !== 'string' || typeof cursor.history !== 'string' || !['older', 'newer'].includes(cursor.kind) || !valid(cursor.position) || (cursor.target !== undefined && !valid(cursor.target))) return;
    return cursor;
  } catch { return; }
}
export function historyCursor(session: string, history: string, kind: Cursor['kind'], position: Position, target?: Position): string {
  return encode({ v: 1, session, history, kind, position, ...(target ? { target } : {}) });
}

export async function readHistorySync(source: HistorySyncSource, input: HistorySyncInput): Promise<HistorySyncResult> {
  const state = await source.state(input.sessionId);
  if (!state) throw new Error('History index is not ready');
  const session = input.sessionId, history = state.historyId;
  const invalid = (): HistorySyncResult => { if (input.kind === 'start') throw new Error('History index no longer matches its projection'); return { kind: 'resyncRequired', sessionId: session }; };
  const head = { n: state.head, hash: state.prefixHash };
  const seed = historySeed(session, history);
  const lookup = async (position: Position) => {
    if (position.n === 0) return position.hash === seed;
    if (position.n > head.n) return false;
    const [row] = await source.entries(session, position.n - 1, position.n, 1);
    return row?.ordinal === position.n && row.prefixHash === position.hash;
  };
  const stillCurrent = async () => {
    // Projection and page reads are asynchronous. A generation can be replaced
    // between those reads; an ordinary append leaves this captured head intact.
    if (!await lookup(head)) return false;
    const current = await source.state(session);
    return !!current && current.historyId === history && current.head >= head.n
      && (current.head !== head.n || current.prefixHash === head.hash);
  };
  let boundary = head, target = head;
  if (input.kind !== 'start') {
    const cursor = decode(input.kind === 'older' ? input.before : input.after);
    if (!cursor || cursor.kind !== input.kind || cursor.session !== session || cursor.history !== history || !await lookup(cursor.position) || (cursor.target && !await lookup(cursor.target))) return invalid();
    boundary = cursor.position;
    if (input.kind === 'newer') {
      target = cursor.target ?? head;
      if (target.n < boundary.n) return invalid();
    }
  }
  const reverse = input.kind !== 'newer';
  const rows = reverse
    ? await source.entries(session, Math.max(0, boundary.n - MAX_BATCH), boundary.n, MAX_BATCH, true)
    : await source.entries(session, boundary.n, target.n, MAX_BATCH);
  if (rows.length !== Math.min(MAX_BATCH, reverse ? boundary.n : target.n - boundary.n)) throw new HistoryProjectionMismatch('History index has a gap');
  const ordered = reverse ? rows.reverse() : rows;
  const projected = await source.project(ordered);
  if (projected.length !== ordered.length) throw new Error('Incomplete indexed history projection');
  const priorNumber = ordered.length ? ordered[0]!.ordinal - 1 : boundary.n;
  const prior = priorNumber === 0 ? seed : (await source.entries(session, priorNumber - 1, priorNumber, 1))[0]?.prefixHash;
  if (!prior) throw new HistoryProjectionMismatch('History index has a gap');
  let hash = prior;
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]!, value = projected[i]!;
    const item: HistoryIndexInput = { messageId: row.messageId, turnId: row.turnId, stable: value.stable };
    hash = historyPrefix(hash, item);
    if (row.ordinal !== priorNumber + i + 1 || value.record.message.id !== row.messageId || hash !== row.prefixHash) throw new HistoryProjectionMismatch('Indexed history projection changed');
  }
  const candidates = ordered.map((row, i) => ({ ...projected[i]!.record, orderKey: String(row.ordinal).padStart(16, '0') }));
  let count = 0, bytes = 0;
  const indices = reverse ? candidates.map((_, i) => candidates.length - i - 1) : candidates.map((_, i) => i);
  for (const i of indices) {
    const size = Buffer.byteLength(JSON.stringify(candidates[i]));
    if (size > MAX_BYTES) {
      if (count) break;
      throw new Error('History record exceeds frame limit');
    }
    if (count && bytes + size > SOFT_BYTES) break;
    bytes += size; count++;
  }
  const selectedRows = reverse ? ordered.slice(ordered.length - count) : ordered.slice(0, count);
  const records = reverse ? candidates.slice(candidates.length - count) : candidates.slice(0, count);
  if (input.kind === 'newer') {
    const last = selectedRows.at(-1);
    const next = last ? { n: last.ordinal, hash: last.prefixHash } : boundary;
    const hasMore = next.n < target.n;
    if (!await stillCurrent()) return invalid();
    return { kind: 'newer', sessionId: session, historyId: history, records, nextAfter: historyCursor(session, history, 'newer', next, hasMore ? target : undefined), hasMore };
  }
  const first = selectedRows[0];
  const beforeNumber = first ? first.ordinal - 1 : boundary.n;
  const beforeHash = beforeNumber === 0 ? seed : (await source.entries(session, beforeNumber - 1, beforeNumber, 1))[0]?.prefixHash;
  if (!beforeHash) throw new HistoryProjectionMismatch('History index has a gap');
  if (!await stillCurrent()) return invalid();
  const before = beforeNumber ? historyCursor(session, history, 'older', { n: beforeNumber, hash: beforeHash }) : null;
  if (input.kind === 'older') return { kind: 'older', sessionId: session, historyId: history, records, before };
  return { kind: 'start', sessionId: session, historyId: history, records, before, head: historyCursor(session, history, 'newer', head) };
}
