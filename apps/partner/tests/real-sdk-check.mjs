import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient, resolveCodexBinary } from '@jaminzhou/codex-app-server-client';
import { compactionPrompt } from '../runtime/prompts.ts';
import { verifyCodexArtifact } from '../runtime/provenance.ts';

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

function responseEvents(id, text, totalTokens = 0) {
  return [
    ['response.created', { type: 'response.created', response: { id } }],
    ['response.output_item.done', { type: 'response.output_item.done', item: {
      type: 'message', role: 'assistant', id: `message-${id}`, content: [{ type: 'output_text', text }],
    } }],
    ['response.completed', { type: 'response.completed', response: {
      id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: totalTokens },
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
  let autoCompactionMode = false;
  let steeringReleased = false;
  let releaseSteering = () => {};
  const localCompactionRequests = [];
  const remoteCompactionRequests = [];
  const provider = createServer(async (request, response) => {
    const responsesRequest = request.method === 'POST'
      && (request.url?.endsWith('/responses') || request.url?.endsWith('/responses/compact'));
    if (!responsesRequest) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (request.url?.endsWith('/responses/compact')) {
      remoteCompactionRequests.push({ path: request.url });
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'remote compaction is forbidden in this check' }));
      return;
    }
    const body = JSON.parse(await readBody(request));
    modelRequests.push(body);
    const latestText = latestUserText(body);
    const hasRemoteTrigger = body.input?.some((item) => item.type === 'compaction_trigger');
    if (hasRemoteTrigger) remoteCompactionRequests.push({ path: request.url, body });
    const isCompaction = latestText === compactionPrompt;
    if (isCompaction) localCompactionRequests.push(body);
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
    const responseText = isCompaction ? 'CUSTOMIZED_LOCAL_CHECKPOINT' : 'loopback response';
    const totalTokens = autoCompactionMode && !isCompaction ? 5_000 : 0;
    const codeModeRequested = body.input?.some((item) => item.type === 'message'
      && item.content?.some((part) => part.type === 'input_text' && part.text === 'exercise native code mode'));
    const codeModeDone = body.input?.some((item) => item.type === 'custom_tool_call_output'
      && item.call_id === 'code-mode-probe');
    const events = codeModeRequested && !codeModeDone
      ? [
          ['response.created', { type: 'response.created', response: { id } }],
          ['response.output_item.done', { type: 'response.output_item.done', item: {
            type: 'custom_tool_call', call_id: 'code-mode-probe', name: 'exec', input: 'text("CODE_MODE_HOST_OK")',
          } }],
          ['response.completed', { type: 'response.completed', response: { id } }],
        ]
      : invokesTool && !hasToolOutput
      ? [
          ['response.created', { type: 'response.created', response: { id } }],
          ['response.output_item.done', { type: 'response.output_item.done', item: {
            type: 'function_call', call_id: 'real-probe-call', name: 'probe_tool', arguments: '{"value":"ok"}',
          } }],
          ['response.completed', { type: 'response.completed', response: {
            id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 },
          } }],
        ]
      : responseEvents(id, responseText, totalTokens);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(sse(events));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.2"
model_provider = "openai"
openai_base_url = "http://127.0.0.1:${port}/v1"
mcp_servers = {}
[features]
plugins = false
`);

  const environment = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    OPENAI_API_KEY: 'test-only-loopback-key',
    CODEX_API_KEY: '',
    CODEX_DISABLE_FEEDBACK: '1',
    CODEX_DISABLE_UPDATE_CHECK: '1',
  };
  const notifications = [];
  let dynamicToolCalls = 0;
  let client;
  try {
    const selectedCodex = process.env.CODEX_PATCHED_CODEX;
    if (selectedCodex) {
      const provenance = process.env.CODEX_PATCHED_PROVENANCE;
      if (!provenance) throw new Error('CODEX_PATCHED_PROVENANCE is required with CODEX_PATCHED_CODEX');
      await verifyCodexArtifact(selectedCodex, provenance);
    } else if (process.env.REQUIRE_CODEX_PATCHED === '1') {
      throw new Error('REQUIRE_CODEX_PATCHED=1 requires CODEX_PATCHED_CODEX');
    }
    client = new CodexAppServerClient({
      codexPath: selectedCodex ?? resolveCodexBinary().executablePath,
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
      model: 'gpt-5.2',
      modelProvider: 'openai',
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'paginated',
      config: {
        compact_prompt: compactionPrompt,
        experimental_local_compaction: true,
      },
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

    const manualCompactionCount = localCompactionRequests.length;
    const beforeManualEvents = notifications.length;
    await client.call('thread/compact/start', { threadId });
    await waitFor(() => localCompactionRequests.length > manualCompactionCount, 'manual local compaction request');
    const manualCompaction = localCompactionRequests.at(-1);
    assert.ok(manualCompaction);
    assert.equal(latestUserText(manualCompaction), compactionPrompt);
    assert.equal(manualCompaction.input.some((item) => item.type === 'compaction_trigger'), false);

    await waitFor(() => notifications.slice(beforeManualEvents).some((notification) => notification.method === 'turn/completed'
      && notification.params.threadId === threadId
      && notification.params.turn.status === 'completed'), 'manual compaction completion');

    const beforeManualFollowUp = modelRequests.length;
    const manualFollowUp = await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'after manual local compaction', text_elements: [] }],
      clientUserMessageId: 'real-after-manual-compaction',
    });
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === manualFollowUp.turn.id
      && notification.params.turn.status === 'completed'), 'post-manual-compaction turn completion');
    const manualFollowUpRequest = modelRequests.slice(beforeManualFollowUp).at(-1);
    assert.ok(manualFollowUpRequest);
    assert.ok(JSON.stringify(manualFollowUpRequest).includes('CUSTOMIZED_LOCAL_CHECKPOINT'));
    assert.ok(JSON.stringify(manualFollowUpRequest).includes('The following checkpoint summarizes earlier conversation.'));
    const sessionFiles = await readdir(join(codexHome, 'sessions'), { recursive: true });
    const rolloutFile = sessionFiles.find((path) => path.endsWith('.jsonl') && path.includes(threadId));
    assert.ok(rolloutFile, 'official session rollout exists');
    const rollout = (await readFile(join(codexHome, 'sessions', rolloutFile), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rollout.some((entry) => entry.type === 'compacted'
      && JSON.stringify(entry.payload).includes('CUSTOMIZED_LOCAL_CHECKPOINT')), 'checkpoint persisted in official compacted record');

    autoCompactionMode = true;
    const autoStarted = await client.call('thread/start', {
      model: 'gpt-5.2',
      modelProvider: 'openai',
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'paginated',
      config: {
        compact_prompt: compactionPrompt,
        experimental_local_compaction: true,
        model_auto_compact_token_limit: 1_000,
      },
    });
    const autoThreadId = autoStarted.thread.id;
    const automaticCompactionCount = localCompactionRequests.length;
    const autoFirst = await client.call('turn/start', {
      threadId: autoThreadId,
      input: [{ type: 'text', text: 'automatic compaction seed', text_elements: [] }],
      clientUserMessageId: 'real-auto-seed',
    });
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === autoFirst.turn.id
      && notification.params.turn.status === 'completed'), 'automatic compaction seed completion');
    const autoSecond = await client.call('turn/start', {
      threadId: autoThreadId,
      input: [{ type: 'text', text: 'automatic compaction follow-up', text_elements: [] }],
      clientUserMessageId: 'real-auto-follow-up',
    });
    await waitFor(() => localCompactionRequests.length > automaticCompactionCount, 'automatic local compaction request');
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === autoSecond.turn.id
      && notification.params.turn.status === 'completed'), 'automatic compaction follow-up completion');
    const automaticCompaction = localCompactionRequests.slice(automaticCompactionCount).at(-1);
    assert.ok(automaticCompaction);
    assert.equal(latestUserText(automaticCompaction), compactionPrompt);
    assert.equal(automaticCompaction.input.some((item) => item.type === 'compaction_trigger'), false);
    assert.equal(remoteCompactionRequests.length, 0, 'local override must not issue a remote compaction request');

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

    const codeThread = await client.call('thread/start', {
      model: 'gpt-5.2', modelProvider: 'openai', cwd: workspace,
      approvalPolicy: 'never', sandbox: 'danger-full-access',
      config: { 'features.code_mode': true },
    });
    const codeTurn = await client.call('turn/start', {
      threadId: codeThread.thread.id,
      input: [{ type: 'text', text: 'exercise native code mode', text_elements: [] }],
    });
    await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === codeTurn.turn.id && notification.params.turn.status === 'completed'), 'native code-mode host');
    assert.ok(modelRequests.some((body) => body.input?.some((item) => item.type === 'custom_tool_call_output'
      && item.call_id === 'code-mode-probe' && JSON.stringify(item.output).includes('CODE_MODE_HOST_OK'))));

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
