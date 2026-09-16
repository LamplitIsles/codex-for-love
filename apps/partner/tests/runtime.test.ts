import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { compactionPrompt } from '../runtime/prompts.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
const photo = { type: 'image' as const, mediaType: 'image/png' as const, name: 'steer.png', data: png };
const secondPhoto = { type: 'image' as const, mediaType: 'image/png' as const, name: 'second-steer.png', data: png };

test('workspace avatar files are projected without copying them into session state', async () => {
  const f = await fixture();
  const companion = join(f.workspace, '.lamplit', 'companion.png');
  const user = join(f.workspace, '.lamplit', 'user.png');
  await (await import('node:fs/promises')).mkdir(join(f.workspace, '.lamplit'), { recursive: true });
  await writeFile(companion, Buffer.from(png, 'base64'));
  await writeFile(user, Buffer.from(png, 'base64'));
  f.config.avatars = { companion, user };
  const partner = await f.createPartner();
  try {
    const snapshot = await partner.snapshot();
    assert.deepEqual(snapshot.avatars, { companion: '/api/avatars/companion', user: '/api/avatars/user' });
    assert.equal(partner.avatar('companion')?.mediaType, 'image/png');
    assert.deepEqual(partner.avatar('user')?.data, Buffer.from(png, 'base64'));
  } finally { await f.close(); }
});

test('official app-server owns the thread, native turns and history across an ordinary resume', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  try {
    const id = randomUUID(); await partner.submit(id, 'hello from the Companion');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.answers.length > 0) === true);
    const before = await partner.snapshot();
    assert.equal(before.messages[0]?.input, 'hello from the Companion');
    assert.match(before.results?.find((result) => result.sourceIds.includes(id))?.answers.join('\n\n') ?? '', /^fixture reply/);
    assert.equal('answer' in before.messages[0]!, false);
    assert.equal('error' in before.messages[0]!, false);
    assert.equal('images' in before.messages[0]!, false);
    assert.equal((JSON.parse(await readFile(join(f.workspace, '.lamplit', 'context-bootstrap.json'), 'utf8')) as { startupPending: boolean }).startupPending, false);
    const requests = await f.requests();
    const start = requests.find((request) => request.method === 'thread/start');
    assert(start);
    assert.match(String((start.params as Record<string, unknown>).baseInstructions), /You are a companion/);
    assert.match(String((start.params as Record<string, unknown>).baseInstructions), /Mica/);
    assert.doesNotMatch(JSON.stringify(start.params), /compact_prompt/);
    assert.equal('dynamicTools' in (start.params as Record<string, unknown>), false);
    assert.equal((await f.requests()).filter((request) => String(request.method).includes('thread/queue')).length, 0);
    await partner.close();
    partner = await f.createPartner();
    const resumed = await partner.snapshot();
    assert.equal(resumed.messages.length, 1);
    assert.deepEqual(resumed.results?.find((result) => result.sourceIds.includes(id))?.answers, before.results?.find((result) => result.sourceIds.includes(id))?.answers);
    const afterResumeId = randomUUID();
    await partner.submit(afterResumeId, 'post-resume submission');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(afterResumeId) && result.answers.length > 0) === true);
    assert.equal((await f.requests()).filter((request) => request.method === 'thread/start').length, 1);
    assert.equal((await f.requests()).filter((request) => request.method === 'thread/resume').length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('a transient event snapshot cannot re-admit a known message or block the next send', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_TRANSIENT_MESSAGE_CONFLICT = 'true';
  const partner = await f.createPartner();
  try {
    const first = randomUUID();
    await partner.submit(first, 'locally admitted source remains authoritative');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(first) && result.answers.length > 0) === true);
    const reconciled = await partner.snapshot();
    assert.equal(reconciled.messages.filter((message) => message.id === first).length, 1);
    assert.equal(reconciled.messages.find((message) => message.id === first)?.input, 'locally admitted source remains authoritative');
    assert.equal(reconciled.storageError, false);

    const second = randomUUID();
    await partner.submit(second, 'the Partner remains sendable');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(second) && result.answers.length > 0) === true);
    assert.equal((await partner.snapshot()).storageError, false);
  } finally { await partner.close(); await f.close(); }
});

