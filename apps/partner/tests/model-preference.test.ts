import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import type { AuthStore } from '../runtime/auth.ts';
import { loadConfig } from '../runtime/config.ts';
import { saveModelPreference } from '../runtime/model-preference.ts';
import { event, postService } from './post-fixture.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';

const sol = 'gpt-6.1-sol', terra = 'gpt-6.1-terra';
const allowed = async () => true;
const commit = () => true;
const selection = (model = sol, expectedModel = sol, sessionId = 'thread-fake', fast = true, expectedFast = true) => ({ sessionId, expectedModel, expectedFast, model, fast });
const code = (value: string) => (error: unknown) => (error as { code?: string }).code === value;

test('strict authenticated same-origin API returns confirmed snapshots without catalog/native mutation', async () => {
  const f = await fixture(), partner = await f.createPartner();
  let authorized = true, origin = '';
  const auth = { close() {}, authorize: (req: import('node:http').IncomingMessage) => authorized && req.headers.authorization === 'synthetic-owner', sameOrigin: (req: import('node:http').IncomingMessage) => req.headers.origin === origin && req.headers['sec-fetch-site'] !== 'cross-site', get origin() { return origin; } } as unknown as AuthStore;
  const app = createWebServer(partner, join(f.directory, 'assets'), { auth });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { authorization: 'synthetic-owner', origin, 'content-type': 'application/json' };
  const request = (method = 'GET', input?: unknown, extra = {}) => fetch(origin + '/api/chat/models', { method, headers: { ...headers, ...extra }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
  try {
    assert.equal((await request('GET', undefined, { authorization: '' })).status, 401);
    assert.equal((await request('GET', undefined, { origin: 'https://other.invalid' })).status, 403);
    assert.equal((await request('POST', selection(), { origin: '' })).status, 403);
    assert.equal((await request('POST', selection(), { 'sec-fetch-site': 'cross-site' })).status, 403);
    const initial = await request(); assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await initial.json(), { sessionId: 'thread-fake', currentModel: sol, fast: true, busy: false });
    assert.equal((await request('DELETE')).status, 405);
    for (const patch of [{ extra: true }, { fast: 'true' }, { expectedFast: null }, { fast: undefined }, { expectedFast: undefined }, { model: '' }, { expectedModel: ' x ' }, { sessionId: 'x'.repeat(301) }, { model: 'x\ny' }, { model: 'x'.repeat(201) }, { model: null }]) {
      const response = await request('POST', { ...selection(), ...patch });
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'invalid_request');
    }
    const unsupported = await request('POST', selection('arbitrary-model'));
    assert.equal(unsupported.status, 400); assert.equal((await unsupported.json()).error.code, 'invalid_model');
    for (const input of [selection(sol, 'outdated'), selection(sol, sol, 'wrong-thread'), selection(sol, sol, 'thread-fake', true, false)]) {
      const response = await request('POST', input); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'stale_model');
    }
    assert.equal((await request('POST', selection(), { 'content-type': 'text/plain' })).status, 400);
    for (const model of [sol, 'gpt-5.6-sol', terra]) {
      const before = await partner.models();
      const response = await request('POST', selection(model, before.currentModel));
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { sessionId: 'thread-fake', currentModel: model, fast: true, busy: false });
    }
    assert.equal((await request('POST', selection(terra, terra))).status, 200);
    for (const fast of [false, true]) {
      const before = await partner.models();
      const response = await request('POST', selection(before.currentModel, before.currentModel, before.sessionId, fast, before.fast));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ...before, fast });
    }
    authorized = false; assert.equal((await request()).status, 401);
    assert.equal((await f.requests()).some(r => r.method === 'model/list' || r.method === 'turn/start'), false);
  } finally { await app.close(); await f.close(); }
});

