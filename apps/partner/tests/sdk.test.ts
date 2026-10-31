import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AppServerConnectionClosedError,
  AppServerProtocolValidationError,
  AppServerRequestTimeoutError,
} from '@jaminzhou/codex-app-server-client';
import { fixture, eventually } from './fixture.ts';

test('CFL always launches the direct app-server with one managed handshake', async () => {
  const f = await fixture();
  f.config.codex.home = join(f.directory, 'codex-home');
  const partner = await f.createPartner();
  try {
    const requests = await f.requests();
    assert.equal(requests.filter((request) => request.method === 'initialize').length, 1);
    assert.equal(requests.filter((request) => request.method === 'initialized').length, 1);
    assert.deepEqual(JSON.parse(await readFile(f.appServer.env!.FAKE_SERVER_ARGS!, 'utf8')), ['--listen', `unix://${join(f.workspace, '.lamplit/run/codex.sock')}`]);
    const context = JSON.parse(await readFile(f.appServer.env!.FAKE_SERVER_CONTEXT!, 'utf8')) as { cwd: string; codexHome: string | null; sentinel: string | null };
    assert.equal(context.cwd, await realpath(f.workspace));
    assert.equal(context.codexHome, f.config.codex.home);
    assert.equal(context.sentinel, 'preserved-by-sdk');
    assert.match(await readFile(f.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8'), /^running:/);
  } finally {
    await partner.close();
    await eventually(async () => (await readFile(f.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
    await f.close();
  }
});

test('configured socket uses a private directory and is removed on normal close and restart', async () => {
  const f = await fixture();
  const path = join(f.directory, 'run', 'custom.sock');
  f.config.codex.socket_path = path;
  try {
    let partner = await f.createPartner();
    assert.deepEqual(JSON.parse(await readFile(f.appServer.env.FAKE_SERVER_ARGS!, 'utf8')), ['--listen', `unix://${path}`]);
    assert.equal((await lstat(join(f.directory, 'run'))).mode & 0o077, 0);
    await partner.close();
    await assert.rejects(lstat(path), { code: 'ENOENT' });
    partner = await f.createPartner();
    await partner.close();
    await assert.rejects(lstat(path), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('normal close waits for the managed server to drain beyond two seconds', async () => {
  const f = await fixture(); f.appServer.env.FAKE_SHUTDOWN_DELAY_MS = '3500';
  f.appServer.env.FAKE_SERVER_SIGNAL = join(f.directory, 'signal');
  const partner = await f.createPartner();
  let finished = false;
  const closing = partner.close().then(() => { finished = true; });
  try {
    await eventually(async () => { try { return await readFile(f.appServer.env.FAKE_SERVER_SIGNAL!, 'utf8') === 'SIGTERM'; } catch { return false; } });
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(finished, false);
    assert.match(await readFile(f.appServer.env.FAKE_SERVER_LIFECYCLE!, 'utf8'), /^running:/);
    await closing;
    assert.match(await readFile(f.appServer.env.FAKE_SERVER_LIFECYCLE!, 'utf8'), /^exited:\d+:0$/);
    await assert.rejects(lstat(join(f.workspace, '.lamplit/run/codex.sock')), { code: 'ENOENT' });
  } finally { await closing; await f.close(); }
});

test('abnormal child exit during shutdown is reported', async () => {
  const f = await fixture(); f.appServer.env.FAKE_SHUTDOWN_EXIT_CODE = '42';
  const partner = await f.createPartner();
  try {
    await assert.rejects(partner.close(), /exited abnormally during shutdown.*inspect its socket/);
  } finally { await f.close().catch(() => undefined); }
});

test('startup failure reports safely before waiting for a listener without its readiness log', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  const f = await fixture();
  f.appServer.env.FAKE_NO_LISTEN_LOG = 'true'; f.appServer.env.FAKE_SHUTDOWN_DELAY_MS = '3500';
  f.appServer.env.FAKE_SERVER_SIGNAL = join(f.directory, 'signal');
  f.appServer.requestTimeoutMs = 2000;
  let finished = false;
  const starting = f.createPartner().then(() => { throw new Error('unexpected startup'); }, error => { finished = true; return error; });
  try {
    await eventually(async () => { try { return await readFile(f.appServer.env.FAKE_SERVER_SIGNAL!, 'utf8') === 'SIGTERM'; } catch { return false; } });
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(finished, false);
    assert.ok(logs.some(line => line.includes('app_server.startup_failed') && line.includes('listen_timeout') && line.includes(join(f.workspace, '.lamplit/run/codex.sock'))));
    assert.ok(logs.every(line => !line.includes('private-fixture-stderr')));
    assert.match(await readFile(f.appServer.env.FAKE_SERVER_LIFECYCLE!, 'utf8'), /^running:/);
    assert.match(String(await starting), /Timed out waiting for Codex app-server socket/);
    assert.match(await readFile(f.appServer.env.FAKE_SERVER_LIFECYCLE!, 'utf8'), /^exited:\d+:0$/);
    await assert.rejects(lstat(join(f.workspace, '.lamplit/run/codex.sock')), { code: 'ENOENT' });
  } finally { await starting; await f.close(); }
});

test('startup and cleanup failures are both reported and preserved', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  const f = await fixture();
  f.appServer.env.FAKE_NO_LISTEN_LOG = 'true'; f.appServer.env.FAKE_SHUTDOWN_EXIT_CODE = '42';
  f.appServer.requestTimeoutMs = 2000;
  try {
    await assert.rejects(f.createPartner(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /Timed out waiting for Codex app-server socket/);
      assert.match(String(error.errors[1]), /exited abnormally during shutdown/);
      assert.equal(error.cause, error.errors[0]);
      return true;
    });
    assert.ok(logs.some(line => line.includes('app_server.startup_failed') && line.includes('listen_timeout')));
    assert.ok(logs.some(line => line.includes('app_server.startup_cleanup_failed') && line.includes('abnormal_exit')));
    assert.ok(logs.every(line => !line.includes('private-fixture-stderr')));
  } finally { await f.close(); }
});

test('existing paths, public directories, and overlong paths fail without changing them', async () => {
  const f = await fixture();
  try {
    const directory = join(f.directory, 'run'); await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'codex.sock'); f.config.codex.socket_path = path;
    await writeFile(path, 'other service');
    await assert.rejects(f.createPartner(), /socket path already exists/);
    assert.equal(await readFile(path, 'utf8'), 'other service');
    f.config.codex.socket_path = join(directory, 'missing.sock');
    await chmod(directory, 0o755);
    await assert.rejects(f.createPartner(), /directory must be owned.*private/);
    assert.equal((await lstat(directory)).mode & 0o777, 0o755);
    f.config.codex.socket_path = join(f.directory, 'x'.repeat(120));
    await assert.rejects(f.createPartner(), /shorter.*socket_path/);
  } finally { await f.close(); }
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

test('process exit during startup fails the Partner and releases the SDK process', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_EXIT_AFTER_INITIALIZE = 'true';
  try {
    await assert.rejects(f.createPartner());
    await eventually(async () => /exited:\d+:42$/.test(await readFile(f.appServer.env!.FAKE_SERVER_LIFECYCLE!, 'utf8')), 2_000);
    const path = join(f.workspace, '.lamplit/run/codex.sock');
    assert.equal((await lstat(path)).isSocket(), true);
    delete f.appServer.env.FAKE_EXIT_AFTER_INITIALIZE;
    await assert.rejects(f.createPartner(), /socket path already exists/);
    assert.equal((await lstat(path)).isSocket(), true);
  } finally {
    await f.close();
  }
});

test('connection loss stops the managed process without replaying an uncertain admission', async () => {
  const f = await fixture(); f.appServer.env.FAKE_DISCONNECT_METHOD = 'turn/start';
  const partner = await f.createPartner();
  try {
    await partner.submit(randomUUID(), 'uncertain admission');
    await eventually(async () => (await readFile(f.appServer.env.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'), 2_000);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/start').length, 1);
  } finally { await partner.close(); await f.close(); }
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
  // This SDK-wide deadline also covers process initialization, not just the held RPC.
  f.appServer.requestTimeoutMs = 2_000;
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

test('a successful voice tool artifact projects once with its durable same-origin URL and keeps final text separate', async () => {
  const f = await fixture(); await f.holdVoiceFinal(true); let partner = await f.createPartner();
  try {
    const id = randomUUID(); await partner.submit(id, 'please send voice');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.voices?.length === 1) === true);
    const first = await partner.snapshot(); const result = first.results!.find((entry) => entry.sourceIds.includes(id))!;
    assert.deepEqual(result.voices, [{ id: 'a'.repeat(64), url: `/api/audio/${'a'.repeat(64)}.mp3` }]); assert.equal(result.answers.length, 0);
    await f.holdVoiceFinal(false); await eventually(async () => (await partner.snapshot()).results?.find((entry) => entry.sourceIds.includes(id))?.answers.length === 1);
    await partner.close(); partner = await f.createPartner();
    const restored = await partner.snapshot(); assert.deepEqual(restored.results!.find((entry) => entry.sourceIds.includes(id))!.voices, result.voices);
  } finally { await partner.close(); await f.close(); }
});

test('accepted native start reconciles a dropped response without submitting a second turn', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_DROP_RESPONSE_METHOD = 'turn/start';
  f.appServer.requestTimeoutMs = 2_000;
  let partner = await f.createPartner();
  try {
    const id = randomUUID();
    await partner.submit(id, 'the start response may be lost');
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.answers.length > 0) === true);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 1);
    await partner.close();
    partner = await f.createPartner();
    const reopened = await partner.snapshot();
    assert.equal(reopened.results?.some((result) => result.sourceIds.includes(id) && result.answers.length > 0), true);
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 1);
  } finally {
    await partner.close();
    await f.close();
  }
});

test('accepted native steer reconciles a dropped response without duplicating the source input', async () => {
  const f = await fixture();
  f.appServer.env!.FAKE_DROP_RESPONSE_METHOD = 'turn/steer';
  f.appServer.requestTimeoutMs = 2_000;
  const partner = await f.createPartner();
  try {
    await f.holdProvider(true);
    const first = randomUUID(); const second = randomUUID();
    await partner.submit(first, 'active source');
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submit(second, 'steer response may be lost');
    assert.equal((await f.requests()).filter((request) => request.method === 'turn/steer').length, 1);
    await f.holdProvider(false);
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(second) && result.answers.length > 0) === true);
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
  f.appServer.requestTimeoutMs = 2_000;
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
    await eventually(async () => (await partner.snapshot()).results?.some((result) => result.sourceIds.includes(replacement) && result.answers.length > 0) === true);
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
    await eventually(async () => (await second.snapshot()).results?.some((result) => result.sourceIds.includes(id) && result.answers.length > 0) === true);
    assert.equal((await f.requests()).some((request) => request.method === 'thread/start'), true);
    assert.equal(staleNotifications, notificationsBeforeClose);
  } finally {
    await second.close();
    await f.close();
  }
});
