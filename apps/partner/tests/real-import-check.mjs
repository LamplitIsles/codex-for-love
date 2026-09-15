import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertDshSession } from '../runtime/dsh-session-import.ts';

function sourceLog() {
  const events = [];
  const add = (type, data, extra = {}) => events.push({ type, seq: events.length, time: 1_780_000_000_000 + events.length, data, ...extra });
  const turn = (number, user, assistant) => {
    add('turn/start', { turn: number });
    add('user/message', { id: `u${number}`, role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    add('assistant/message', { turn: number, message: { id: `a${number}`, role: 'assistant', content: [{ type: 'text', text: assistant }], source: { kind: 'model' } }, stream: [] }, { surfaceOp: 'append' });
    add('turn/end', { turn: number, reason: { kind: 'completed' } });
  };
  turn(1, 'old user one', 'old assistant one');
  add('compaction/start', { compactionId: 'first', turn: null });
  add('compaction/summary', { compactionId: 'first', summary: [{ type: 'text', text: 'first checkpoint' }], shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 2, provider: 'fixture', model: 'fixture' });
  add('user/message', { id: 'c1', role: 'user', content: [{ type: 'text', text: 'old source frame' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'first' } }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [4, 5, 1, 2] });
  add('compaction/end', { compactionId: 'first', turn: null });
  turn(2, 'old user two', 'old assistant two');
  add('compaction/start', { compactionId: 'second', turn: null });
  add('compaction/summary', { compactionId: 'second', summary: [{ type: 'text', text: 'FINAL CHECKPOINT' }], shadowedRange: { start: 6, end: 10 }, shadowedSeqs: [6, 9, 10], shadowedTokenCount: 3, provider: 'fixture', model: 'fixture' });
  add('user/message', { id: 'c2', role: 'user', content: [{ type: 'text', text: 'old source frame two' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'second' } }, { surfaceOp: { op: 'replace', startSeq: 6, endSeq: 10 }, sourceEventSeqs: [12, 13, 6, 9, 10] });
  add('compaction/end', { compactionId: 'second', turn: null });
  turn(3, 'current user three', 'current assistant three');
  const header = { type: 'session', version: 3, id: 'real-import-fixture', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/tmp/fixture' };
  return `${[header, ...events].map(JSON.stringify).join('\n')}\n`;
}

async function body(request) { let value = ''; for await (const chunk of request) value += chunk; return JSON.parse(value); }
function sse(id, text) { return `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\nevent: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'message', id: `m-${id}`, role: 'assistant', content: [{ type: 'output_text', text }] } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })}\n\n`; }

const root = await mkdtemp(join(tmpdir(), 'cfl-real-import-'));
const workspace = join(root, 'workspace');
const codexHome = join(root, 'codex-home');
const stateRoot = join(root, 'state');
const persona = join(root, 'persona.md');
const source = join(root, 'source.jsonl');
const relationship = join(root, 'state.jsonl');
const attachments = join(root, 'attachments-v1');
const requests = [];
const provider = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
  const value = await body(request); requests.push(value);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(sse(`response-${requests.length}`, 'import follow-up complete'));
});
try {
  for (const path of [codexHome, stateRoot, attachments]) await mkdir(path, { recursive: true });
  await writeFile(persona, 'You are Mica, a test-only companion.');
  await writeFile(source, sourceLog());
  await writeFile(relationship, `${JSON.stringify({ at: '2026-09-13T00:00:00.000Z', changes: { seed: true }, state: { mood: 'neutral', affinity: 50, signature: '' } })}\n`);
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.2"\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\n[features]\nplugins = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
  const executable = process.env.CODEX_PATCHED_CODEX;
  if (!executable) throw new Error('CODEX_PATCHED_CODEX is required');
  const config = { name: 'Mica', persona, state: stateRoot, workspace, port: 3082, codex: { command: executable, model: 'gpt-5.2', version: '0.154.0', home: codexHome, local_compaction: false } };
  const env = { HOME: root, CODEX_HOME: codexHome, OPENAI_API_KEY: 'test-loopback', CODEX_DISABLE_UPDATE_CHECK: '1', CODEX_DISABLE_FEEDBACK: '1' };
  const result = await convertDshSession(config, source, relationship, attachments, workspace, { appServer: { env } });
  assert.ok(result.destination.threadId);
  const { CodexAppServerClient } = await import('@jaminzhou/codex-app-server-client');
  const client = new CodexAppServerClient({ codexPath: executable, cwd: workspace, env, protocolValidation: 'strict', capabilities: { experimentalApi: true, requestAttestation: false } });
  try {
    await client.connect();
    const page = await client.call('thread/turns/list', { threadId: result.destination.threadId, limit: 20, sortDirection: 'asc', itemsView: 'full' });
    assert.equal(page.data.filter((turn) => turn.items.some((item) => item.type === 'userMessage')).length, 3);
    const visible = page.data.flatMap((turn) => turn.items.flatMap((item) =>
      item.type === 'userMessage' ? item.content.map((part) => part.type === 'text' ? part.text : '').filter(Boolean)
        : item.type === 'agentMessage' ? [item.text] : []));
    assert.deepEqual(visible, [
      'old user one', 'old assistant one', 'old user two', 'old assistant two',
      'current user three', 'current assistant three',
    ]);
    const completed = new Promise((resolve) => client.onNotification((notification) => { if (notification.method === 'turn/completed') resolve(); }));
    await client.call('thread/resume', { threadId: result.destination.threadId, excludeTurns: true });
    await client.call('turn/start', { threadId: result.destination.threadId, input: [{ type: 'text', text: 'FOLLOW UP', text_elements: [] }], clientUserMessageId: 'follow-up' });
    await completed;
  } finally { await client.close(); }
  const sent = JSON.stringify(requests.at(-1));
  assert.match(sent, /FINAL CHECKPOINT/);
  assert.match(sent, /current user three|current assistant three/);
  assert.doesNotMatch(sent, /old user one|old assistant one|old user two|old assistant two/);
  console.log('real import check passed');
} finally {
  provider.close();
  await rm(root, { recursive: true, force: true });
}
