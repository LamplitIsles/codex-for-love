import { olderMessages, startMessages } from './history-test-helpers.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';

test('HTTP and Companion discover the same visible media across pages and restart', async () => {
  const f = await fixture(); f.appServer.env.FAKE_VOICE_COUNT = '35'; f.appServer.env.FAKE_VOICE_DUPLICATE = 'true';
  let partner = await f.createPartner(), authorized = true;
  let app = createWebServer(partner, join(f.directory, 'assets'), { authorize: (() => authorized) as unknown as () => Promise<boolean> });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let origin = `http://127.0.0.1:${(app.server.address() as {port: number}).port}`;
  const mcp = new Client({ name: 'media-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url)), f.workspace], stderr: 'ignore' }));
  type Item = { messageId: string; createdAt: number; voice?: {id:string}; file?: {attachmentId:string; name:string; availability:string} };
  type Page = { items: Item[]; nextCursor: string | null };
  const sessionId = (await partner.snapshot()).sessionId;
  const url = (kind: string, cursor?: string, session = sessionId) => `${origin}/api/conversation-media?${new URLSearchParams({ sessionId: session, kind, ...(cursor ? { cursor } : {}) })}`;
  const http = async (kind: string, cursor?: string) => { const response = await fetch(url(kind, cursor)); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store'); return await response.json() as Page; };
  const companion = async (kind: string, cursor?: string) => {
    const result = await mcp.callTool({ name: 'list_conversation_media', arguments: { kind, ...(cursor ? { cursor } : {}) } });
    assert.notEqual(result.isError, true); return JSON.parse((result.content as Array<{text:string}>)[0]!.text) as Page;
  };
  try {
    const operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    await partner.fileOperationReserve({ sessionId, operationId, files: [{ id: 'file', name: 'song.mp3', mediaType: 'audio/mpeg', size: 5 }] }, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'file', (async function* () { yield Buffer.from('hello'); })(), owner, async () => true, () => true);
    const staged = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    assert.deepEqual((await http('file')).items, []);
    assert.deepEqual((await companion('file')).items, []);
    await partner.submitNativeDelivery({ operationId, text: 'file', files: staged.files.map(item => item.ref) });
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    await eventually(async () => (await http('file')).items.length === 1);
    const filePage = await http('file');
    assert.equal(filePage.items[0]!.messageId, operationId);
    assert.equal(filePage.items[0]!.file?.name, 'song.mp3');
    assert.deepEqual(await companion('file'), filePage);
    assert.equal(await (await fetch(`${origin}/api/chat/files/${staged.files[0]!.ref.attachmentId}`)).text(), 'hello');
    assert.equal(JSON.stringify(filePage).includes(f.workspace), false);
    await eventually(async () => !(await partner.snapshot()).typing);
    await partner.submit(crypto.randomUUID(), 'send voice');
    await eventually(async () => (await partner.snapshot()).results.some(result => result.voices.length === 35));
    const first = await http('voice'), second = await http('voice', first.nextCursor!);
    const all = [...first.items, ...second.items];
    assert.equal(all.length, 35); assert.equal(new Set(all.map(item => item.messageId)).size, 35);
    assert.equal(new Set(all.map(item => item.voice!.id)).size, 1);
    const mcpFirst = await companion('voice'), mcpSecond = await companion('voice', mcpFirst.nextCursor!);
    assert.deepEqual([...mcpFirst.items, ...mcpSecond.items], all);
    await eventually(async () => !(await partner.snapshot()).typing);
    const chat = createCodexChatBackend(partner); await startMessages(chat); const view = await chat.read(); let before = view.before, messages = view.messages;
    while (before) { const history = await olderMessages(chat, before); messages = [...history.messages, ...messages]; before = history.before; }
    assert.deepEqual(new Set(all.map(item => item.messageId)), new Set(messages.filter(message => message.voice).map(message => message.id)));
    await mkdir(join(f.workspace, '.lamplit', 'audio'), { recursive: true });
    await writeFile(join(f.workspace, '.lamplit', 'audio', `${all[0]!.voice!.id}.mp3`), 'voice');
    assert.equal(await (await fetch(`${origin}/api/audio/${all[0]!.voice!.id}.mp3`)).text(), 'voice');
    assert.equal((await fetch(url('file', first.nextCursor!))).status, 400);
    assert.equal((await fetch(url('voice', first.nextCursor!, 'other'))).status, 400);
    assert.equal((await fetch(url('voice', 'invalid'))).status, 400);
    assert.equal((await fetch(url('other'))).status, 400);
    const originalRead = partner.conversationMedia;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    partner.conversationMedia = async (...args) => { const result = await originalRead(...args); entered(); await gate; return result; };
    const pending = fetch(url('voice')); await started; authorized = false; release();
    assert.equal((await pending).status, 401);
    partner.conversationMedia = originalRead; authorized = true;
    authorized = false; assert.equal((await fetch(url('voice'))).status, 401); authorized = true;
    await app.close(); await partner.close();
    const unavailable = await mcp.callTool({ name: 'list_conversation_media', arguments: { kind: 'voice' } }); assert.equal(unavailable.isError, true);
    partner = await f.createPartner();
    app = createWebServer(partner, join(f.directory, 'assets'), { authorize: (() => authorized) as unknown as () => Promise<boolean> });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); origin = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
    assert.equal((await fetch(url('voice', first.nextCursor!))).status, 400);
    const restored = await http('voice'); assert.deepEqual([...restored.items, ...(await http('voice', restored.nextCursor!)).items], all);
    assert.deepEqual((await companion('file')).items, filePage.items);
    const attachmentRoot = join(f.workspace, '.lamplit', 'attachments', '.file-operations');
    const { readdir } = await import('node:fs/promises'); const dir = (await readdir(attachmentRoot))[0]!;
    await unlink(join(attachmentRoot, dir, (await readdir(join(attachmentRoot, dir)))[0]!));
    assert.equal((await http('file')).items[0]!.file!.availability, 'missing');
    assert.equal((await companion('file')).items[0]!.file!.availability, 'missing');
    assert.equal((await fetch(`${origin}/api/chat/files/${staged.files[0]!.ref.attachmentId}`)).status, 404);
  } finally { await mcp.close(); await app.close(); await partner.close(); await f.close(); }
});

test('file pages use message and attachment identity and reject corrupt or stale scope', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createMediaPublisher, mediaKey, readMediaPage } = await import('../runtime/conversation-media.ts');
  const root = await mkdtemp(join(tmpdir(), 'media-directory-'));
  const index = join(root, 'media.json'), marker = join(root, 'thread.json'), path = join(root, 'original');
  const publisher = await createMediaPublisher(index);
  try {
    await writeFile(marker, JSON.stringify({ threadId: 'current' })); await writeFile(path, 'x');
    const entries = Array.from({ length: 35 }, (_, i) => ({ kind: 'file' as const, messageId: `message-${Math.floor(i / 2)}`, createdAt: 123,
      file: { attachmentId: i.toString(16).padStart(64, '0'), name: `${i}.txt`, size: 1, mediaType: 'text/plain', path } }));
    await publisher.publish('current', mediaKey(), entries);
    const first = await readMediaPage(index, marker, 'current', 'file');
    const second = await readMediaPage(index, marker, 'current', 'file', first.nextCursor!);
    const items = [...first.items, ...second.items] as Array<{messageId:string; file:{attachmentId:string}}>;
    assert.equal(items.length, 35); assert.equal(new Set(items.map(item => JSON.stringify([item.messageId, item.file.attachmentId]))).size, 35);
    await assert.rejects(readMediaPage(index, marker, 'current', 'voice', first.nextCursor!));
    await assert.rejects(readMediaPage(index, marker, 'another', 'file'));
    const staleOwner = JSON.parse(await readFile(index, 'utf8')) as { generation: string };
    staleOwner.generation = '0'.repeat(32); await writeFile(index, JSON.stringify(staleOwner));
    await assert.rejects(readMediaPage(index, marker, undefined, 'file'));
    await publisher.publish('current', mediaKey(), entries);
    await writeFile(marker, JSON.stringify({ threadId: 'different' }));
    await assert.rejects(readMediaPage(index, marker, undefined, 'file'));
    await writeFile(marker, JSON.stringify({ threadId: 'current' })); await writeFile(index, '{broken');
    await assert.rejects(readMediaPage(index, marker, undefined, 'file'));
  } finally { await publisher.close(); await rm(root, { recursive: true, force: true }); }
});