test('startup waits only for the bundled Companion MCP and ignores optional MCP failures', async () => {
  const f = await fixture();
  const status = (name: string, runtimeStatus: string, toolsError: string | null = null) => ({ name, runtimeStatus, pluginId: null, serverInfo: null, tools: {}, toolsError, resources: [], resourceTemplates: [], authStatus: 'notLoggedIn' });
  f.appServer.env!.FAKE_MCP_STATUS_PAGES = JSON.stringify([[status('companion', 'connected'), status('flicknote', 'disabled')], [status('project', 'notStarted'), status('web', 'connected', 'discovery failed')]]);
  try {
    await f.createPartner();
    const requests = await f.requests(); const start = requests.findIndex((request) => request.method === 'thread/start'); const statuses = requests.filter((request) => request.method === 'mcpServerStatus/list');
    assert.equal(statuses.length, 2); assert.equal(requests.findIndex((request) => request.method === 'mcpServerStatus/list') > start, true);
    assert.equal(statuses.every((request) => (request.params as { threadId?: string }).threadId === 'thread-fake'), true);
  } finally { await f.close(); }
  const starting = await fixture();
  starting.appServer.env!.FAKE_MCP_STATUS_PAGES = JSON.stringify([[
    [status('companion', 'starting'), status('flicknote', 'disabled')], [status('project', 'notStarted'), status('web', 'connected', 'discovery failed')],
  ], [
    [status('companion', 'connected'), status('flicknote', 'disabled')], [status('project', 'notStarted'), status('web', 'connected', 'discovery failed')],
  ]]);
  try { await starting.createPartner(); const statuses = (await starting.requests()).filter((request) => request.method === 'mcpServerStatus/list'); assert.equal(statuses.length, 4); assert.equal(statuses.every((request) => (request.params as { threadId?: string }).threadId === 'thread-fake'), true); } finally { await starting.close(); }
  const failed = await fixture();
  failed.appServer.env!.FAKE_MCP_STATUS_PAGES = JSON.stringify([[status('companion', 'disabled'), status('flicknote', 'connected')], [status('project', 'connected'), status('web', 'connected')]]);
  try { await assert.rejects(failed.createPartner(), /companion/); } finally { await failed.close(); }
});

test('local compaction sends the existing Owner prompt and override on start and resume', async () => {
  const f = await fixture();
  await f.enableLocalCompaction();
  let partner = await f.createPartner();
  try {
    const start = (await f.requests()).find((request) => request.method === 'thread/start');
    assert(start);
    assert.equal((start.params as { config: Record<string, unknown> }).config.compact_prompt, compactionPrompt);
    assert.equal((start.params as { config: Record<string, unknown> }).config.experimental_local_compaction, true);

    await partner.close();
    partner = await f.createPartner();
    const resume = (await f.requests()).find((request) => request.method === 'thread/resume');
    assert(resume);
    assert.equal((resume.params as { config: Record<string, unknown> }).config.compact_prompt, compactionPrompt);
    assert.equal((resume.params as { config: Record<string, unknown> }).config.experimental_local_compaction, true);
  } finally {
    await partner.close();
    await f.close();
  }
});

test('an active native turn receives ordered steering inputs without a second turn', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID();
    await partner.submit(first, 'first turn input');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'second steering input');
    await eventually(async () => {
      const view = await partner.snapshot();
      return view.messages.some((message) => message.id === second && message.delivery === 'pending');
    });
    const requests = await f.requests();
    assert.equal(requests.filter((request) => request.method === 'turn/start' && (request.params as { clientUserMessageId?: string }).clientUserMessageId === first).length, 1);
    assert.equal(requests.filter((request) => request.method === 'turn/steer').length, 1);
    assert.equal((requests.find((request) => request.method === 'turn/steer')!.params as { expectedTurnId: string }).expectedTurnId, 'turn-1');
    await f.holdProvider(false);
    await eventually(async () => {
      const view = await partner.snapshot();
      return view.messages.every((message) => message.delivery === 'acknowledged');
    });
    const view = await partner.snapshot();
    assert.equal(view.messages.length, 2);
    assert.equal(view.results?.filter((result) => result.answers.length > 0).length, 1);
    assert.equal(view.results?.[0]?.sourceIds.join(','), `${first},${second}`);
    assert.equal((await f.requests()).filter((request) => String(request.method).includes('thread/queue')).length, 0);
  } finally { await partner.close(); await f.close(); }
});

