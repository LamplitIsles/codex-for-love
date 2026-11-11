import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openChat } from '@lamplit/contracts/client';
import { validateA2UISurface, workspaceMediaUrl, type ChatView } from '@lamplit/contracts';
import { eventually } from './fixture.ts';
import { resetDevelopment, startDevelopment } from './frontend-development-host.ts';
import { developmentUiDemoTurn } from './frontend-development-ui.ts';

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
    const sampleAvatar = await readFile(new URL('./fixtures/frontend-development/companion-avatar.jpg', import.meta.url));
    const avatarPath = join(root, 'data', 'workspace', '.lamplit', 'profile', 'development-companion.jpg');
    const checkAvatar = async (expected: Buffer) => {
      const appearance = await (await fetch(host!.origin + '/api/chat/appearance')).json() as { companionName: string; companionAvatar?: string; userAvatar?: string };
      assert.equal(appearance.companionName, 'Mica');
      assert.equal(appearance.companionAvatar, '/api/avatars/companion');
      assert.equal(appearance.userAvatar, undefined);
      const response = await fetch(host!.origin + appearance.companionAvatar);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
      assert.equal((await fetch(host!.origin + '/api/avatars/user')).status, 404);
    };
    await checkAvatar(sampleAvatar);
    const messages = view!.messages;
    assert.equal(messages.length, 22);
    const surfaces = messages.filter(m => m.ui !== undefined).map(m => validateA2UISurface(m.ui));
    assert.deepEqual(surfaces.map(s => s.createSurface.surfaceId), ['dev-seaside', 'dev-small-moments']);
    assert.deepEqual(messages.flatMap((m, i) => m.ui === undefined ? [] : [i]), [18, 21]);
    const renderedImages: string[] = [];
    for (const surface of surfaces) {
      const components = surface.createSurface.components;
      const tabs = components.find(c => c.component === 'Tabs');
      const modal = components.find(c => c.component === 'Modal');
      assert.ok(tabs && tabs.tabs.length >= 2 && modal);
      assert.ok(components.some(c => c.component === 'Button' && c.id === modal.trigger && c.action.event.name === 'open_modal'));
      for (const component of components) if (component.component === 'Image') {
        const url = workspaceMediaUrl(component.url, 'image'); assert.ok(url);
        const response: Response = await fetch(host.origin + url); assert.equal(response.status, 200);
        const name = decodeURIComponent(component.url.slice('workspace:'.length)).split('/').at(-1)!;
        renderedImages.push(name);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(`./fixtures/frontend-development/${name}`, import.meta.url)));
      }
    }
    assert.deepEqual(renderedImages.sort(), ['cat.jpg', 'coffee.jpg', 'sea.jpg']);
    assert.deepEqual(messages.slice(0, 4).map(m => [m.role, m.text]), [
      ['user', '今天下班路上闻到咖啡香，突然想慢一点走。'],
      ['agent', '那就绕一点路吧。晚风刚好，路灯也刚亮。'],
      ['user', '这杯看起来不错。'],
      ['agent', '颜色好温暖。下次找个靠窗的位置，慢慢喝。'],
    ]);
    assert.ok(messages.some(m => m.text.includes('**发呆也值得排进日程**')));
    assert.ok(messages.some(m => m.text.includes('\n- 买面包')));
    assert.ok(messages.some(m => m.createdAt === Date.parse('2026-10-01T19:59:00Z')));
    assert.ok(messages.some(m => m.createdAt === Date.parse('2026-10-01T20:00:00Z')));
    const chatImages = messages.flatMap(m => m.images ?? []);
    assert.equal(chatImages.length, 3);
    const chatBytes = await Promise.all(chatImages.map(async image => {
      const response = await fetch(`${host!.origin}/api/chat/media/${image.attachmentId}/original`);
      assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
    }));
    assert.equal(new Set(chatBytes.map(bytes => bytes.toString('base64'))).size, 3);
    const input = { sessionId: view!.sessionId, cursor: null };
    assert.equal((await chat.relationship({ sessionId: input.sessionId })).current.affinity, 60);
    assert.equal((await chat.relationshipHistory(input)).records.length, 3);
    const diary = await chat.diaryList(input);
    assert.deepEqual(diary.entries, ['2026-10-02.md', '2026-10-01.md', '2026-09-30.md']);
    const diaryTexts = await Promise.all(diary.entries.map(name => chat.diaryRead({ sessionId: input.sessionId, name })));
    assert.ok(diaryTexts.every(entry => entry.status === 'found'));
    assert.equal(new Set(diaryTexts.map(entry => entry.status === 'found' ? entry.text : '')).size, 3);
    const album = await chat.album(input); assert.equal(album.images.length, 3);
    const albumBytes = await Promise.all(album.images.map(async image => {
      assert.ok(image.available && image.originalUrl);
      const response = await fetch(host!.origin + image.originalUrl);
      assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
    }));
    assert.deepEqual(new Set(albumBytes.map(bytes => bytes.toString('base64'))), new Set(chatBytes.map(bytes => bytes.toString('base64'))));
    const reminders = await chat.reminders({ sessionId: input.sessionId });
    assert.deepEqual(new Set(reminders.reminders.map(r => r.schedule.kind)), new Set(['once', 'interval', 'daily', 'weekly']));
    await chat.submit({ operationId: crypto.randomUUID(), text: '持久化测试消息' }).catch(() => {});
    await eventually(async () => view?.messages.some(m => m.text.includes('【模拟回复】这是本地开发夹具')) === true);
    chat.close(); client = undefined; await host.close(); host = undefined;
    // Simulate an older workspace: add the missing avatar without losing interaction data.
    await rm(avatarPath);
    host = await startDevelopment(root, 0); chat = await connect();
    await checkAvatar(sampleAvatar);
    assert.deepEqual(view!.messages.filter(m => m.ui !== undefined).map(m => validateA2UISurface(m.ui)), surfaces);
    assert.ok(view!.messages.some(m => m.text === '持久化测试消息'));
    assert.ok(view!.messages.some(m => m.text.includes('【模拟回复】这是本地开发夹具')));
    chat.close(); client = undefined; await host.close(); host = undefined;
    await resetDevelopment(root);
    host = await startDevelopment(root, 0); chat = await connect();
    await checkAvatar(sampleAvatar);
    assert.deepEqual(view!.messages.filter(m => m.ui !== undefined).map(m => validateA2UISurface(m.ui)), surfaces);
    assert.ok(view!.messages.some(m => m.text.includes('今天下班路上闻到咖啡香')));
    assert.equal(view!.messages.some(m => m.text === '持久化测试消息'), false);
    assert.equal((await chat.reminders({ sessionId: view!.sessionId })).reminders.length, 4);
    assert.equal(await readFile(join(parent, 'real-data'), 'utf8'), 'untouched');
    chat.close(); client = undefined; await host.close(); host = undefined;
    // A previously selected development avatar survives startup unchanged.
    const chosenAvatar = await readFile(new URL('./fixtures/frontend-development/coffee.jpg', import.meta.url));
    await writeFile(avatarPath, chosenAvatar);
    host = await startDevelopment(root, 0); await checkAvatar(chosenAvatar);
    await host.close(); host = undefined;
    await symlink(join(parent, 'real-data'), join(root, 'data', 'workspace', 'unsafe-link'));
    await assert.rejects(startDevelopment(root, 0), /Unsafe development data entry/);
    assert.equal(await readFile(join(parent, 'real-data'), 'utf8'), 'untouched');
    await rm(join(root, 'data', 'workspace', 'unsafe-link'));
    await symlink(parent, join(parent, 'link'));
    await assert.rejects(resetDevelopment(join(parent, 'link')));
  } finally { client?.close(); await host?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('a stopped fixture can append example UI without replacing chat or background', { timeout: 30000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cfl-ui-import-')), root = join(parent, 'dev');
  let host: Awaited<ReturnType<typeof startDevelopment>> | undefined;
  let chat: Awaited<ReturnType<typeof openChat>> | undefined;
  let view: ChatView | undefined;
  try {
    host = await startDevelopment(root, 0);
    chat = await openChat(new WebSocket(host.origin.replace('http', 'ws') + '/api/chat/socket'), v => { view = v; }, () => {});
    await chat.submit({ operationId: crypto.randomUUID(), text: '保留这条消息' }).catch(() => {});
    await eventually(async () => view?.messages.some(m => m.text.includes('【模拟回复】这是本地开发夹具')) === true);
    const source = await readFile(new URL('./fixtures/frontend-development/coffee.jpg', import.meta.url));
    const upload = await fetch(host.origin + '/api/background-settings/landscape', { method: 'POST', headers: { origin: host.origin, 'content-type': 'image/jpeg' }, body: new Uint8Array(source) });
    assert.equal(upload.status, 200);
    const background = Buffer.from(await (await fetch(host.origin + '/api/backgrounds/landscape')).arrayBuffer());
    chat.close(); chat = undefined; await host.close(); host = undefined;
    const path = join(root, 'data', 'fake-state.json');
    const state = JSON.parse(await readFile(path, 'utf8')) as { turns: Array<{ id: string; items: Array<{ id: string }> }> };
    // Simulate a fixture seeded before these examples, then append a new native turn.
    for (const turn of state.turns) turn.items = turn.items.filter(item => !['dev-ui-0', 'dev-ui-1'].includes(item.id));
    const previous = structuredClone(state.turns);
    const demo = developmentUiDemoTurn(Date.now());
    assert.equal(state.turns.some(turn => turn.id === demo.id), false);
    state.turns.push(demo); await writeFile(path + '.new', JSON.stringify(state)); await rename(path + '.new', path);
    host = await startDevelopment(root, 0);
    chat = await openChat(new WebSocket(host.origin.replace('http', 'ws') + '/api/chat/socket'), v => { view = v; }, () => {});
    assert.ok(view!.messages.some(m => m.text === '保留这条消息'));
    assert.deepEqual(view!.messages.filter(m => m.ui !== undefined).map(m => validateA2UISurface(m.ui).createSurface.surfaceId), ['dev-seaside', 'dev-small-moments']);
    assert.deepEqual(Buffer.from(await (await fetch(host.origin + '/api/backgrounds/landscape')).arrayBuffer()), background);
    const after = JSON.parse(await readFile(path, 'utf8')) as { turns: unknown[] };
    assert.deepEqual(after.turns.slice(0, previous.length), previous);
  } finally { chat?.close(); await host?.close(); await rm(parent, { recursive: true, force: true }); }
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
