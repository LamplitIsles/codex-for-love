// Narrow native protocol check. Run only with an approved test resource budget.
// This checks native history and model input, not Partner/Store or App acceptance.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CodexAppServerClient } from '@jaminzhou/codex-app-server-client';

const expectedNativeSha256 = '1dda783f0411d0e6f4434cfcd415f845e40ec487c608e4a37d7e737aac5cef0e';
const nativePath = process.argv[2];
if (process.argv.length !== 3 || !nativePath || !isAbsolute(nativePath)) {
  throw new Error('Pass the absolute path to the pinned Linux x64 Codex app-server');
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(nativePath)) hash.update(chunk);
assert.equal(hash.digest('hex'), expectedNativeSha256, 'native executable SHA-256');

// The SDK merges process.env into the child. Remove inherited credentials,
// proxy settings and configuration before launching the native process.
for (const key of Object.keys(process.env)) delete process.env[key];
process.env.PATH = '/usr/bin:/bin';

const root = await realpath(await mkdtemp(join(tmpdir(), 'cfl-native-file-text-')));
const workspace = join(root, 'workspace');
const codexHome = join(root, 'codex-home');
const home = join(root, 'home');
const xdgConfig = join(root, 'xdg-config');
const xdgData = join(root, 'xdg-data');
const xdgCache = join(root, 'xdg-cache');
const temp = join(root, 'tmp');
const notifications = [];
const modelInputs = [];
let releaseHeld = () => {};
let provider;
let client;