test('retired acknowledged bodies still project normal steer sources after repeated snapshots and restart', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID();
    await partner.submit(first, 'normal first source');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'normal second\nwith a line');
    await f.holdProvider(false);
    await eventually(async () => (await partner.snapshot()).messages.every((message) => message.delivery === 'acknowledged'));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = await partner.snapshot();
      assert.deepEqual(view.messages.map((message) => [message.id, message.input]), [
        [first, 'normal first source'],
        [second, 'normal second\nwith a line'],
      ]);
      assert.deepEqual(view.results?.[0]?.sourceIds, [first, second]);
    }
    await partner.close();
    const store = new Store(partnerPaths(f.workspace).database);
    try {
      assert.equal(await store.inputPayload(first), undefined);
      assert.equal(await store.inputPayload(second), undefined);
      assert.equal((await store.inputSegment(first))?.segment_index, 0);
      assert.equal((await store.inputSegment(second))?.segment_index, 0);
    } finally { await store.close(); }
    partner = await f.createPartner();
    const reopened = await partner.snapshot();
    assert.deepEqual(reopened.messages.map((message) => [message.id, message.input]), [
      [first, 'normal first source'],
      [second, 'normal second\nwith a line'],
    ]);
    assert.equal(reopened.results?.filter((result) => result.answers.length > 0).length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('a stale steer target retries once with the reported active turn and does not duplicate input', async () => {
  const f = await fixture(); f.appServer.env!.FAKE_STEER_MISMATCH_COUNT = '1'; const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID();
    await partner.submit(first, 'first input');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'retry this steer');
    const steerRequests = (await f.requests()).filter((request) => request.method === 'turn/steer');
    assert.equal(steerRequests.length, 2);
    assert.equal((steerRequests[0]!.params as { expectedTurnId: string }).expectedTurnId, 'turn-1');
    assert.equal((steerRequests[1]!.params as { expectedTurnId: string }).expectedTurnId, 'turn-1');
    await f.holdProvider(false);
    await eventually(async () => (await partner.snapshot()).messages.every((message) => message.delivery === 'acknowledged'));
    const view = await partner.snapshot();
    assert.equal(view.messages.length, 2);
    assert.equal(view.results?.[0]?.sourceIds.join(','), `${first},${second}`);
  } finally { await partner.close(); await f.close(); }
});

test('a completed steer target starts the submitted input once without replaying the turn', async () => {
  const f = await fixture(); f.appServer.env!.FAKE_NO_ACTIVE_STEER_COUNT = '1'; const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID();
    await partner.submit(first, 'finished target');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'fresh after target');
    const requests = await f.requests();
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 2);
    assert.equal(requests.filter((request) => request.method === 'turn/steer').length, 1);
    await f.holdProvider(false);
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(second) && result.answers.length > 0) === true);
    const view = await partner.snapshot();
    assert.equal(view.messages.length, 2);
    assert.equal(view.results?.some((result) => result.sourceIds.includes(second) && result.answers.length > 0), true);
  } finally { await partner.close(); await f.close(); }
});

test('definitively rejected steers merge in order into one eligible native turn', async () => {
  const f = await fixture(); f.appServer.env!.FAKE_REJECT_STEER = 'true'; const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID(); const third = randomUUID();
    await partner.submit(first, 'regular input');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'rejected one', [photo]);
    await partner.submit(third, 'rejected two', [photo]);
    assert.equal((await partner.snapshot()).messages.filter((message) => message.id === second || message.id === third).every((message) => message.delivery === 'queued'), true);
    await f.holdProvider(false);
    await eventually(async () => {
      const view = await partner.snapshot();
      return view.messages.length === 3 && view.messages.every((message) => message.delivery === 'acknowledged');
    });
    const requests = await f.requests();
    const starts = requests.filter((request) => request.method === 'turn/start');
    assert.equal(starts.length, 2);
    assert.equal((starts[1]!.params as { clientUserMessageId: string }).clientUserMessageId, `merged:${second},${third}`);
    const mergedInput = (starts[1]!.params as { input: { type: string }[] }).input;
    assert.equal(mergedInput.filter((item) => item.type === 'localImage').length, 2);
    const view = await partner.snapshot();
    assert.equal(view.results?.filter((result) => result.answers.length > 0).length, 2);
    assert.equal(view.results?.at(-1)?.sourceIds.join(','), `${second},${third}`);
    assert.equal(view.messages.find((message) => message.id === second)?.inputImages.length, 1);
    assert.equal(view.messages.find((message) => message.id === third)?.inputImages.length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('a completed turn rejects a final merged-source mismatch even for admitted messages', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  const f = await fixture();
  f.appServer.env!.FAKE_REJECT_STEER = 'true';
  f.appServer.env!.FAKE_FINAL_MERGED_CONFLICT = 'true';
  const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    await partner.submit(randomUUID(), 'base turn');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(randomUUID(), 'merged source one');
    await partner.submit(randomUUID(), 'merged source two');
    await f.holdProvider(false);
    await eventually(async () => lines.some((line) => line.includes('protocol_reconcile_failed') && line.includes('turn/completed')));
    assert.equal(lines.some((line) => line.includes('final conflicting snapshot')), false);
  } finally {
    console.error = original;
    await partner.close();
    await f.close();
  }
});

