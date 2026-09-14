import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../runtime/store.ts';
import { createWebServer } from '../runtime/server.ts';
import { mergeMessages, mergeResults } from '../src/lib/message-pages.ts';
import { fixture, eventually } from './fixture.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { visibleHistoryPage } from '../runtime/partner.ts';

test('history windows count visible user and Partner contributions like DSH', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ id: `message-${index + 1}`, sequence: index + 1, revision: index + 1, created: index + 1 }));
  const results = messages.map((message) => ({ turnId: `turn-${message.id}`, sourceIds: [message.id], sequence: message.sequence, revision: message.revision, answers: Array.from({ length: message.sequence % 6 === 0 ? 4 : 1 }, () => 'reply'), error: null, status: 'completed', generatedIds: [] }));
  const page = visibleHistoryPage(messages, results);
  const visible = page.messages.reduce((count, message) => count + 1 + results.find((result) => result.sourceIds.at(-1) === message.id)!.answers.length, 0);
  assert.equal(visible, 50);
  assert.equal(page.messages[0]?.id, 'message-12');
  assert.equal(page.messages.at(-1)?.id, 'message-30');
  assert.equal(page.hasMore, true);
  assert.equal(page.before, page.messages[0]?.sequence);
});

test('history pages and bounded change batches retain stable ordering and restart cursors', async () => {
  const f = await fixture();
  const paths = partnerPaths(join(f.directory, 'workspace'));
  await mkdir(paths.managedRoot, { recursive: true });
  let store = new Store(paths.database);
  const ids = Array.from({ length: 65 }, () => randomUUID());
  try {
    for (const [index, id] of ids.entries()) {
      await store.admit(id, `message ${index}`);
      await store.markObserved(id);
      await store.markObserved(id);
    }
    const recent = await store.messagePage();
    assert.deepEqual(recent.messages.map((message) => message.id), ids.slice(35));
    assert.equal(recent.hasMore, true);
    const previous = await store.messagePage({ before: recent.before! });
    assert.deepEqual(previous.messages.map((message) => message.id), ids.slice(5, 35));
    const first = await store.messagePage({ before: previous.before! });
    assert.deepEqual(first.messages.map((message) => message.id), ids.slice(0, 5));
    assert.equal((await store.messagePage({ after: recent.cursor })).messages.length, 0);
    // The updated message is in the older page, so model a late older-page
    // response arriving after a newer revision was requested.
    const oldRevision = previous.messages.find((message) => message.id === ids[5])!.revision;
    await store.touchMessage(ids[5]);
    const changed = await store.messagePage({ after: recent.cursor });
    assert.equal(changed.messages.length, 1);
    assert(changed.messages[0]!.revision > oldRevision);
    const merged = mergeMessages(mergeMessages(recent.messages, changed.messages), previous.messages);
    assert.equal(merged.find((message) => message.id === ids[5])!.revision, changed.messages[0]!.revision);
    assert.equal(new Set(merged.map((message) => message.id)).size, merged.length);
    await store.close(); store = new Store(paths.database);
    assert.equal((await store.messagePage({ after: changed.cursor })).messages.length, 0);
    for (const id of ids) await store.touchMessage(id);
    let cursor = changed.cursor; const seen = new Set<string>(); let batches = 0;
    for (;;) {
      const batch = await store.messagePage({ after: cursor }); batches++;
      assert(batch.messages.length <= 30); assert(batch.cursor > cursor);
      batch.messages.forEach((message) => { assert(!seen.has(message.id)); seen.add(message.id); });
      cursor = batch.cursor;
      if (!batch.hasChangesMore) break;
    }
    assert.equal(batches, 3); assert.equal(seen.size, 65);
    await assert.rejects(store.messagePage({ after: cursor + 1 }), /ahead/);
  } finally { await store.close(); await f.close(); }
});

test('revisioned replacements and canonical results reject stale responses', () => {
  type TestMessage = { id: string; sequence: number; revision: number; delivery: 'unresolved' | 'replaced' };
  const pending: TestMessage = { id: 'draft', sequence: 4, revision: 10, delivery: 'unresolved' };
  const replaced: TestMessage = { ...pending, revision: 11, delivery: 'replaced' };
  const stalePage = { ...pending, revision: 10 };
  const afterReplacement = mergeMessages([pending], [replaced]);
  const reconciled = mergeMessages(afterReplacement, [stalePage]);
  assert.equal(reconciled.find((message) => message.id === pending.id)?.delivery, 'replaced');

  const olderResult = { id: 'turn:one', sequence: 4, revision: 20, status: 'interrupted' };
  const newerResult = { ...olderResult, revision: 21, status: 'completed' };
  const laterResult = { id: 'turn:two', sequence: 8, revision: 22, status: 'completed' };
  const results = mergeResults([newerResult], [olderResult, laterResult]);
  assert.deepEqual(results.map((result) => result.id), ['turn:one', 'turn:two']);
  assert.equal(results[0]?.status, 'completed');
  assert.equal(results[0]?.revision, 21);
});

test('HTTP refresh returns native turn, steering and turn-level interruption changes', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/session`;
  try {
    const initial = await (await fetch(url)).json() as { cursor: number };
    await f.holdProvider(true);
    const first = randomUUID(); const steering = randomUUID();
    await partner.submit(first, 'one');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(steering, 'two');
    const pending = await (await fetch(`${url}?after=${initial.cursor}`)).json() as { cursor: number; messages: { id: string; delivery: string }[]; cancellable: string[] };
    assert.equal(pending.messages.length, 2); assert.equal(pending.cancellable.length, 1); assert.match(pending.cancellable[0]!, /^turn-/);
    await partner.cancel(pending.cancellable[0]!);
    const cancelled = await (await fetch(`${url}?after=${pending.cursor}`)).json() as { cursor: number; messages: { id: string; delivery: string }[]; results: { status: string; sourceIds: string[] }[] };
    assert(cancelled.messages.some((message) => message.id === steering && message.delivery === 'acknowledged'));
    assert(cancelled.results.some((result) => result.status === 'interrupted' && result.sourceIds.includes(steering)));
    await f.holdProvider(false);
    await eventually(async () => !(await partner.snapshot()).typing);
    const completedId = randomUUID(); await partner.submit(completedId, 'completed');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(completedId) && result.answers.length > 0) === true);
    const complete = await (await fetch(`${url}?after=${cancelled.cursor}`)).json() as { cursor: number; results: { answers: string[] }[] };
    assert(complete.results.some((result) => result.answers.length > 0));
    const unchanged = await (await fetch(`${url}?after=${complete.cursor}`)).json() as { messages: unknown[] };
    assert.deepEqual(unchanged.messages, []);
    assert.equal((await fetch(`${url}?before=1&after=1`)).status, 400);
    assert.equal((await fetch(`${url}?before=-1`)).status, 400);
    assert.equal((await fetch(`${url}?after=1.5`)).status, 400);
  } finally { await app.close(); await f.close(); }
});
