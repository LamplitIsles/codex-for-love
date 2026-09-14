import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const root = process.env.FAKE_SERVER_ROOT;
const statePath = process.env.FAKE_SERVER_STATE;
const requestLog = process.env.FAKE_SERVER_REQUESTS;
const controlPath = process.env.FAKE_SERVER_CONTROL;
const nativeRoot = join(root, 'native-images');
const pngCreated = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64');
const pngEdited = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function save() { writeFileSync(statePath, JSON.stringify(state)); }
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  if (value.method === 'item/tool/call') {
    state.toolCalls = (state.toolCalls ?? 0) + 1;
    save();
  }
}
function log(value) { if (requestLog) appendFileSync(requestLog, `${JSON.stringify(value)}\n`); }
function control() { return controlPath ? readJson(controlPath, {}) : {}; }
function textOf(input) {
  return (Array.isArray(input) ? input : []).filter((item) => item.type === 'text').map((item) => item.text).join(' ');
}
function userItem(input, clientId) {
  return { type: 'userMessage', id: `user-${clientId}`, clientId, content: input };
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function threadRecord(cwd, model) {
  const timestamp = nowSeconds();
  return {
    id: state.threadId,
    cliVersion: '0.154.0',
    createdAt: timestamp,
    updatedAt: timestamp,
    recencyAt: null,
    cwd,
    ephemeral: false,
    model: model ?? null,
    modelProvider: 'fixture',
    historyMode: 'paginated',
    preview: '',
    projectId: null,
    sessionId: 'session-fake',
    source: 'appServer',
    status: { type: 'idle' },
    path: state.rolloutPath ?? join(root, 'thread-fake.jsonl'),
    extra: null,
    forkedFromId: null,
    parentThreadId: null,
    reasoningEffort: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    threadSource: null,
    turns: [],
  };
}

function loadRollout(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const meta = lines.find((line) => line.type === 'session_meta')?.payload;
  if (!meta?.id) rpcError(-32602, 'rollout lacks session metadata');
  state.threadId = meta.id;
  state.rolloutPath = path;
  const turns = [];
  let active;
  let modelHistory = [];
  for (const line of lines) {
    if (line.type === 'compacted') { modelHistory = line.payload.replacement_history ?? []; continue; }
    if (line.type === 'response_item') modelHistory.push(line.payload);
    if (line.type !== 'event_msg') continue;
    const event = line.payload;
    if (event.type === 'task_started') { active = { id: event.turn_id, status: 'inProgress', items: [], startedAt: event.started_at ?? null, completedAt: null, error: null }; turns.push(active); }
    else if (event.type === 'item_completed' && active) {
      if (event.item.type === 'UserMessage') active.items.push({ type: 'userMessage', id: event.item.id, content: event.item.content });
      else if (event.item.type === 'AgentMessage') active.items.push({ type: 'agentMessage', id: event.item.id, text: event.item.content.map((part) => part.text).join(''), phase: event.item.phase });
      else if (event.item.type === 'ContextCompaction') active.items.push({ type: 'contextCompaction', id: event.item.id });
    }
    else if (event.type === 'task_complete' && active) { active.status = 'completed'; active.completedAt = event.completed_at ?? null; active = undefined; }
  }
  state.turns = turns;
  state.importedHistory = modelHistory;
  runImportedStartupHook();
  save();
}

// The real pinned Codex runtime runs the startup SessionStart hook for a
// history-based thread/resume (the history route is a forked startup). Keep
// that observable bootstrap boundary in the test-owned fake so import tests
// also exercise ordinary CFL resume rather than a second local injector.
function runImportedStartupHook() {
  const command = process.env.FAKE_HOOK_COMMAND;
  if (!command) return;
  const result = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ source: 'startup' }) + '\n',
    encoding: 'utf8',
  });
  if (result.status !== 0) rpcError(-32603, result.stderr || `fixture startup hook exited ${result.status}`);
  state.hookRuns = (state.hookRuns ?? 0) + 1;
  state.hookOutputs = [...(state.hookOutputs ?? []), result.stdout];
  save();
}

function page(values, params) {
  const ordered = params.sortDirection === 'desc' ? [...values].reverse() : values;
  const requested = Number(params.limit);
  const limit = Number.isInteger(requested) && requested > 0 ? requested : ordered.length || 1;
  const cursor = Number(params.cursor);
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const data = ordered.slice(start, start + limit);
  const nextCursor = start + data.length < ordered.length ? String(start + data.length) : null;
  const backwardsCursor = start > 0 ? String(Math.max(0, start - 1)) : ordered.length ? '0' : null;
  return { data, nextCursor, backwardsCursor };
}