test('retired acknowledged bodies reconstruct multiline and image-only merged sources after restart', async () => {
  const f = await fixture(); f.appServer.env!.FAKE_REJECT_STEER = 'true'; let partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID(); const third = randomUUID();
    await partner.submit(first, 'merged base');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'first line\nsecond line', [photo]);
    await partner.submit(third, '', [secondPhoto]);
    await f.holdProvider(false);
    await eventually(async () => {
      const view = await partner.snapshot();
      return view.messages.length === 3 && view.messages.every((message) => message.delivery === 'acknowledged');
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = await partner.snapshot();
      assert.deepEqual(view.messages.map((message) => [message.id, message.input]), [
        [first, 'merged base'],
        [second, 'first line\nsecond line'],
        [third, ''],
      ]);
      assert.equal(view.messages.find((message) => message.id === second)?.inputImages.length, 1);
      assert.equal(view.messages.find((message) => message.id === third)?.inputImages.length, 1);
      assert.deepEqual(view.results?.at(-1)?.sourceIds, [second, third]);
      assert.equal(view.results?.filter((result) => result.answers.length > 0).length, 2);
    }
    await partner.close();
    const store = new Store(partnerPaths(f.workspace).database);
    try {
      assert.equal(await store.inputPayload(first), undefined);
      assert.equal(await store.inputPayload(second), undefined);
      assert.equal(await store.inputPayload(third), undefined);
      assert.equal((await store.inputSegment(second))?.text_length, 'first line\nsecond line'.length);
      assert.equal((await store.inputSegment(third))?.text_length, 0);
      assert.equal((await store.inputSegment(third))?.text_offset, 'first line\nsecond line'.length + 1);
    } finally { await store.close(); }
    partner = await f.createPartner();
    const reopened = await partner.snapshot();
    assert.deepEqual(reopened.messages.map((message) => [message.id, message.input]), [
      [first, 'merged base'],
      [second, 'first line\nsecond line'],
      [third, ''],
    ]);
    assert.equal(reopened.messages.find((message) => message.id === second)?.inputImages.length, 1);
    assert.equal(reopened.messages.find((message) => message.id === third)?.inputImages.length, 1);
    assert.equal(reopened.results?.filter((result) => result.answers.length > 0).length, 2);
  } finally { await partner.close(); await f.close(); }
});

test('stop interrupts the turn and restores an unacknowledged steer as an editable draft', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_HOLD_METHOD = 'turn/steer';
  const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID();
    await partner.submit(first, 'committed input');
    await eventually(async () => (await partner.snapshot()).typing);
    const pendingSteer = partner.submit(second, 'draft after stop', [photo]);
    await eventually(async () => (await f.requests()).some((request) => request.method === 'turn/steer'));
    const activeTurn = (await partner.snapshot()).cancellable[0];
    assert(activeTurn);
    await partner.cancel(activeTurn);
    const stopped = await partner.snapshot();
    assert.equal(stopped.typing, false);
    assert.equal(stopped.draft?.sourceIds.join(','), second);
    assert.equal(stopped.draft?.input, 'draft after stop');
    assert.equal(stopped.draft?.images.length, 1);
    assert.equal(stopped.draft?.images[0]?.name, 'steer.png');
    assert.equal(stopped.messages.find((message) => message.id === first)?.delivery, 'acknowledged');
    assert.equal(stopped.results?.find((result) => result.sourceIds.includes(first))?.status, 'interrupted');
    assert.equal(stopped.results?.some((result) => result.sourceIds.includes(second)), false);
    await partner.close();
    const store = new Store(partnerPaths(f.workspace).database);
    try { assert.equal(await store.outcome(first), undefined); } finally { await store.close(); }
    await assert.rejects(pendingSteer, /closed|closing|aborted|timed out/i);
  } finally { await f.close(); }
});