test('model and Fast persist on explicit native turns and same-thread resume', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  await eventually(async () => !(await partner.models()).busy);
  try {
    await partner.selectModel(selection(terra, sol, 'thread-fake', false), allowed, commit);
    const id = crypto.randomUUID(); await partner.submit(id, 'first selected model');
    await eventually(async () => (await partner.snapshot()).results.some(r => r.sourceIds.includes(id) && r.answers.length > 0));
    const before = await partner.snapshot();
    const start = (await f.requests()).find(r => r.method === 'turn/start')!;
    assert.equal((start.params as { model: string }).model, terra);
    assert.equal((start.params as { serviceTierForTurn: string }).serviceTierForTurn, 'default');
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.models()).currentModel, terra); assert.equal((await partner.models()).fast, false);
    assert.deepEqual((await partner.snapshot()).results, before.results);
    const resume = (await f.requests()).find(r => r.method === 'thread/resume')!;
    assert.equal((resume.params as { model: string }).model, terra);
    assert.equal((resume.params as { serviceTier: string }).serviceTier, 'default');
    assert.equal((resume.params as { threadId: string }).threadId, before.sessionId);
    await partner.selectModel(selection(sol, terra, 'thread-fake', true, false), allowed, commit);
    await partner.submit(crypto.randomUUID(), 'second selected model');
    const starts = (await f.requests()).filter(r => r.method === 'turn/start');
    assert.equal((starts.at(-1)!.params as { model: string }).model, sol);
    assert.equal((starts.at(-1)!.params as { serviceTierForTurn: string }).serviceTierForTurn, 'priority');
    assert.equal((await f.requests()).filter(r => r.method === 'thread/start').length, 1);
  } finally { await f.close(); }
});

test('busy turn, pending human admission, compaction, stale concurrent selection and revoked commit cannot change preference', async () => {
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner();
  try {
    const submission = partner.submit(crypto.randomUUID(), 'held');
    await assert.rejects(partner.selectModel(selection(), allowed, commit), code('model_busy'));
    await submission;
    assert.equal((await partner.models()).busy, true);
    await assert.rejects(partner.selectModel(selection(), allowed, commit), code('model_busy'));
    await f.holdProvider(false);
    await eventually(async () => !(await partner.models()).busy);
    const results = await Promise.allSettled([partner.selectModel(selection(sol, sol, 'thread-fake', false), allowed, commit), partner.selectModel(selection(terra), allowed, commit)]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    if (results[1].status === 'rejected') assert.equal(results[1].reason.code, 'stale_model');
    await partner.selectModel(selection(sol, sol, 'thread-fake', true, false), allowed, commit);
    await assert.rejects(partner.selectModel(selection(terra, sol), allowed, () => false), code('unauthorized'));
    let release!: () => void;
    const waiting = partner.selectModel(selection(terra, sol), async () => { await new Promise<void>(r => { release = r; }); return true; }, commit);
    await eventually(async () => !!release);
    const during = partner.submit(crypto.randomUUID(), 'arrived during authorization');
    release(); await assert.rejects(waiting, code('model_busy')); await during;
    await eventually(async () => !(await partner.models()).busy);
    await f.holdCompaction(true, true);
    const compact = partner.compact();
    await assert.rejects(partner.selectModel(selection(terra, sol), allowed, commit), code('model_busy'));
    await f.holdCompaction(false); await compact;
    assert.equal((await partner.models()).currentModel, sol);
  } finally { await f.holdCompaction(false); await f.close(); }
});

test('pending durable external input blocks preference even when native execution is unavailable', async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, '.lamplit'), { recursive: true });
  const store = new Store(partnerPaths(f.workspace).database);
  await store.admit('post:v1:pending-fixture', 'queued synthetic external input');
  await store.close();
  const partner = await f.createPartner();
  try {
    assert.equal((await partner.models()).busy, true);
    await assert.rejects(partner.selectModel(selection(), allowed, commit), code('model_busy'));
    assert.equal((await partner.models()).currentModel, sol);
  } finally { await f.close(); }
});

