import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConversationSearch } from '../runtime/conversation-search.ts';
import { createWebServer } from '../runtime/server.ts';
import { contextTargetIndex, snippetParts, textParts } from '../src/lib/companion/client/conversation-search-highlight.ts';
import { fixture } from './fixture.ts';

test('search highlights keep non-mark markup as plain text', () => {
  assert.deepEqual(snippetParts('before <mark>match</mark> <img src=x>'), [
    { text: 'before ', matched: false },
    { text: 'match', matched: true },
    { text: ' <img src=x>', matched: false },
  ]);
  assert.deepEqual(textParts('A sunset, another sunset.', 'sunset'), [
    { text: 'A ', matched: false },
    { text: 'sunset', matched: true },
    { text: ', another ', matched: false },
    { text: 'sunset', matched: true },
    { text: '.', matched: false },
  ]);
});

test('a repeated message is identified by source record rather than matching text', () => {
  const items = [
    { sourceRecordIndex: 7, kind: 'message', role: 'user', content: 'same text' },
    { sourceRecordIndex: 8, kind: 'message', role: 'user', content: 'same text' },
  ];
  assert.equal(contextTargetIndex(8, items), 1);
});

test('conversation search uses the Partner workspace and expands only its records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-search-test-'));
  const workspace = join(root, 'workspace');
  const calls = join(root, 'calls.jsonl');
  const binary = join(root, 'flicklog-fake');
  const credentials = join(root, 'credentials');
  const id = 'a'.repeat(64);
  await mkdir(workspace);
  await mkdir(credentials);
  await writeFile(join(credentials, 'flicklog-meili-key'), 'test-owned-key');
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FLICKLOG_TEST_LOG, JSON.stringify({ cwd: process.cwd(), home: process.env.CODEX_HOME, key: process.env.FLICKLOG_MEILI_KEY, args: process.argv.slice(2) }) + '\\n');
const [command, value] = process.argv.slice(2);
const cwd = value === '${'b'.repeat(64)}' ? '/outside' : process.cwd();
console.log(JSON.stringify(command === 'search'
  ? { sync: {}, results: { query: value, estimatedTotalHits: 1, hits: [{ id: '${id}', kind: 'message', sessionId: 'thread', cwd, role: 'user', snippet: 'a <mark>match</mark> <img src=x>' }] } }
  : command === 'get'
    ? { id: value, kind: 'message', sessionId: 'thread', cwd, role: 'user', content: 'full message' }
    : { messageId: value, targetSourceRecordIndex: 2, truncated: false, items: [{ sourceRecordIndex: 2, kind: 'message', role: 'user', content: 'full message' }] }));
`);
  await chmod(binary, 0o755);
  const search = createConversationSearch({ workspace, codexHome: join(root, 'codex'), env: { FLICKLOG_BIN: binary, PATH: root, FLICKLOG_TEST_LOG: calls, FLICKLOG_MEILI_KEY: '', CREDENTIALS_DIRECTORY: credentials } });
  try {
    const found = await search.search('match; echo unsafe', 12);
    assert.equal(found.hits[0]?.snippet, 'a <mark>match</mark> <img src=x>');
    const expanded = await search.read(id);
    assert.equal(expanded.record.content, 'full message');
    assert.equal(expanded.context.targetSourceRecordIndex, 2);
    assert.equal(expanded.context.items.length, 1);
    await assert.rejects(search.read('b'.repeat(64)), /outside this workspace/u);
    const observed = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { cwd: string; home: string; key: string; args: string[] });
    assert.deepEqual(observed.map(({ args }) => args), [
      ['search', 'match; echo unsafe', '--limit', '12'], ['get', id], ['context', id], ['get', 'b'.repeat(64)],
    ]);
    assert.equal(observed.every(({ cwd, home }) => cwd === workspace && home === join(root, 'codex')), true);
    assert.equal(observed.every(({ key }) => key === 'test-owned-key'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable optional FlickLog credential fails search without blocking construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-search-test-'));
  const workspace = join(root, 'workspace');
  const credentials = join(root, 'credentials');
  await mkdir(workspace);
  await mkdir(join(credentials, 'flicklog-meili-key'), { recursive: true });
  try {
    const search = createConversationSearch({ workspace, env: { FLICKLOG_MEILI_KEY: '', CREDENTIALS_DIRECTORY: credentials } });
    await assert.rejects(search.search('match'), { code: 'EISDIR' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('conversation search HTTP exposes bounded results and selected context', async () => {
  const f = await fixture();
  const partner = await f.createPartner();
  const id = 'a'.repeat(64);
  const search = {
    search: async (query: string) => ({ query, estimatedTotalHits: 1, hits: [{ id, kind: 'message' as const, sessionId: 'thread', cwd: f.workspace, role: 'user' as const, snippet: '<mark>match</mark>' }] }),
    read: async () => ({ record: { id, kind: 'message' as const, sessionId: 'thread', cwd: f.workspace, content: 'full' }, context: { messageId: id, targetSourceRecordIndex: 2, truncated: false, items: [] } }),
  };
  const app = createWebServer(partner, join(f.directory, 'assets'), { conversationSearch: search });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const result = await (await fetch(`${base}/api/conversation-search?q=match`)).json() as { hits: Array<{ snippet: string }> };
    assert.equal(result.hits[0]?.snippet, '<mark>match</mark>');
    const detail = await (await fetch(`${base}/api/conversation-search/${id}`)).json() as { record: { content: string } };
    assert.equal(detail.record.content, 'full');
    assert.equal((await fetch(`${base}/api/conversation-search?q=`)).status, 400);
    assert.equal((await fetch(`${base}/api/conversation-search/not-an-id`)).status, 400);
  } finally { await app.close(); await f.close(); }
});