test('unknown file admission remains absent until native history confirms it', async () => {
  const { rename } = await import('node:fs/promises');
  const { stageTestFiles } = await import('./file-fixture.ts');
  const f = await fixture(); await f.holdProvider(true); let partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
  const controlPath = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (value: object) => { await writeFile(`${controlPath}.next`, JSON.stringify({ hold: true, ...value })); await rename(`${controlPath}.next`, controlPath); };
  try {
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'f', name: 'uncertain.txt', mediaType: 'text/plain', bytes: Buffer.from('x') }]);
    await control({ hiddenHistoryClientIds: [operationId] });
    assert.equal(await partner.submitNativeDelivery({ operationId, text: 'uncertain', files: staged.files.map(item => item.ref) }), null);
    await eventually(async () => (await f.requests()).some(request => request.method === 'turn/steer'));
    assert.deepEqual((await partner.conversationMedia(sessionId, 'file')).items, []);
    await partner.close(); partner = await f.createPartner();
    assert.deepEqual((await partner.conversationMedia(sessionId, 'file')).items, []);
    await control({});
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    await eventually(async () => (await partner.conversationMedia(sessionId, 'file')).items.length === 1);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/steer').length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('confirmed failed file admission is excluded after restart', async () => {
  const { stageTestFiles } = await import('./file-fixture.ts');
  const f = await fixture(); f.appServer.env.FAKE_NO_ACTIVE_STEER_COUNT = '1'; await f.holdProvider(true);
  let partner = await f.createPartner(); const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
  try {
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'f', name: 'failed.mp3', mediaType: 'audio/mpeg', bytes: Buffer.from('x') }]);
    await partner.submitNativeDelivery({ operationId, text: 'failed', files: staged.files.map(item => item.ref) });
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'failed');
    assert.deepEqual((await partner.conversationMedia(sessionId, 'file')).items, []);
    await partner.close(); partner = await f.createPartner();
    assert.deepEqual((await partner.conversationMedia(sessionId, 'file')).items, []);
  } finally { await partner.close(); await f.close(); }
});