test('default preference is sol/Fast enabled; ignored config and malformed state or failed storage are visible', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'partner.toml');
    const base = 'name = "Test"\n[prompts]\npersona = "persona.md"\n';
    await writeFile(path, base);
    assert.equal('model' in (await loadConfig(path)).codex, false);
    assert.equal('fast' in (await loadConfig(path)).codex, false);
    for (const entry of ['model = "legacy"', 'fast = true', 'fast = false']) {
      await writeFile(path, base + '[codex]\n' + entry + '\n');
      const config = await loadConfig(path);
      assert.equal('model' in config.codex, false); assert.equal('fast' in config.codex, false);
    }
    const partner = await f.createPartner();
    await eventually(async () => !(await partner.models()).busy);
    assert.deepEqual(await partner.models(), { sessionId: 'thread-fake', currentModel: sol, fast: true, busy: false });
    const preference = join(f.workspace, '.lamplit', 'model-preference.json');
    await mkdir(preference);
    await assert.rejects(partner.selectModel(selection(terra, sol, 'thread-fake', false), allowed, commit), code('model_unavailable'));
    assert.equal((await partner.models()).currentModel, sol); assert.equal((await partner.models()).fast, true);
    assert.equal((await readdir(join(f.workspace, '.lamplit'))).some(name => name.endsWith('.tmp')), false);
    await rm(preference, { recursive: true }); await partner.close();
    for (const malformed of ['{bad-json', JSON.stringify({ model: sol }), JSON.stringify({ model: sol, fast: 'true' })]) {
      await writeFile(preference, malformed);
      await assert.rejects(f.createPartner(), code('model_unavailable'));
      assert.equal(await readFile(preference, 'utf8'), malformed);
    }
  } finally { await f.close(); }
});

test('staged atomic preference revalidates immediately before rename', async () => {
  const f = await fixture(); const path = join(f.directory, 'preference.json');
  try {
    await writeFile(path, JSON.stringify({ model: sol, fast: true }));
    let changed = false;
    await assert.rejects(saveModelPreference(path, { model: terra, fast: false }, () => { throw new Error('revoked at commit'); }, () => { changed = true; }), /revoked/);
    assert.equal(changed, false); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { model: sol, fast: true });
  } finally { await f.close(); }
});


