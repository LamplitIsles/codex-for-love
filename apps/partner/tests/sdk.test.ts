import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AppServerConnectionClosedError,
  AppServerProtocolValidationError,
  AppServerRequestTimeoutError,
} from '@jaminzhou/codex-app-server-client';
import { fixture, eventually } from './fixture.ts';

test('SDK-owned stdio uses one handshake and the managed app-server argument vector', async () => {
  const f = await fixture();
  f.config.codex.home = join(f.directory, 'codex-home');
  const partner = await f.createPartner();
  try {
    const requests = await f.requests();
    assert.equal(requests.filter((request) => request.method === 'initialize').length, 1);
    assert.equal(requests.filter((request) => request.method === 'initialized').length, 1);
    assert.deepEqual(JSON.parse(await readFile(f.appServer.env!.FAKE_SERVER_ARGS!, 'utf8')), ['app-server', '--listen', 'stdio://']);
    const context = JSON.parse(await readFile(f.appServer.env!.FAKE_SERVER_CONTEXT!, 'utf8')) as { cwd: string; codexHome: string | null; sentinel: string | null };
    assert.equal(context.cwd, f.workspace);
    assert.equal(context.codexHome, f.config.codex.home);
    assert.equal(context.sentinel, 'preserved-by-sdk');
    assert.match(await readFile(f.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8'), /^running:/);
  } finally {
    await partner.close();
    await eventually(async () => (await readFile(f.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
    await f.close();
  }
});

test('wrong version and missing executable fail after SDK cleanup', async () => {
  const wrongVersion = await fixture();
  wrongVersion.appServer.env!.FAKE_SERVER_VERSION = '0.153.0';
  await assert.rejects(wrongVersion.createPartner(), /Unsupported Codex app-server version/);
  await eventually(async () => (await readFile(wrongVersion.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
  await wrongVersion.close();

  const unknownVersion = await fixture();
  unknownVersion.appServer.env!.FAKE_SERVER_VERSION = 'unparseable';
  await assert.rejects(unknownVersion.createPartner(), /Unsupported Codex app-server version/);
  await eventually(async () => (await readFile(unknownVersion.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
  await unknownVersion.close();

  const missing = await fixture();
  missing.config.codex.command = `${missing.directory}/does-not-exist/codex`;
  await assert.rejects(missing.createPartner(), /codex|executable|ENOENT|spawn/i);
  await missing.close();
});

test('local compaction rejects missing or mismatched selected-build provenance', async () => {
  const missing = await fixture();
  missing.config.codex.local_compaction = true;
  missing.config.codex.provenance = join(missing.directory, 'missing-provenance.json');
  await assert.rejects(missing.createPartner(), /provenance/i);
  await missing.close();

  const mismatch = await fixture();
  await mismatch.enableLocalCompaction();
  const provenancePath = mismatch.config.codex.provenance!;
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as Record<string, unknown>;
  provenance.sourceRevision = 'not-the-pinned-source';
  await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);
  await assert.rejects(mismatch.createPartner(), /provenance|sourceRevision|Codex/i);
  await mismatch.close();

  const helperMismatch = await fixture();
  await helperMismatch.enableLocalCompaction();
  await writeFile(join(helperMismatch.directory, 'codex-code-mode-host'), 'changed helper');
  await assert.rejects(helperMismatch.createPartner(), /code-mode host hash/);
  await helperMismatch.close();
});

test('process exit during startup fails the Partner and releases the SDK process', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_EXIT_AFTER_INITIALIZE = 'true';
  try {
    await assert.rejects(f.createPartner(), /closed|exited|app-server/i);
    await eventually(async () => (await readFile(f.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
  } finally {
    await f.close();
  }
});

test('strict SDK validation rejects a malformed known response', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_MALFORMED_METHOD = 'thread/turns/list';
  try {
    await assert.rejects(f.createPartner(), (error: unknown) => error instanceof AppServerProtocolValidationError);
  } finally {
    await f.close();
  }
});

test('history absence is narrowed to the official pre-first-message error', async () => {
  const benign = await fixture();
  benign.appServer.env!.FAKE_HISTORY_ERROR = 'thread thread-fake is not materialized yet; thread/turns/list is unavailable before first user message';
  benign.appServer.env!.FAKE_HISTORY_ERROR_CODE = '-32600';
  const partner = await benign.createPartner();
  try {
    assert.equal((await partner.snapshot()).messages.length, 0);
  } finally {
    await partner.close();
    await benign.close();
  }

  const transportFailure = await fixture();
  transportFailure.appServer.env!.FAKE_HISTORY_ERROR = 'thread history not found';
  try {
    await assert.rejects(transportFailure.createPartner(), /thread history not found/);
  } finally {
    await transportFailure.close();
  }
});

test('short SDK timeout leaves an unresolved native turn admission and close remains bounded', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_HOLD_METHOD = 'turn/start';
  f.appServer.requestTimeoutMs = 500;
  const partner = await f.createPartner();
  try {
    await assert.rejects(partner.submit(randomUUID(), 'timeout this turn admission'), (error: unknown) => error instanceof AppServerRequestTimeoutError);
  } finally {
    const started = Date.now();
    await partner.close();
    assert.equal(Date.now() - started < 2_000, true);
    await eventually(async () => (await readFile(f.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
    await f.close();
  }
});

test('accepted native start reconciles a dropped response without submitting a second turn', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_DROP_RESPONSE_METHOD = 'turn/start';
  f.appServer.requestTimeoutMs = 250;
  let partner = await f.createPartner();
  try {
    const id = randomUUID();
    await partner.submit(id, 'the start response may be lost');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.answer !== null) === true);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 1);
    await partner.close();
    partner = await f.createPartner();
    const reopened = await partner.snapshot();
    assert.equal(reopened.results?.some((result) => result.sourceIds.includes(id) && result.answer !== null), true);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 1);
  } finally {
    await partner.close();
    await f.close();
  }
});

test('accepted native steer reconciles a dropped response without duplicating the source input', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_DROP_RESPONSE_METHOD = 'turn/steer';
  f.appServer.requestTimeoutMs = 250;
  const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID();
    await partner.submit(first, 'active source');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'steer response may be lost');
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/steer').length, 1);
    await f.holdProvider(false);
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(second) && result.answer !== null) === true);
    const view = await partner.snapshot();
    assert.equal(view.messages.length, 2);
    assert.equal(view.results?.[0]?.sourceIds.join(','), `${first},${second}`);
  } finally {
    await partner.close();
    await f.close();
  }
});

test('pre-acceptance timeout remains an editable unresolved draft across reopen and requires deliberate replacement', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_HOLD_METHOD = 'turn/start';
  f.appServer.requestTimeoutMs = 250;
  let partner = await f.createPartner();
  const id = randomUUID();
  try {
    await assert.rejects(partner.submit(id, 'uncertain before acceptance'), (error: unknown) => error instanceof AppServerRequestTimeoutError);
    const unresolved = await partner.snapshot();
    assert.equal(unresolved.messages.find((message) => message.id === id)?.delivery, 'unresolved');
    assert.equal(unresolved.draft?.sourceIds.join(','), id);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 1);

    await partner.close();
    f.appServer.env!.FAKE_HOLD_METHOD = '';
    partner = await f.createPartner();
    const reopened = await partner.snapshot();
    assert.equal(reopened.draft?.sourceIds.join(','), id);
    assert.equal(reopened.messages.find((message) => message.id === id)?.delivery, 'unresolved');
    await assert.rejects(partner.submit(id, 'uncertain before acceptance'), /delivery is unresolved/);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 1);

    const replacement = randomUUID();
    await partner.submit(replacement, 'deliberate replacement', [], [id]);
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(replacement) && result.answer !== null) === true);
    const completed = await partner.snapshot();
    assert.equal(completed.messages.find((message) => message.id === id)?.delivery, 'replaced');
    assert.equal(completed.draft, undefined);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 2);
  } finally {
    await partner.close();
    await f.close();
  }
});

test('closing rejects an in-flight SDK RPC and a fresh Partner owns later events', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_HOLD_METHOD = 'turn/start';
  const first = await f.createPartner();
  let staleNotifications = 0;
  first.subscribe(() => { staleNotifications += 1; });
  const pending = first.submit(randomUUID(), 'close while turn admission waits');
  await eventually(async () => (await f.requests()).some((request) => request.method === 'turn/start' && (request.params as { clientUserMessageId?: string } | undefined)?.clientUserMessageId));
  const notificationsBeforeClose = staleNotifications;
  await first.close();
  await assert.rejects(pending, (error: unknown) => error instanceof AppServerConnectionClosedError || /closed|closing/i.test(error instanceof Error ? error.message : String(error)));

  f.appServer.env!.FAKE_HOLD_METHOD = '';
  const second = await f.createPartner();
  try {
    const id = randomUUID();
    await second.submit(id, 'please use the relationship tool');
    await eventually(async () => (await second.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.answer !== null) === true);
    assert.equal((await readFile(f.appServer.env!.FAKE_SERVER_STATE!, 'utf8')).includes('"toolCalls":1'), true);
    assert.equal(staleNotifications, notificationsBeforeClose);
  } finally {
    await second.close();
    await f.close();
  }
});