function turnView(turn, itemsView) {
  const view = itemsView === 'notLoaded' || itemsView === 'summary' || itemsView === 'full' ? itemsView : 'summary';
  if (view === 'notLoaded') {
    const { items, ...metadata } = turn;
    return { ...metadata, itemsView: view };
  }
  if (view === 'summary') {
    const users = turn.items.filter((item) => item.type === 'userMessage');
    const answer = [...turn.items].reverse().find((item) => item.type === 'agentMessage');
    return { ...turn, items: [...users, answer].filter((item, index, values) => item && values.indexOf(item) === index), itemsView: view };
  }
  return { ...turn, items: [...turn.items], itemsView: view };
}

const state = readJson(statePath, { threadId: 'thread-fake', next: 1, turns: [], active: null, trusted: false });
state.threadId ??= 'thread-fake';
const serverRequests = new Map();

function createNativeImage(kind, number) {
  const path = join(nativeRoot, `${kind}-${number}.png`);
  if (!existsSync(path)) {
    mkdirSync(nativeRoot, { recursive: true });
    writeFileSync(path, kind === 'edited' ? pngEdited : pngCreated, { mode: 0o600 });
  }
  return path;
}

async function waitForTool(id) {
  return new Promise((resolve) => serverRequests.set(id, resolve));
}

async function runTurn(turn) {
  const wait = () => {
    if (control().hold) return setTimeout(wait, 15);
    const text = textOf(turn.items.filter((item) => item.type === 'userMessage').flatMap((item) => item.content ?? []));
    if (process.env.FAKE_EARLY_TOOL === 'true' && text.includes('relationship tool')) void completeTurn();
    else setTimeout(() => void completeTurn(), 0);
  };
  const completeTurn = async () => {
    if (state.active !== turn.id || turn.status !== 'inProgress') return;
    const input = turn.items.filter((item) => item.type === 'userMessage').flatMap((item) => item.content ?? []);
    const text = textOf(input);
    const items = [];
    if (text.includes('generate image') || text.includes('edit image') || text.includes('/image')) {
      const itemId = `image-item-${state.next++}`;
      const kind = text.includes('edit') ? 'edited' : 'created';
      const savedPath = text.includes('missing image') ? join(nativeRoot, 'missing.png') : createNativeImage(kind, state.next);
      const image = { type: 'imageGeneration', id: itemId, status: 'completed', revisedPrompt: `${kind} fixture image`, result: '', failure: null, savedPath };
      items.push(image);
      send({ method: 'item/started', params: { threadId: state.threadId, turnId: turn.id, startedAtMs: Date.now(), item: { ...image, status: 'in_progress' } } });
      turn.items.push(image);
      send({ method: 'item/completed', params: { threadId: state.threadId, turnId: turn.id, completedAtMs: Date.now(), item: image } });
    }
    const answer = { type: 'agentMessage', id: `answer-${state.next++}`, text: items.length ? `已完成${text.includes('edit') ? '编辑' : '创作'}。` : `fixture reply ${state.next}`, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
    turn.items.push(answer);
    send({ method: 'item/completed', params: { threadId: state.threadId, turnId: turn.id, completedAtMs: Date.now(), item: answer } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: state.threadId, turnId: turn.id, tokenUsage: { total: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: state.next * 10 }, last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: state.next * 10 }, modelContextWindow: 200000 } } });
    turn.status = 'completed';
    turn.completedAt = nowSeconds();
    state.active = null;
    save();
    send({ method: 'turn/completed', params: { threadId: state.threadId, turn } });
  };
  wait();
}

function startTurn(input, clientUserMessageId) {
  const turn = { id: `turn-${state.next++}`, items: [userItem(input, clientUserMessageId)], itemsView: 'full', status: 'inProgress', error: null, startedAt: nowSeconds(), completedAt: null };
  state.turns.push(turn);
  state.active = turn.id;
  save();
  send({ method: 'turn/started', params: { threadId: state.threadId, turn } });
  void runTurn(turn);
  return turn;
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  throw error;
}