test('Post lookup before native start is busy; Post, Keet and alarms explicitly use the saved model', async () => {
  const f = await fixture(), post = await postService();
  f.config.post = { endpoint: post.endpoint, agent_id: 'cfl' };
  f.credentials.post = post.token; f.credentials.post_receiver = post.receiver;
  f.config.keet = { endpoint: 'http://127.0.0.1:1' }; f.credentials.keet = 'test-only-keet';
  let clock = Date.parse('2026-11-03T00:00:00Z');
  const partner = await f.createPartner({ now: () => clock });
  try {
    await eventually(async () => !(await partner.models()).busy);
    await partner.selectModel(selection(), allowed, commit);
    post.conversationMode = 'stall-headers';
    const external = event('model-admission');
    await partner.ingestPost(external, JSON.stringify(external));
    await eventually(async () => post.conversationOpen > 0);
    assert.equal((await f.requests()).some(r => r.method === 'turn/start'), false);
    assert.equal((await partner.models()).busy, true);
    await assert.rejects(partner.selectModel(selection(terra, sol), allowed, commit), code('model_busy'));
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/start'));
    await eventually(async () => !(await partner.models()).busy);
    post.conversationMode = 'normal';
    await partner.ingestKeet({ type: 'message', eventId: 'model-keet', sequence: 1, messageId: { deviceId: 'test-peer', seq: 1 }, timestamp: 1, destination: { kind: 'dm', groupName: 'Test peer' }, senderLabel: 'Test peer', text: 'model selection external test', addressing: { mentionsIdentity: false } });
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/start').length === 2 && !(await partner.models()).busy);
    createAlarm(partnerPaths(f.workspace).alarms, 'model selection alarm test', { kind: 'once', at: new Date(clock + 1000).toISOString() }, clock);
    clock += 1000; await partner.checkAlarms();
    const starts = (await f.requests()).filter(r => r.method === 'turn/start');
    assert.equal(starts.length, 3);
    for (const request of starts) {
      assert.equal((request.params as { model: string }).model, sol);
      assert.equal((request.params as { serviceTierForTurn: string }).serviceTierForTurn, 'priority');
      assert.equal((request.params as { threadId: string }).threadId, 'thread-fake');
    }
    assert.equal(post.requests.some(r => r.tool === 'send_message'), false);
    await eventually(async () => !(await partner.models()).busy);
    let release!: () => void;
    const switching = partner.selectModel(selection(terra, sol), async () => { await new Promise<void>(r => { release = r; }); return true; }, commit);
    await eventually(async () => !!release);
    await partner.ingestKeet({ type: 'message', eventId: 'model-keet-race', sequence: 2, messageId: { deviceId: 'test-peer', seq: 2 }, timestamp: 2, destination: { kind: 'dm', groupName: 'Test peer' }, senderLabel: 'Test peer', text: 'arrived during selection', addressing: { mentionsIdentity: false } });
    release(); await assert.rejects(switching, code('model_busy'));
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/start').length === 4 && !(await partner.models()).busy);
    assert.equal((await partner.models()).currentModel, sol);
    assert.equal(((await f.requests()).filter(r => r.method === 'turn/start').at(-1)!.params as { model: string }).model, sol);
    let count = 4;
    for (const [fast, model] of [[false, terra], [true, sol]] as const) {
      const before = await partner.models();
      await partner.selectModel(selection(model, before.currentModel, before.sessionId, fast, before.fast), allowed, commit);
      const settle = async () => { count += 1; await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/start').length === count && !(await partner.models()).busy); };
      await partner.submit(crypto.randomUUID(), 'test next human tier'); await settle();
      const next = event(`tier-${fast}`); await partner.ingestPost(next, JSON.stringify(next)); await settle();
      await partner.ingestKeet({ type: 'message', eventId: `tier-keet-${fast}`, sequence: count, messageId: { deviceId: 'test-peer', seq: count }, timestamp: count, destination: { kind: 'dm', groupName: 'Test peer' }, senderLabel: 'Test peer', text: 'test next Keet tier', addressing: { mentionsIdentity: false } }); await settle();
      createAlarm(partnerPaths(f.workspace).alarms, 'test next alarm tier', { kind: 'once', at: new Date(clock + 1000).toISOString() }, clock);
      clock += 1000; await partner.checkAlarms(); await settle();
      for (const request of (await f.requests()).filter(r => r.method === 'turn/start').slice(-4)) {
        const params = request.params as Record<string, unknown>;
        assert.equal(params.model, model); assert.equal(params.serviceTierForTurn, fast ? 'priority' : 'default');
        assert.equal(params.threadId, 'thread-fake'); assert.equal('effort' in params, false);
      }
    }
    await partner.close();
    await assert.rejects(partner.models(), code('model_unavailable'));
    await assert.rejects(partner.selectModel(selection(terra, sol), allowed, commit), code('model_unavailable'));
  } finally { await f.close(); await post.close(); }
});

test('ambiguous durable human input blocks model/Fast through restart until native history reconciles it', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  const id = crypto.randomUUID(), text = 'synthetic unresolved human admission';
  try {
    await f.rejectStart(true);
    await assert.rejects(partner.submit(id, text));
    assert.equal((await partner.models()).busy, true);
    await assert.rejects(partner.selectModel(selection(terra, sol, 'thread-fake', false), allowed, commit), code('model_busy'));
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.models()).busy, true);
    await assert.rejects(partner.selectModel(selection(terra, sol, 'thread-fake', false), allowed, commit), code('model_busy'));
    assert.equal((await partner.models()).currentModel, sol);
    assert.equal((await partner.models()).fast, true);
    await partner.close();
    // A test-owned native history record, not a replay, resolves the uncertain identity.
    const state = await f.nativeState();
    state.turns.push({ id: 'reconciled-human-turn', status: 'completed', itemsView: 'full', items: [
      { type: 'userMessage', id: 'reconciled-user', clientId: id, content: [{ type: 'text', text }] },
      { type: 'agentMessage', id: 'reconciled-answer', text: 'test-owned reconciliation', phase: 'final_answer' },
    ] });
    await writeFile(f.appServer.env.FAKE_SERVER_STATE!, JSON.stringify(state));
    partner = await f.createPartner();
    assert.equal((await partner.models()).busy, false);
    const result = await partner.selectModel(selection(terra, sol, 'thread-fake', false), allowed, commit);
    assert.equal(result.currentModel, terra); assert.equal(result.fast, false);
    assert.equal((await partner.snapshot()).messages.filter(message => message.id === id).length, 1);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 1, 'reconciliation must not replay the input');
  } finally { await f.close(); }
});

