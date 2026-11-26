import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, historyPrefix, historySeed } from '../runtime/store.ts';

const item = (messageId: string, stable = messageId) => ({ messageId, turnId: 'turn', stable });

test('history index preserves verified prefixes across restart and rotates on changed or removed records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfl-history-store-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  try {
    const empty = await store.reconcileHistoryIndex('s', []);
    assert.equal(empty.prefixHash, historySeed('s', empty.historyId));
    const first = await store.appendHistoryIndex('s', empty, [item('a'), item('b')]);
    assert.equal(first.prefixHash, historyPrefix(historyPrefix(empty.prefixHash, item('a')), item('b')));
    await assert.rejects(store.appendHistoryIndex('s', empty, [item('c')]), /changed during append/);
    await assert.rejects(store.appendHistoryIndex('s', first, [item('c'), item('a')]), /UNIQUE/);
    assert.deepEqual(await store.historyIndexState('s'), first, 'failed batch rolls back');
    await store.close(); store = new Store(path);
    assert.deepEqual(await store.reconcileHistoryIndex('s', [item('a'), item('b'), item('c')]), {
      historyId: first.historyId, head: 3, prefixHash: historyPrefix(first.prefixHash, item('c')),
    });
    assert.deepEqual((await store.historyIndexEntries('s', 0, 3, 2, true)).map(x => x.messageId), ['c', 'b']);
    assert.equal((await store.historyIndexPosition('s', 'b'))?.ordinal, 2);
    const other = await store.reconcileHistoryIndex('other', [item('a')]);
    const changed = await store.reconcileHistoryIndex('s', [item('a'), item('b', 'changed'), item('c')]);
    assert.notEqual(changed.historyId, first.historyId);
    assert.equal((await store.historyIndexState('other'))?.historyId, other.historyId);
    const truncated = await store.reconcileHistoryIndex('s', [item('a')]);
    assert.notEqual(truncated.historyId, changed.historyId);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
