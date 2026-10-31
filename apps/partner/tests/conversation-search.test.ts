import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { seedConversationSearch } from './conversation-search-seed.ts';
import { fixture } from './fixture.ts';

test('Rust top-level UUID/snake_case/null and structured snippet map to domain; invalid public inputs never invoke CLI', async () => {
  const f = await fixture();
  try {
    const s = await seedConversationSearch(f.directory, f.workspace, f.config.codex.home!);
    const data = JSON.parse(await readFile(s.data, 'utf8'));
    data.records[0].session_name = null; data.records[0].created_at = null;
    await writeFile(s.data, JSON.stringify(data));
    const result = await s.search.search('灯塔', 12);
    assert.equal(result.hits.length, 12); assert.equal(result.estimatedTotalHits, 23);
    assert.deepEqual(result.hits[0]!.snippet.segments[0], { text: '灯塔', highlighted: true });
    assert.equal('sessionName' in result.hits[0]!, false); assert.equal('createdAt' in result.hits[0]!, false);
    assert.equal('user_id' in result.hits[0]!, false); assert.equal('device_id' in result.hits[0]!, false);
    const read = await s.search.read(s.recordIds.original);
    assert.equal(read.record.content, data.records[0].content);
    assert.equal(read.context.targetSourceRecordIndex, 10);
    const before = await readFile(s.log, 'utf8');
    for (const id of ['a'.repeat(64), '--all-projects', 'x; echo unsafe']) await assert.rejects(s.search.read(id));
    for (const limit of [0,21,1.5,Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(s.search.search('match', limit));
    await assert.rejects(s.search.search(' ')); await assert.rejects(s.search.search('x'.repeat(501)));
    assert.equal(await readFile(s.log, 'utf8'), before);
    const calls = before.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(c => c.args), [['search','灯塔','--limit','12'], ['get',s.recordIds.original], ['context',s.recordIds.original]]);
    const workspace = await realpath(f.workspace);
    assert.ok(calls.every(c => c.cwd === workspace));
  } finally { await f.close(); }
});

test('Rust context DTO enforces public target, order, safe ordinals, window and Unicode budget', async () => {
  const f = await fixture();
  try {
    const s = await seedConversationSearch(f.directory, f.workspace, f.config.codex.home!);
    const original = JSON.parse(await readFile(s.data, 'utf8'));
    for (const change of [
      (d: any) => { d.records[0].source_ordinal = -1; },
      (d: any) => { d.records[0].source_ordinal = Number.MAX_SAFE_INTEGER + 1; },
      (d: any) => { d.paths[s.recordIds.original][1].content = 'wrong target'; },
      (d: any) => { d.paths[s.recordIds.original][1].role = 'assistant'; },
      (d: any) => { d.paths[s.recordIds.original][2].source_ordinal = 9; },
      (d: any) => { d.paths[s.recordIds.original].splice(1,1); },
      (d: any) => { d.records[0].id = crypto.randomUUID(); },
    ]) {
      const data = structuredClone(original); change(data); await writeFile(s.data, JSON.stringify(data));
      await assert.rejects(s.search.read(s.recordIds.original));
    }
    await writeFile(s.data, JSON.stringify(original));
    assert.equal((await s.search.read(s.recordIds.original)).record.id, s.recordIds.original);
  } finally { await f.close(); }
});