test('conclusively rejected, replaced and observed inputs do not block model preferences as pending admissions', async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, '.lamplit'), { recursive: true });
  const store = new Store(partnerPaths(f.workspace).database);
  try {
    const rejected = crypto.randomUUID(), replaced = crypto.randomUUID(), observed = crypto.randomUUID();
    for (const id of [rejected, replaced, observed]) await store.admit(id, 'test-owned retained input');
    await store.markRejected([rejected], 'conclusive native rejection');
    await store.markOutcome(replaced, 'replaced');
    await store.markObserved(observed);
  } finally { await store.close(); }
  const partner = await f.createPartner();
  try {
    assert.equal((await partner.models()).busy, false);
    const result = await partner.selectModel(selection(terra), allowed, commit);
    assert.equal(result.currentModel, terra);
    assert.equal((await f.requests()).some(request => request.method === 'turn/start'), false);
  } finally { await f.close(); }
});


test('legacy TOML model/Fast cannot affect default or saved preference at startup', async () => {
  const f = await fixture();
  const path = join(f.directory, 'legacy-partner.toml');
  const base = `name = "Test"\nworkspace = ${JSON.stringify(f.workspace)}\nstate = ${JSON.stringify(f.directory)}\n[prompts]\npersona = ${JSON.stringify(f.config.prompts.persona)}\n`;
  try {
    for (const fast of [false, true]) {
      const source = base + `[codex]\ncommand = ${JSON.stringify(f.config.codex.command)}\nhome = ${JSON.stringify(f.config.codex.home)}\nmodel = "gpt-5.6-luna"\nfast = ${fast}\n`;
      await writeFile(path, source);
      Object.assign(f.config, await loadConfig(path));
      let partner = await f.createPartner();
      assert.equal((await partner.models()).currentModel, sol); assert.equal((await partner.models()).fast, true);
      await partner.selectModel(selection(terra, sol, 'thread-fake', false), allowed, commit);
      await partner.close();
      // Reparse the unchanged legacy values, then resume with saved opposite preferences.
      Object.assign(f.config, await loadConfig(path));
      partner = await f.createPartner();
      assert.equal((await partner.models()).currentModel, terra); assert.equal((await partner.models()).fast, false);
      const resume = (await f.requests()).filter(request => request.method === 'thread/resume').at(-1)!.params as Record<string, unknown>;
      assert.equal(resume.model, terra); assert.equal(resume.serviceTier, 'default');
      assert.equal(await readFile(path, 'utf8'), source, 'legacy TOML must not be rewritten');
      await partner.close();
      await rm(join(f.workspace, '.lamplit', 'model-preference.json'));
    }
    const threads = (await f.requests()).filter(request => request.method === 'thread/start' || request.method === 'thread/resume');
    assert.deepEqual(threads.map(request => [(request.params as Record<string, unknown>).model, (request.params as Record<string, unknown>).serviceTier]), [[sol, 'priority'], [terra, 'default'], [sol, 'priority'], [terra, 'default']]);
  } finally { await f.close(); }
});
