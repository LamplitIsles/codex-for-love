import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient, resolveCodexBinary } from '@jaminzhou/codex-app-server-client';

const CODEX_VERSION = '0.154.0';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

function responseEvents(id, text) {
  return [
    ['response.created', { type: 'response.created', response: { id } }],
    ['response.output_item.done', { type: 'response.output_item.done', item: {
      type: 'message', role: 'assistant', id: `message-${id}`, content: [{ type: 'output_text', text }],
    } }],
    ['response.completed', { type: 'response.completed', response: {
      id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 },
    } }],
  ];
}

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function latestUserText(body) {
  const messages = (body.input ?? []).filter((item) => item.type === 'message');
  const latest = messages.at(-1);
  return latest?.content?.filter((part) => part.type === 'input_text').map((part) => part.text).join(' ') ?? '';
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'codex-for-love-real-sdk-'));
  const workspace = join(root, 'workspace');
  const codexHome = join(root, 'codex-home');
  const xdgConfig = join(root, 'xdg-config');
  const xdgData = join(root, 'xdg-data');
  const xdgCache = join(root, 'xdg-cache');
  const imagePath = join(workspace, 'probe.png');
  for (const path of [workspace, codexHome, xdgConfig, xdgData, xdgCache]) await mkdir(path, { recursive: true });
  await writeFile(imagePath, PNG, { mode: 0o600 });

  const modelRequests = [];
  let responseNumber = 0;
  let steeringReleased = false;
  let releaseSteering = () => {};
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const body = JSON.parse(await readBody(request));
    modelRequests.push(body);
    const serialized = JSON.stringify(body);
    const latestText = latestUserText(body);
    if (latestText === 'hold steering' && !steeringReleased) {
      await new Promise((resolve) => {
        releaseSteering = resolve;
        request.once('aborted', resolve);
        response.once('close', resolve);
      });
    }
    if (latestText === 'hold cancellation') {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 15_000);
        const release = () => { clearTimeout(timer); resolve(); };
        request.once('aborted', release);
        response.once('close', release);
      });
      if (!response.writableEnded) response.end();
      return;
    }
    const hasToolOutput = body.input?.some((item) => item.type === 'function_call_output' && item.call_id === 'real-probe-call');
    const invokesTool = body.input?.some((item) => item.type === 'message'
      && item.content?.some((part) => part.type === 'input_text' && part.text.includes('invoke dynamic tool')));
    const id = `real-response-${++responseNumber}`;
    const events = invokesTool && !hasToolOutput
      ? [
          ['response.created', { type: 'response.created', response: { id } }],
          ['response.output_item.done', { type: 'response.output_item.done', item: {
            type: 'function_call', call_id: 'real-probe-call', name: 'probe_tool', arguments: '{"value":"ok"}',
          } }],
          ['response.completed', { type: 'response.completed', response: {
            id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 },
          } }],
        ]
      : responseEvents(id, 'loopback response');
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(sse(events));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;
  await writeFile(join(codexHome, 'config.toml'), `model = "loopback-model"
model_provider = "loopback"
mcp_servers = {}
[features]
plugins = false
[model_providers.loopback]
name = "loopback"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);

  const environment = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    OPENAI_API_KEY: '',
    CODEX_API_KEY: '',
    CODEX_DISABLE_FEEDBACK: '1',
    CODEX_DISABLE_UPDATE_CHECK: '1',
  };
  const notifications = [];
  let dynamicToolCalls = 0;
  let client;
  try {
    client = new CodexAppServerClient({
      codexPath: resolveCodexBinary().executablePath,
      cwd: workspace,
      env: environment,
      protocolValidation: 'strict',
      requestTimeoutMs: 10_000,
      capabilities: { experimentalApi: true, requestAttestation: false },
      clientInfo: { name: 'codex-for-love-real-check', title: 'Codex for Love real check', version: '0.1.0' },
    });
    client.onNotification((notification) => { notifications.push(notification); });
    client.onServerRequest('item/tool/call', (params, request) => {
      assert.equal(request.method, 'item/tool/call');
      assert.equal(params.tool, 'probe_tool');
      assert.deepEqual(params.arguments, { value: 'ok' });
      dynamicToolCalls += 1;
      return { success: true, contentItems: [{ type: 'inputText', text: 'real dynamic result' }] };
    });

    const initialized = await client.connect();
    assert.match(initialized.userAgent, new RegExp(`\\b${CODEX_VERSION.replaceAll('.', '\\.')}\\b`));
    assert.equal(initialized.codexHome, codexHome);
    assert.equal(initialized.platformFamily, 'unix');
    assert.equal(initialized.platformOs, 'linux');

    const started = await client.call('thread/start', {
      model: 'loopback-model',
      modelProvider: 'loopback',
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'paginated',
      dynamicTools: [{
        type: 'function',
        name: 'probe_tool',
        description: 'A test-owned dynamic tool.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      }],
    });
    const threadId = started.thread.id;
    assert.ok(threadId);

    const first = await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'invoke dynamic tool', text_elements: [] }],
      clientUserMessageId: 'real-dynamic-message',
    });
    assert.ok(first.turn.id);
    await waitFor(() => dynamicToolCalls === 1, 'the early dynamic tool response');
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.status === 'completed'), 'dynamic turn completion');

    const completedBeforeImage = notifications.filter((notification) => notification.method === 'turn/completed').length;
    const second = await client.call('turn/start', {
      threadId,
      input: [
        { type: 'text', text: 'text with local image', text_elements: [] },
        { type: 'localImage', path: imagePath },
      ],
      clientUserMessageId: 'real-image-message',
    });
    assert.ok(second.turn.id);
    await waitFor(() => notifications.filter((notification) => notification.method === 'turn/completed').length > completedBeforeImage, 'text/localImage turn completion');
    const imageRequest = modelRequests.find((body) => JSON.stringify(body).includes('input_image'));
    assert.ok(imageRequest, 'loopback provider received a native local image');
    assert.ok(JSON.stringify(imageRequest).includes('data:image/png;base64,'));

    const firstPage = await client.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'asc', itemsView: 'full' });
    assert.equal(firstPage.data.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await client.call('thread/turns/list', { threadId, cursor: firstPage.nextCursor, limit: 1, sortDirection: 'asc', itemsView: 'full' });
    assert.equal(secondPage.data.length, 1);
    assert.notEqual(firstPage.data[0].id, secondPage.data[0].id);
    const itemPage = await client.call('thread/items/list', { threadId, turnId: firstPage.data[0].id, limit: 100, sortDirection: 'asc' });
    assert.ok(itemPage.data.length >= 2);

    const steeringStart = await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hold steering', text_elements: [] }],
      clientUserMessageId: 'real-steering-first',
    });
    const steeringTurnId = steeringStart.turn.id;
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/started'
      && notification.params.turn.id === steeringTurnId), 'active steering turn start');
    await waitFor(() => modelRequests.some((body) => JSON.stringify(body).includes('hold steering')), 'held steering Responses request');
    const steerPromise = client.call('turn/steer', {
      threadId,
      input: [{ type: 'text', text: 'steering input', text_elements: [] }],
      clientUserMessageId: 'real-steering-second',
      expectedTurnId: steeringTurnId,
    });
    const steered = await steerPromise;
    assert.equal(steered.turnId, steeringTurnId);
    steeringReleased = true;
    releaseSteering();
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === steeringTurnId
      && notification.params.turn.status === 'completed'), 'steered turn completion');
    const steeredItems = await client.call('thread/items/list', { threadId, turnId: steeringTurnId, limit: 100, sortDirection: 'asc' });
    assert.equal(steeredItems.data.filter((entry) => entry.item.type === 'userMessage').length, 2);

    const activeBeforeCancel = notifications.filter((notification) => notification.method === 'turn/started').length;
    const activeStart = await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hold cancellation', text_elements: [] }],
      clientUserMessageId: 'real-cancel-active',
    });
    const activeTurn = activeStart.turn;
    await waitFor(() => notifications.filter((notification) => notification.method === 'turn/started').length > activeBeforeCancel, 'active cancellation turn start');
    await waitFor(() => modelRequests.some((body) => JSON.stringify(body).includes('hold cancellation')), 'held Responses request');
    await client.call('turn/interrupt', { threadId, turnId: activeTurn.id });
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === activeTurn.id && notification.params.turn.status === 'interrupted'), 'active cancellation completion');

    const fresh = await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'fresh after interruption', text_elements: [] }],
      clientUserMessageId: 'real-after-interrupt',
    });
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === fresh.turn.id && notification.params.turn.status === 'completed'), 'fresh post-interrupt completion');

    console.log(`real SDK check passed: ${initialized.userAgent}; handshake, native start/steer, multiple-input history, interrupt/fresh start, paginated history/items, dynamic tool, text/localImage, strict validation`);
  } finally {
    steeringReleased = true;
    releaseSteering();
    await client?.close();
    provider.closeAllConnections?.();
    await new Promise((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

await main();