function steerTurn(params) {
  const turn = state.turns.find((candidate) => candidate.id === state.active);
  if (!turn) rpcError(-32600, 'no active turn to steer');
  const noActiveCount = Number(process.env.FAKE_NO_ACTIVE_STEER_COUNT ?? 0);
  if (noActiveCount > 0) {
    process.env.FAKE_NO_ACTIVE_STEER_COUNT = String(noActiveCount - 1);
    turn.status = 'completed';
    turn.completedAt = nowSeconds();
    state.active = null;
    save();
    send({ method: 'turn/completed', params: { threadId: state.threadId, turn } });
    rpcError(-32600, 'no active turn to steer');
  }
  const mismatchCount = Number(process.env.FAKE_STEER_MISMATCH_COUNT ?? 0);
  if (mismatchCount > 0) {
    process.env.FAKE_STEER_MISMATCH_COUNT = String(mismatchCount - 1);
    rpcError(-32600, `expected active turn id \`stale-turn\` but found \`${turn.id}\``);
  }
  if (turn.id !== params.expectedTurnId) rpcError(-32600, `expected active turn id \`${params.expectedTurnId}\` but found \`${turn.id}\``);
  const rejectCount = Number(process.env.FAKE_REJECT_STEER_COUNT ?? 0);
  if (process.env.FAKE_REJECT_STEER === 'true' || rejectCount > 0) {
    if (rejectCount > 0) process.env.FAKE_REJECT_STEER_COUNT = String(rejectCount - 1);
    const turnKind = process.env.FAKE_REJECT_STEER_KIND === 'compact' ? 'compact' : 'review';
    rpcError(-32600, `cannot steer a ${turnKind} turn`, {
      message: `cannot steer a ${turnKind} turn`,
      codexErrorInfo: { activeTurnNotSteerable: { turnKind } },
      additionalDetails: null,
    });
  }
  const item = userItem(params.input, params.clientUserMessageId);
  turn.items.push(item);
  save();
  if (process.env.FAKE_DELAY_STEER_ITEM !== 'true') {
    send({ method: 'item/completed', params: { threadId: state.threadId, turnId: turn.id, completedAtMs: Date.now(), item } });
  }
  return { turnId: turn.id };
}

async function compact() {
  const turn = { id: `compact-${state.next++}`, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: nowSeconds(), completedAt: null };
  state.turns.push(turn);
  state.active = turn.id;
  save();
  send({ method: 'turn/started', params: { threadId: state.threadId, turn } });
  const item = { type: 'contextCompaction', id: `context-${state.next++}` };
  send({ method: 'item/started', params: { threadId: state.threadId, turnId: turn.id, startedAtMs: Date.now(), item } });
  send({ method: 'item/completed', params: { threadId: state.threadId, turnId: turn.id, completedAtMs: Date.now(), item } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: state.threadId, turnId: turn.id, tokenUsage: { total: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }, last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }, modelContextWindow: 200000 } } });
  turn.status = 'completed';
  turn.completedAt = nowSeconds();
  state.active = null;
  save();
  send({ method: 'turn/completed', params: { threadId: state.threadId, turn } });
}