test('resume hydrates interrupted drafts without submitting them, then permits a deliberate fresh turn', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_HOLD_METHOD = 'turn/steer';
  let partner = await f.createPartner();
  const first = randomUUID(); const second = randomUUID();
  try {
    await f.holdProvider(true);
    await partner.submit(first, 'interrupted source');
    await eventually(async () => (await partner.snapshot()).typing);
    const pending = partner.submit(second, 'recover on reopen');
    await eventually(async () => (await f.requests()).some((request) => request.method === 'turn/steer'));
    await partner.cancel((await partner.snapshot()).cancellable[0]!);
    await partner.close();
    await assert.rejects(pending, /closed|closing|aborted|timed out/i);
    f.appServer.env!.FAKE_HOLD_METHOD = '';
    await f.holdProvider(false);
    partner = await f.createPartner();
    const reopened = await partner.snapshot();
    assert.equal(reopened.draft?.sourceIds.join(','), second);
    assert.equal(reopened.draft?.input, 'recover on reopen');
    assert.equal(reopened.results?.some((result) => result.sourceIds.includes(second)), false);
    const startCount = (await f.requests()).filter((request) => request.method === 'turn/start').length;
    assert.equal(startCount, 1);
    const next = randomUUID();
    await partner.submit(next, 'deliberate continuation');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(next) && result.answers.length > 0) === true);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 2);
  } finally { await partner.close(); await f.close(); }
});

test('native compact lifecycle, zero token observation and post-compact bootstrap are projected', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  try {
    const id = randomUUID(); await partner.submit(id, 'before compact');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.answers.length > 0) === true);
    await partner.compact();
    const view = await partner.snapshot();
    assert.equal(view.compactions.length, 1);
    assert.equal(view.compactions[0]?.anchorId, id);
    assert.equal(view.compactions[0]?.position, 'after');
    assert.deepEqual(view.context, { activeTokens: 0, windowTokens: 200000 });
    assert.equal(view.lifecycle.latest?.status, 'complete');
    const bootstrap = JSON.parse(await readFile(join(f.workspace, '.lamplit', 'context-bootstrap.json'), 'utf8')) as { compact: string; startupPending: boolean };
    assert.equal(bootstrap.startupPending, false);
    assert.match(bootstrap.compact, /<companion-context>/);
    assert.match(bootstrap.compact, /before compact/);
    assert.doesNotMatch(bootstrap.compact, /## The User/);
  } finally { await partner.close(); await f.close(); }
});

test('missing native image artifacts remain a durable local input error', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  try {
    const id = randomUUID(); await partner.submit(id, 'generate image with missing image artifact');
    await eventually(async () => (await partner.snapshot()).messages[0]?.inputError === 'Native image artifact unavailable');
    const view = await partner.snapshot();
    assert.equal(view.results?.[0]?.status, 'completed');
    assert.equal(view.results?.[0]?.error, null);
    assert.equal(view.results?.[0]?.images.length, 0);
    assert.equal(view.messages[0]?.inputError, 'Native image artifact unavailable');
    assert.equal(view.storageError, true);
    await partner.close();
    const store = new Store(partnerPaths(f.workspace).database);
    try {
      const outcome = await store.outcome(id);
      assert.equal(outcome?.status, 'attachment-error');
      assert.equal(outcome?.error, 'Native image artifact unavailable');
    } finally { await store.close(); }
    partner = await f.createPartner();
    const reopened = await partner.snapshot();
    assert.equal(reopened.messages[0]?.inputError, 'Native image artifact unavailable');
    assert.equal(reopened.results?.[0]?.images.length, 0);
  } finally { await partner.close(); await f.close(); }
});

test('model changes resume the same thread and preserve history across restarts', async () => {
  const f = await fixture();
  let partner = await f.createPartner();
  try {
    await partner.submit(randomUUID(), 'keep this history when changing models');
    await eventually(async () => (await partner.snapshot()).results?.[0]?.status === 'completed');
    const before = await partner.snapshot();
    const markerPath = join(partnerPaths(f.workspace).managedRoot, 'thread.json');
    const original = JSON.parse(await readFile(markerPath, 'utf8'));
    await partner.close();
    f.config.codex.model = 'gpt-5.6-terra';
    partner = await f.createPartner();
    const resume = (await f.requests()).find((request) => request.method === 'thread/resume');
    assert.equal((resume?.params as Record<string, unknown>).threadId, original.threadId);
    assert.equal((resume?.params as Record<string, unknown>).model, 'gpt-5.6-terra');
    assert.deepEqual((await partner.snapshot()).messages, before.messages);
    assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), { threadId: original.threadId, model: 'gpt-5.6-terra' });
    await partner.close();
    partner = await f.createPartner();
    assert.equal((await f.requests()).filter((request) => request.method === 'thread/start').length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('missing native image capability fails explicitly', async () => {
  const unavailable = await fixture();
  unavailable.appServer.env.FAKE_IMAGE_CAPABILITY = 'false';
  await assert.rejects(unavailable.createPartner(), /does not advertise native imageGeneration/);
  await eventually(async () => (await readFile(unavailable.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
  await unavailable.close();
});
