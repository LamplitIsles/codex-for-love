import type { HistorySyncInput, HistorySyncResult } from '@lamplit/contracts';

type Sync = { historySync(input: HistorySyncInput): Promise<HistorySyncResult> };
export async function olderMessages(client: Sync, before: string, sessionId = 'thread-fake') {
  const result = await client.historySync({ kind: 'older', sessionId, before });
  if (result.kind !== 'older') throw new Error(`Expected older, got ${result.kind}`);
  return { messages: result.records.map(record => record.message), before: result.before };
}
export async function startMessages(client: Sync) {
  const result = await client.historySync({ kind: 'start', sessionId: 'thread-fake' });
  if (result.kind !== 'start') throw new Error(`Expected start, got ${result.kind}`);
  return { messages: result.records.map(record => record.message), before: result.before };
}