function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (!await check()) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
}
function latestUserText(body) {
  const user = (body.input ?? []).filter(item => item.type === 'message' && item.role === 'user').at(-1);
  return (user?.content ?? []).filter(part => part.type === 'input_text').map(part => part.text).join(' ');
}
function providerReply(id) {
  const events = [
    ['response.created', { type: 'response.created', response: { id } }],
    ['response.output_item.done', { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${id}`, content: [{ type: 'output_text', text: 'fixture response' }] } }],
    ['response.completed', { type: 'response.completed', response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
function fileText(body, files) {
  return `${body}\n\nFiles (paths relative to workspace):\n${JSON.stringify(files)}`;
}
function textMatches(item, operationId, expected) {
  return item?.type === 'userMessage' && item.clientId === operationId
    && Array.isArray(item.content) && item.content.length === 1
    && item.content[0]?.type === 'text' && item.content[0].text === expected;
}
async function findHistoryItem(threadId, mode, operationId, expected) {
  if (mode === 'legacy') {
    const response = await client.call('thread/read', { threadId, includeTurns: true });
    assert.equal(response.thread.historyMode, 'legacy');
    return response.thread.turns.some(turn => (turn.items ?? []).some(item => textMatches(item, operationId, expected)));
  }
  let cursor;
  const visited = new Set();
  do {
    const page = await client.call('thread/items/list', { threadId, limit: 2, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
    if (page.data.some(entry => textMatches('item' in entry ? entry.item : entry, operationId, expected))) return true;
    const next = page.nextCursor ?? undefined;
    if (!next) return false;
    if (!page.data.length || visited.has(next)) throw new Error('Invalid native history cursor');
    visited.add(next); cursor = next;
  } while (true);
}

try {
  for (const directory of [workspace, codexHome, home, xdgConfig, xdgData, xdgCache, temp]) await mkdir(directory, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = temp;
  const directory = '0123456789abcdef0123456789abcdef';
  const contents = ['synthetic-0', 'synthetic-1'];
  const files = ['first.txt', '报告\n"二".txt'].map((name, index) => ({
    name,
    path: `.lamplit/attachments/.file-operations/${directory}/p${index}-${createHash('sha256').update(contents[index]).digest('hex')}.file`,
  }));
  await mkdir(join(workspace, '.lamplit', 'attachments', '.file-operations', directory), { recursive: true, mode: 0o700 });
  for (const [index, file] of files.entries()) await writeFile(join(workspace, file.path), contents[index], { mode: 0o600 });

  let responseCount = 0;
  provider = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 1_000_000) throw new Error('Synthetic provider request exceeded 1 MB');
      }
      if (modelInputs.length >= 12) throw new Error('Unexpected provider request count');
      const body = JSON.parse(raw);
      modelInputs.push(body);
      if (latestUserText(body).startsWith('hold active A ')) {
        await new Promise(resolve => {
          const release = () => { releaseHeld = () => {}; resolve(); };
          releaseHeld = release;
          request.once('aborted', release); response.once('close', release);
        });
      }
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      response.end(providerReply(`file-text-${++responseCount}`));
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const port = provider.address().port;
  const config = `thread_unload_delay_secs = 1\nmodel = "gpt-5.2"\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\n[features]\nplugins = false\n`;
  await mkdir(join(workspace, '.codex'), { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, '.codex', 'config.toml'), config, { mode: 0o600 });
  await writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600 });
  client = new CodexAppServerClient({
    codexPath: nativePath, codexExecutableType: 'app-server', cwd: workspace,
    env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData, XDG_CACHE_HOME: xdgCache, TMPDIR: temp, OPENAI_API_KEY: 'test-only-loopback-key', CODEX_API_KEY: '', CODEX_DISABLE_FEEDBACK: '1', CODEX_DISABLE_UPDATE_CHECK: '1', NO_PROXY: '127.0.0.1,localhost' },
    protocolValidation: 'strict', requestTimeoutMs: 10_000,
    capabilities: { experimentalApi: true, requestAttestation: false },
    clientInfo: { name: 'cfl-real-file-text-check', title: 'CFL real file text check', version: '0.1.0' },
  });
  client.onNotification(notification => notifications.push(notification));
  const initialized = await client.connect();
  assert.match(initialized.userAgent, /\b0\.164\.0\b/u);
  assert.equal(initialized.codexHome, codexHome);

  for (const mode of ['paginated', 'legacy']) {
    const { thread } = await client.call('thread/start', { model: 'gpt-5.2', modelProvider: 'openai', cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access', historyMode: mode });
    assert.equal(thread.historyMode, mode);
    const startId = randomUUID(), startText = fileText('', [files[0]]);
    const requestsBeforeStart = modelInputs.length;
    const start = await client.call('turn/start', { threadId: thread.id, clientUserMessageId: startId, input: [{ type: 'text', text: startText, text_elements: [] }] });
    await waitFor(() => notifications.some(n => n.method === 'turn/completed' && n.params.turn.id === start.turn.id && n.params.turn.status === 'completed'), `${mode} start completion`);
    await waitFor(() => findHistoryItem(thread.id, mode, startId, startText), `${mode} start history`);
    assert.ok(modelInputs.slice(requestsBeforeStart).some(body => latestUserText(body) === startText), `${mode} model received the file-only text`);

    const activeId = randomUUID(), activeText = `hold active A ${mode}`;
    const active = await client.call('turn/start', { threadId: thread.id, clientUserMessageId: activeId, input: [{ type: 'text', text: activeText, text_elements: [] }] });
    await waitFor(() => modelInputs.some(body => latestUserText(body) === activeText), `${mode} active A provider gate`);
    const steerId = randomUUID();
    const body = `原文 😺\r\n${fileText('', files)}\n末尾`;
    const steerText = fileText(body, files);
    const steered = await client.call('turn/steer', { threadId: thread.id, expectedTurnId: active.turn.id, clientUserMessageId: steerId, input: [{ type: 'text', text: steerText, text_elements: [] }] });
    assert.equal(steered.turnId, active.turn.id);
    releaseHeld();
    await waitFor(() => notifications.some(n => n.method === 'turn/completed' && n.params.turn.id === active.turn.id && n.params.turn.status === 'completed'), `${mode} active turn completion`);
    await waitFor(() => findHistoryItem(thread.id, mode, steerId, steerText), `${mode} steer history`);
    console.log(`PASS ${mode}: file-only start and active A / file B steer retained exact clientId and text`);
  }
} finally {
  releaseHeld();
  provider?.closeAllConnections?.();
  try { await client?.close(); } finally {
    if (provider?.listening) await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
