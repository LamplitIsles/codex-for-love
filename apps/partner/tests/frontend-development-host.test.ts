import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { eventually } from './fixture.ts';
import { resetDevelopment, startDevelopment } from './frontend-development-host.ts';

test('synthetic host persists real HTTP and WebSocket interactions and resets only its own stopped data', { timeout: 30000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cfl-frontend-dev-'));
  const root = join(parent, 'dev');
  let host: Awaited<ReturnType<typeof startDevelopment>> | undefined;
  let client: Awaited<ReturnType<typeof openChat>> | undefined;
  let view: ChatView | undefined;
  const connect = async () => {
    client = await openChat(new WebSocket(host!.origin.replace('http', 'ws') + '/api/chat/socket'), v => { view = v; }, () => {});
    return client;
  };
  try {
    await writeFile(join(parent, 'real-data'), 'untouched');
    await assert.rejects(resetDevelopment(parent));
    host = await startDevelopment(root, 0);
    await assert.rejects(resetDevelopment(root), /active/);
    let chat = await connect();
    assert.equal((await (await fetch(host.origin + '/api/auth/status')).json() as { state: string }).state, 'signed_in');
    assert.ok(view!.messages.some(m => m.text.includes('本地开发示例')));
    const input = { sessionId: view!.sessionId, cursor: null };
    assert.equal((await chat.relationship({ sessionId: input.sessionId })).current.affinity, 65);
    assert.ok((await chat.diaryList(input)).entries.length);
    const album = await chat.album(input); assert.ok(album.images.length);
    assert.equal((await fetch(host.origin + album.images[0]!.originalUrl)).status, 200);
    assert.equal((await chat.reminders({ sessionId: input.sessionId })).reminders.length, 4);
    await chat.submit({ operationId: crypto.randomUUID(), text: '持久化测试消息' });
    await eventually(async () => view?.messages.some(m => m.text.includes('【模拟回复】这是本地开发夹具')) === true);
    chat.close(); client = undefined; await host.close(); host = undefined;
    host = await startDevelopment(root, 0); chat = await connect();
    assert.ok(view!.messages.some(m => m.text === '持久化测试消息'));
    assert.ok(view!.messages.some(m => m.text.includes('【模拟回复】这是本地开发夹具')));
    chat.close(); client = undefined; await host.close(); host = undefined;
    await resetDevelopment(root);
    host = await startDevelopment(root, 0); chat = await connect();
    assert.ok(view!.messages.some(m => m.text.includes('本地开发示例')));
    assert.equal(view!.messages.some(m => m.text === '持久化测试消息'), false);
    assert.equal((await chat.reminders({ sessionId: view!.sessionId })).reminders.length, 4);
    assert.equal(await readFile(join(parent, 'real-data'), 'utf8'), 'untouched');
    chat.close(); client = undefined; await host.close(); host = undefined;
    await symlink(join(parent, 'real-data'), join(root, 'data', 'workspace', 'unsafe-link'));
    await assert.rejects(startDevelopment(root, 0), /Unsafe development data entry/);
    assert.equal(await readFile(join(parent, 'real-data'), 'utf8'), 'untouched');
    await rm(join(root, 'data', 'workspace', 'unsafe-link'));
    await symlink(parent, join(parent, 'link'));
    await assert.rejects(resetDevelopment(join(parent, 'link')));
  } finally { client?.close(); await host?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('failed reset blocks start until an explicit reset succeeds', { timeout: 30000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cfl-reset-failure-'));
  const root = join(parent, 'dev');
  let host: Awaited<ReturnType<typeof startDevelopment>> | undefined;
  try {
    await writeFile(join(parent, 'sentinel'), 'untouched');
    host = await startDevelopment(root, 0); await host.close(); host = undefined;
    await rm(join(root, 'data'), { recursive: true });
    await symlink(parent, join(root, 'data'));
    await assert.rejects(resetDevelopment(root), /symlinked/);
    await rm(join(root, 'data'));
    await assert.rejects(startDevelopment(root, 0), /Incomplete reset/);
    assert.equal(await readFile(join(parent, 'sentinel'), 'utf8'), 'untouched');
    await resetDevelopment(root);
    host = await startDevelopment(root, 0);
    assert.ok(await readFile(join(root, 'data', 'SEEDED'), 'utf8'));
  } finally { await host?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('filesystem deletion failure retains reset marker for recovery', { timeout: 30000, skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cfl-reset-eacces-'));
  const root = join(parent, 'dev'), protectedDir = join(root, 'data', 'protected');
  let host: Awaited<ReturnType<typeof startDevelopment>> | undefined;
  try {
    host = await startDevelopment(root, 0); await host.close(); host = undefined;
    await mkdir(protectedDir); await writeFile(join(protectedDir, 'file'), 'synthetic'); await chmod(protectedDir, 0o500);
    await assert.rejects(resetDevelopment(root), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
    await assert.rejects(startDevelopment(root, 0), /Incomplete reset/);
    await chmod(protectedDir, 0o700);
    await resetDevelopment(root);
    host = await startDevelopment(root, 0);
    assert.ok(await readFile(join(root, 'data', 'SEEDED'), 'utf8'));
  } finally { await chmod(protectedDir, 0o700).catch(() => {}); await host?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('interrupted partial reset blocks start and explicit reset recovers', { timeout: 60000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cfl-reset-interrupted-'));
  const root = join(parent, 'dev');
  let host: Awaited<ReturnType<typeof startDevelopment>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    host = await startDevelopment(root, 0); await host.close(); host = undefined;
    const moduleUrl = new URL('./frontend-development-host.ts', import.meta.url).href;
    // A test-owned filesystem fault pauses recursive deletion after one real subtree
    // is removed, so the child can be killed at a reproducible partial state.
    const script = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path'; const root = process.argv[1], realRm = fs.rm;
      fs.rm = async (path, options) => { if (path === join(root, 'data')) {
        await realRm(join(root, 'data', 'workspace', 'memory'), { recursive: true });
        process.send('partial'); await new Promise(() => {});
      } else return realRm(path, options); }; syncBuiltinESMExports();
      const { resetDevelopment } = await import(${JSON.stringify(moduleUrl)}); await resetDevelopment(root);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    assert.equal((await once(child, 'message'))[0], 'partial');
    assert.ok(await readFile(join(root, 'data', 'SEEDED'), 'utf8'));
    await assert.rejects(readFile(join(root, 'data', 'workspace', 'memory', '2026-10-02.md')), { code: 'ENOENT' });
    child.kill('SIGKILL');
    const [, signal] = await exited; assert.equal(signal, 'SIGKILL'); child = undefined;
    assert.ok(await readdir(join(root, 'RESETTING')));
    await assert.rejects(startDevelopment(root, 0), /active or has an uninspected stale lock/);
    // The child is confirmed dead; remove only its test-owned stale lock.
    await rm(join(root, 'LOCK'), { recursive: true });
    await assert.rejects(startDevelopment(root, 0), /Incomplete reset/);
    await resetDevelopment(root);
    host = await startDevelopment(root, 0);
    assert.ok(await readFile(join(root, 'data', 'SEEDED'), 'utf8'));
  } finally { child?.kill('SIGKILL'); await host?.close(); await rm(parent, { recursive: true, force: true }); }
});
