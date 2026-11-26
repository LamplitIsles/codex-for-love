import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';
import { readHistorySync, type HistorySyncSource } from '../runtime/history-sync.ts';

const message = (id: string, text = id) => ({ id, role: 'user' as const, text, createdAt: 1, operationId: id, turnId: 'turn' });

test('indexed history freezes older and newer bounds and verifies continuations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-sync-'));
  const store = new Store(join(directory, 'index.sqlite'));
  const texts = new Map<string, string>(); let maxRead = 0;
  const items = (from: number, count: number, bytes = 0) => Array.from({ length: count }, (_, i) => {
    const messageId = `id-${from + i}`, text = bytes ? 'x'.repeat(bytes) : messageId;
    texts.set(messageId, text); return { messageId, turnId: 'turn', stable: text };
  });
  const source: HistorySyncSource = {
    state: session => store.historyIndexState(session),
    entries: (session, after, through, limit, reverse) => { maxRead = Math.max(maxRead, limit); return store.historyIndexEntries(session, after, through, limit, reverse); },
    project: async rows => rows.map(row => ({ record: { message: message(row.messageId, texts.get(row.messageId)!) }, stable: texts.get(row.messageId)! })),
  };
  try {
    let state = await store.reconcileHistoryIndex('s', items(0, 150));
    const start = await readHistorySync(source, { kind: 'start', sessionId: 's' });
    assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
    assert.equal(start.records.length, 128);
    assert.equal(start.records[0]?.message.id, 'id-22');
    state = await store.appendHistoryIndex('s', state, items(150, 150));
    const old = await readHistorySync(source, { kind: 'older', sessionId: 's', before: start.before! });
    assert.equal(old.kind, 'older'); if (old.kind !== 'older') throw new Error();
    assert.equal(old.records.length, 22); assert.equal(old.before, null);
    assert.deepEqual(await readHistorySync(source, { kind: 'older', sessionId: 's', before: start.before! }), old);
    const newer = await readHistorySync(source, { kind: 'newer', sessionId: 's', after: start.head });
    assert.equal(newer.kind, 'newer'); if (newer.kind !== 'newer') throw new Error();
    assert.equal(newer.records.length, 128); assert.equal(newer.hasMore, true);
    state = await store.appendHistoryIndex('s', state, items(300, 5));
    const rest = await readHistorySync(source, { kind: 'newer', sessionId: 's', after: newer.nextAfter });
    assert.equal(rest.kind, 'newer'); if (rest.kind !== 'newer') throw new Error();
    assert.equal(rest.records.length, 22); assert.equal(rest.hasMore, false);
    assert.equal(rest.records.at(-1)?.message.id, 'id-299');
    const later = await readHistorySync(source, { kind: 'newer', sessionId: 's', after: rest.nextAfter });
    assert.equal(later.kind, 'newer'); if (later.kind !== 'newer') throw new Error();
    assert.equal(later.records.length, 5);
    assert.equal(maxRead, 128);
    texts.set('id-299', 'modified');
    await assert.rejects(readHistorySync(source, { kind: 'newer', sessionId: 's', after: newer.nextAfter }), /projection changed/);
    assert.deepEqual(await readHistorySync(source, { kind: 'newer', sessionId: 'other', after: rest.nextAfter }).catch(() => 'missing'), 'missing');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('byte limits advance only past records actually returned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-sync-bytes-'));
  const store = new Store(join(directory, 'index.sqlite'));
  const texts = new Map([['small', 's'], ['large', 'x'.repeat(300_000)], ['huge', 'h'.repeat(2_100_000)]]);
  const source: HistorySyncSource = {
    state: session => store.historyIndexState(session),
    entries: (session, after, through, limit, reverse) => store.historyIndexEntries(session, after, through, limit, reverse),
    project: async rows => rows.map(row => ({ record: { message: message(row.messageId, texts.get(row.messageId)!) }, stable: texts.get(row.messageId)! })),
  };
  try {
    const initial = await store.reconcileHistoryIndex('s', []);
    const empty = await readHistorySync(source, { kind: 'start', sessionId: 's' });
    assert.equal(empty.kind, 'start'); if (empty.kind !== 'start') throw new Error();
    await store.appendHistoryIndex('s', initial, [...texts].map(([messageId, stable]) => ({ messageId, turnId: 'turn', stable })));
    const first = await readHistorySync(source, { kind: 'newer', sessionId: 's', after: empty.head });
    assert.equal(first.kind, 'newer'); if (first.kind !== 'newer') throw new Error();
    assert.deepEqual(first.records.map(row => row.message.id), ['small']); assert.equal(first.hasMore, true);
    const second = await readHistorySync(source, { kind: 'newer', sessionId: 's', after: first.nextAfter });
    assert.equal(second.kind, 'newer'); if (second.kind !== 'newer') throw new Error();
    assert.deepEqual(second.records.map(row => row.message.id), ['large']); assert.equal(second.hasMore, true);
    await assert.rejects(readHistorySync(source, { kind: 'newer', sessionId: 's', after: second.nextAfter }), /exceeds frame/);
    await assert.rejects(readHistorySync(source, { kind: 'newer', sessionId: 's', after: second.nextAfter }), /exceeds frame/);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a restored index with a divergent tail rejects the old head while retaining a shared prefix', async () => {
  const { copyFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'cfl-sync-restore-'));
  const path = join(directory, 'index.sqlite'), backup = join(directory, 'backup.sqlite');
  let store = new Store(path);
  const values = new Map([['one', 'one'], ['old', 'old'], ['new', 'new']]);
  const source: HistorySyncSource = {
    state: session => store.historyIndexState(session),
    entries: (session, after, through, limit, reverse) => store.historyIndexEntries(session, after, through, limit, reverse),
    project: async rows => rows.map(row => ({ record: { message: message(row.messageId, values.get(row.messageId)!) }, stable: values.get(row.messageId)! })),
  };
  const input = (messageId: string) => ({ messageId, turnId: 'turn', stable: values.get(messageId)! });
  try {
    const prefix = await store.reconcileHistoryIndex('s', [input('one')]);
    const before = await readHistorySync(source, { kind: 'start', sessionId: 's' });
    assert.equal(before.kind, 'start'); if (before.kind !== 'start') throw new Error();
    await store.close(); await copyFile(path, backup);
    store = new Store(path); await store.appendHistoryIndex('s', prefix, [input('old')]);
    const old = await readHistorySync(source, { kind: 'start', sessionId: 's' });
    assert.equal(old.kind, 'start'); if (old.kind !== 'start') throw new Error();
    await store.close(); await copyFile(backup, path);
    store = new Store(path); await store.appendHistoryIndex('s', prefix, [input('new')]);
    assert.deepEqual(await readHistorySync(source, { kind: 'newer', sessionId: 's', after: old.head }), { kind: 'resyncRequired', sessionId: 's' });
    const resumed = await readHistorySync(source, { kind: 'newer', sessionId: 's', after: before.head });
    assert.equal(resumed.kind, 'newer'); if (resumed.kind !== 'newer') throw new Error();
    assert.deepEqual(resumed.records.map(row => row.message.id), ['new']);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('large history selects only the bounded page and its associated projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-sync-large-'));
  const store = new Store(join(directory, 'index.sqlite')); let projected = 0, maxRows = 0;
  const source: HistorySyncSource = {
    state: session => store.historyIndexState(session),
    entries: (session, after, through, limit, reverse) => store.historyIndexEntries(session, after, through, limit, reverse),
    project: async rows => { projected += rows.length; maxRows = Math.max(maxRows, rows.length); return rows.map(row => ({ record: { message: message(row.messageId) }, stable: row.messageId })); },
  };
  try {
    await store.reconcileHistoryIndex('s', Array.from({ length: 5000 }, (_, i) => ({ messageId: `message-${i}`, turnId: `turn-${Math.floor(i / 2)}`, stable: `message-${i}` })));
    const start = await readHistorySync(source, { kind: 'start', sessionId: 's' });
    assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
    assert.equal(projected, 128); assert.equal(maxRows, 128);
    const older = await readHistorySync(source, { kind: 'older', sessionId: 's', before: start.before! });
    assert.equal(older.kind, 'older'); if (older.kind !== 'older') throw new Error();
    assert.equal(projected, 256); assert.equal(older.records.length, 128);
    assert.equal(older.records.at(-1)?.message.id, 'message-4871');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('generation replacement during an older page never combines generations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-sync-generation-race-'));
  const store = new Store(join(directory, 'index.sqlite'));
  const items = Array.from({ length: 400 }, (_, i) => ({ messageId: `id-${i}`, turnId: 'turn', stable: `id-${i}` }));
  const values = new Map(items.map(item => [item.messageId, item.stable]));
  let armed = false, boundaryReads = 0;
  const source: HistorySyncSource = {
    state: session => store.historyIndexState(session),
    async entries(session, after, through, limit, reverse) {
      if (armed && after === 143 && through === 144 && ++boundaryReads === 2) {
        values.set('id-0', 'changed');
        await store.reconcileHistoryIndex('s', items.map(item => ({ ...item, stable: values.get(item.messageId)! })));
      }
      return store.historyIndexEntries(session, after, through, limit, reverse);
    },
    project: async rows => rows.map(row => ({ record: { message: message(row.messageId, values.get(row.messageId)!) }, stable: values.get(row.messageId)! })),
  };
  try {
    await store.reconcileHistoryIndex('s', items);
    const start = await readHistorySync(source, { kind: 'start', sessionId: 's' });
    assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
    armed = true;
    const older = await readHistorySync(source, { kind: 'older', sessionId: 's', before: start.before! });
    assert.equal(boundaryReads, 2);
    assert.deepEqual(older, { kind: 'resyncRequired', sessionId: 's' });
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an append during projection preserves the captured start boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-sync-append-race-'));
  const store = new Store(join(directory, 'index.sqlite'));
  const items = Array.from({ length: 150 }, (_, i) => ({ messageId: `id-${i}`, turnId: 'turn', stable: `id-${i}` }));
  const values = new Map(items.map(item => [item.messageId, item.stable]));
  let appended = false;
  const source: HistorySyncSource = {
    state: session => store.historyIndexState(session),
    entries: (session, after, through, limit, reverse) => store.historyIndexEntries(session, after, through, limit, reverse),
    async project(rows) {
      const result = rows.map(row => ({ record: { message: message(row.messageId, values.get(row.messageId)!) }, stable: values.get(row.messageId)! }));
      if (!appended) {
        appended = true; values.set('new', 'new');
        await store.appendHistoryIndex('s', (await store.historyIndexState('s'))!, [{ messageId: 'new', turnId: 'later', stable: 'new' }]);
      }
      return result;
    },
  };
  try {
    await store.reconcileHistoryIndex('s', items);
    const start = await readHistorySync(source, { kind: 'start', sessionId: 's' });
    assert.equal(start.kind, 'start'); if (start.kind !== 'start') throw new Error();
    assert.equal(start.records.at(-1)?.message.id, 'id-149');
    const newer = await readHistorySync(source, { kind: 'newer', sessionId: 's', after: start.head });
    assert.equal(newer.kind, 'newer'); if (newer.kind !== 'newer') throw new Error();
    assert.deepEqual(newer.records.map(row => row.message.id), ['new']);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