test('a killed publisher cannot validate its old generation and restart reclaims its lock', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createMediaPublisher, mediaKey, readMediaPage } = await import('../runtime/conversation-media.ts');
  const root = await mkdtemp(join(tmpdir(), 'media-owner-'));
  const index = join(root, 'media.json'), marker = join(root, 'thread.json');
  await writeFile(marker, JSON.stringify({ threadId: 'session' }));
  const script = `const {createMediaPublisher,mediaKey} = await import(process.argv[1]);
    const publisher = await createMediaPublisher(process.argv[2]);
    await publisher.publish('session', mediaKey(), [{kind:'voice',messageId:'voice',createdAt:1,voice:{id:'a'.repeat(64)}}]);
    process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('../runtime/conversation-media.ts', import.meta.url).href, index], { stdio: ['ignore', 'pipe', 'pipe'] });
  let replacement: Awaited<ReturnType<typeof createMediaPublisher>> | undefined;
  try {
    await once(child.stdout!, 'data');
    assert.equal((await readMediaPage(index, marker, 'session', 'voice')).items.length, 1);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    // The stale snapshot and lock pathname still exist, but the kernel dropped the lock.
    const staleLock = (await readdir(root)).find(name => /^conversation-media-[a-f0-9]{32}\.lock$/u.test(name)); assert.ok(staleLock);
    await assert.rejects(readMediaPage(index, marker, 'session', 'voice'));
    // A simultaneous reader's shared probe must never look like a live owner.
    const { open } = await import('node:fs/promises');
    const { default: koffi } = await import('koffi');
    const probe = await open(join(root, staleLock), 'r+');
    try {
      assert.equal(koffi.load(null).func('int flock(int fd, int operation)')(probe.fd, 1 | 4), 0);
      await assert.rejects(readMediaPage(index, marker, 'session', 'voice'));
    } finally { await probe.close(); }
    replacement = await createMediaPublisher(index);
    assert.equal((await readdir(root)).filter(name => /^conversation-media-[a-f0-9]{32}\.lock$/u.test(name)).length, 1);
    await assert.rejects(readMediaPage(index, marker, 'session', 'voice'));
    await replacement.publish('session', mediaKey(), []);
    assert.deepEqual((await readMediaPage(index, marker, 'session', 'voice')).items, []);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await replacement?.close(); await rm(root, { recursive: true, force: true }); }
});

test('text-only updates do not rewrite an unchanged media view', async () => {
  const { stat } = await import('node:fs/promises');
  const f = await fixture(); const partner = await f.createPartner();
  const index = join(f.workspace, '.lamplit', 'conversation-media.json');
  try {
    const before = await stat(index);
    await partner.submit(crypto.randomUUID(), 'a text-only turn');
    await eventually(async () => { const view = await partner.snapshot(); return !view.typing && view.results.some(result => result.answers.length > 0); });
    const after = await stat(index);
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await partner.close(); await f.close(); }
});

test('media write and cleanup failures revoke the view without breaking chat or shutdown', async () => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { readMediaPage } = await import('../runtime/conversation-media.ts');
  const f = await fixture(); const partner = await f.createPartner();
  const index = join(f.workspace, '.lamplit', 'conversation-media.json'), marker = join(f.workspace, '.lamplit', 'thread.json');
  const originalRename = fs.rename, originalUnlink = fs.unlink;
  const mcp = new Client({ name: 'media-fault-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url)), f.workspace], stderr: 'ignore' }));
  try {
    const sessionId = (await partner.snapshot()).sessionId, stale = await readFile(index, 'utf8');
    fs.rename = async (from, to) => { if (to === index) throw Object.assign(new Error('injected media rename failure'), { code: 'EIO' }); return originalRename(from, to); };
    fs.unlink = async (path) => { if (String(path).endsWith('.lock') || String(path).endsWith('.tmp')) throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' }); return originalUnlink(path); };
    syncBuiltinESMExports();
    await partner.submit(crypto.randomUUID(), 'send voice');
    await eventually(async () => (await partner.snapshot()).results.some(result => result.voices.length > 0));
    await eventually(async () => { try { await partner.conversationMedia(sessionId, 'voice'); return false; } catch { return true; } });
    assert.equal(await readFile(index, 'utf8'), stale);
    await assert.rejects(readMediaPage(index, marker, sessionId, 'voice'));
    assert.equal((await mcp.callTool({ name: 'list_conversation_media', arguments: { kind: 'voice' } })).isError, true);
    await eventually(async () => !(await partner.snapshot()).typing);
    const followup = crypto.randomUUID(); await partner.submit(followup, 'chat still works');
    await eventually(async () => (await partner.snapshot()).results.some(result => result.sourceIds.includes(followup) && result.answers.length > 0));
    await partner.close();
  } finally {
    fs.rename = originalRename; fs.unlink = originalUnlink; syncBuiltinESMExports();
    await mcp.close(); await partner.close(); await f.close();
  }
});

test('failure to create the publisher leaves startup and chat usable', async () => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { readMediaPage } = await import('../runtime/conversation-media.ts');
  const f = await fixture(); let partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId;
  await partner.close();
  const originalOpen = fs.open;
  try {
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      if (/conversation-media-[a-f0-9]{32}\.lock$/u.test(String(args[0]))) throw Object.assign(new Error('injected startup failure'), { code: 'EACCES' });
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    partner = await f.createPartner();
    await assert.rejects(partner.conversationMedia(sessionId, 'voice'));
    await assert.rejects(readMediaPage(join(f.workspace, '.lamplit', 'conversation-media.json'), join(f.workspace, '.lamplit', 'thread.json'), sessionId, 'voice'));
    const id = crypto.randomUUID(); await partner.submit(id, 'startup still works');
    await eventually(async () => (await partner.snapshot()).results.some(result => result.sourceIds.includes(id) && result.answers.length > 0));
    await partner.close();
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('a retiring publisher holds the writer lock until its pending write drains', async () => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { tmpdir } = await import('node:os');
  const { createMediaPublisher, mediaKey, readMediaPage } = await import('../runtime/conversation-media.ts');
  const root = await fs.mkdtemp(join(tmpdir(), 'media-retire-'));
  const index = join(root, 'media.json'), marker = join(root, 'thread.json');
  await writeFile(marker, JSON.stringify({ threadId: 'session' }));
  const publisher = await createMediaPublisher(index); const key = mediaKey();
  const originalRename = fs.rename; let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let replacement: Awaited<ReturnType<typeof createMediaPublisher>> | undefined;
  try {
    await publisher.publish('session', key, []);
    fs.rename = async (from, to) => { if (to === index) { entered(); await gate; } return originalRename(from, to); };
    syncBuiltinESMExports();
    const pending = publisher.publish('session', key, [{ kind: 'voice', messageId: 'late', createdAt: 1, voice: { id: 'a'.repeat(64) } }]);
    await started; await publisher.revoke();
    await assert.rejects(readMediaPage(index, marker, 'session', 'voice'));
    await assert.rejects(createMediaPublisher(index), /Another media publisher/);
    release(); await pending; await publisher.close();
    fs.rename = originalRename; syncBuiltinESMExports();
    replacement = await createMediaPublisher(index);
    await assert.rejects(readMediaPage(index, marker, 'session', 'voice'));
    await replacement.publish('session', mediaKey(), []);
    assert.deepEqual((await readMediaPage(index, marker, 'session', 'voice')).items, []);
  } finally { release(); fs.rename = originalRename; syncBuiltinESMExports(); await publisher.close(); await replacement?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('media cleanup failure does not poison an unrelated image-error event', async () => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { readMediaPage } = await import('../runtime/conversation-media.ts');
  const f = await fixture(); const partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId;
  const index = join(f.workspace, '.lamplit', 'conversation-media.json'), marker = join(f.workspace, '.lamplit', 'thread.json');
  const originalUnlink = fs.unlink;
  try {
    fs.unlink = async path => { if (String(path).endsWith('.lock')) throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' }); return originalUnlink(path); };
    syncBuiltinESMExports();
    const id = crypto.randomUUID(); await partner.submit(id, 'generate image with missing image artifact');
    await eventually(async () => { const view = await partner.snapshot(); return view.messages.some(message => message.id === id && message.inputError === 'Native image artifact unavailable') && view.results.some(result => result.status === 'completed'); });
    assert.equal((await partner.snapshot()).storageError, true);
    await assert.rejects(readMediaPage(index, marker, sessionId, 'voice'));
    await partner.close();
  } finally { fs.unlink = originalUnlink; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('partial Partner startup releases the acquired publisher generation', async () => {
  const { createMediaPublisher, readMediaPage } = await import('../runtime/conversation-media.ts');
  const f = await fixture(); const partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId;
  const index = join(f.workspace, '.lamplit', 'conversation-media.json'), marker = join(f.workspace, '.lamplit', 'thread.json');
  await partner.close(); f.appServer.env.FAKE_SERVER_VERSION = '0.153.0';
  let replacement: Awaited<ReturnType<typeof createMediaPublisher>> | undefined;
  try {
    await assert.rejects(f.createPartner(), /Unsupported Codex app-server version/);
    await assert.rejects(readMediaPage(index, marker, sessionId, 'voice'));
    replacement = await createMediaPublisher(index);
  } finally { await replacement?.close(); await f.close(); }
});