async function handle(request) {
  if (process.env.FAKE_HOLD_METHOD === request.method) await new Promise(() => {});
  if (process.env.FAKE_MALFORMED_METHOD === request.method) return { malformed: true };
  const p = request.params ?? {};
  switch (request.method) {
    case 'initialize': {
      const response = { userAgent: `fixture/${process.env.FAKE_SERVER_VERSION ?? '0.154.0'}`, codexHome: root, platformFamily: 'unix', platformOs: 'linux' };
      if (process.env.FAKE_EXIT_AFTER_INITIALIZE === 'true') setTimeout(() => process.exit(42), 0);
      return response;
    }
    case 'initialized': return undefined;
    case 'modelProvider/capabilities/read': return { namespaceTools: true, imageGeneration: process.env.FAKE_IMAGE_CAPABILITY !== 'false', webSearch: true };
    case 'config/mcpServer/reload': return {};
    case 'mcpServerStatus/list': {
      if (p.threadId !== state.threadId) rpcError(-32602, 'MCP status requires the current thread');
      const defaultStatus = ['companion', 'flicknote', 'project', 'web'].map((name) => ({ name, runtimeStatus: 'connected', pluginId: null, serverInfo: null, tools: {}, toolsError: null, resources: [], resourceTemplates: [], authStatus: 'notLoggedIn' }));
      const configured = process.env.FAKE_MCP_STATUS_PAGES ? JSON.parse(process.env.FAKE_MCP_STATUS_PAGES) : [defaultStatus];
      state.mcpStatusObservations ??= 0;
      const observations = Array.isArray(configured[0]?.[0]) ? configured : [configured];
      const pages = observations[Math.min(state.mcpStatusObservations, observations.length - 1)] ?? [defaultStatus];
      const index = Number(p.cursor ?? 0);
      if (index === 0) { state.mcpStatusObservations += 1; save(); }
      return { data: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
    }
    case 'hooks/list': return { data: [{
      cwd: p.cwds?.[0] ?? process.cwd(),
      hooks: [{ eventName: 'sessionStart', handlerType: 'command', command: process.env.FAKE_HOOK_COMMAND, async: false,
        matcher: 'startup|compact', additionalContextLimit: 0, sourcePath: process.env.FAKE_CONFIG_PATH,
        source: 'project', key: 'fixture-hook', currentHash: 'sha256:fixture', trustStatus: state.trusted ? 'trusted' : 'untrusted',
        displayOrder: 0, enabled: true, isManaged: false, timeoutSec: 10, statusMessage: null, pluginId: null }],
      errors: [], warnings: [],
    }] };
    case 'config/batchWrite': state.trusted = true; save(); return { filePath: process.env.FAKE_CONFIG_PATH, status: 'ok', version: 'fixture-1', overriddenMetadata: null };
    case 'thread/start': {
      state.threadId = 'thread-fake'; save(); return { thread: threadRecord(p.cwd, p.model), model: p.model, modelProvider: 'fixture', serviceTier: null, cwd: p.cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly' };
    }
    case 'thread/resume': {
      if (typeof p.path === 'string' && p.path) loadRollout(p.path);
      if (control().failResume) rpcError(-32603, 'fixture resume rejected');
      if (Array.isArray(p.history)) {
        if (!p.history.length) rpcError(-32602, 'history must contain at least one item');
        state.importedHistory = p.history;
        state.historyResumeCount = (state.historyResumeCount ?? 0) + 1;
        runImportedStartupHook();
        save();
      }
      return { thread: threadRecord(p.cwd, p.model), model: p.model, modelProvider: 'fixture', serviceTier: null, cwd: p.cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly' };
    }
    case 'thread/turns/list': {
      if (process.env.FAKE_HISTORY_ERROR) {
        const error = new Error(process.env.FAKE_HISTORY_ERROR);
        error.code = process.env.FAKE_HISTORY_ERROR_CODE ? Number(process.env.FAKE_HISTORY_ERROR_CODE) : -32603;
        throw error;
      }
      const turns = state.turns.map((turn) => turnView(turn, p.itemsView));
      return page(turns, p);
    }
    case 'thread/items/list': {
      const turns = p.turnId ? state.turns.filter((turn) => turn.id === p.turnId) : state.turns;
      const items = turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })));
      return page(items, p);
    }
    case 'turn/start': {
      if (state.active) rpcError(-32600, 'cannot start a turn while another turn is active');
      const turn = startTurn(p.input, p.clientUserMessageId);
      return { turn };
    }
    case 'turn/steer': return steerTurn(p);
    case 'turn/interrupt': {
      const active = state.turns.find((candidate) => candidate.id === state.active);
      if (!active) rpcError(-32600, 'no active turn to interrupt');
      if (active.id !== p.turnId) rpcError(-32600, `expected active turn id ${p.turnId} but found ${active.id}`);
      active.status = 'interrupted'; active.error = { message: 'interrupted' }; state.active = null; save(); send({ method: 'turn/completed', params: { threadId: state.threadId, turn: active } });
      return {};
    }
    case 'thread/compact/start': void compact(); return {};
    default: throw new Error(`fixture does not implement ${request.method}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  log(request);
  if (request.id !== undefined && !request.method && serverRequests.has(request.id)) {
    serverRequests.get(request.id)(request.result);
    serverRequests.delete(request.id);
    return;
  }
  if (request.id !== undefined && request.method === 'item/tool/call') return;
  if (request.id === undefined) return;
  try {
    const result = await handle(request);
    if (process.env.FAKE_DROP_RESPONSE_METHOD === request.method) return;
    send({ id: request.id, result });
  }
  catch (error) {
    const code = typeof error?.code === 'number' ? error.code : -32603;
    send({ id: request.id, error: { code, message: error instanceof Error ? error.message : String(error), ...(error?.data !== undefined ? { data: error.data } : {}) } });
  }
});
