import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join } from 'node:path';
import WebSocket from 'ws';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView, PostSource } from '@lamplit/contracts';
import { postAcceptanceHost } from './post-acceptance-host.ts';
import { eventually } from './fixture.ts';

async function probeFailedHost(hold = false) {
  const root = await mkdtemp(join(tmpdir(), 'post-host-init-'));
  const moduleUrl = new URL('./post-acceptance-host.ts', import.meta.url).href;
  const script = `import { postAcceptanceHost } from ${JSON.stringify(moduleUrl)};
    import { spawn } from 'node:child_process';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    try { await postAcceptanceHost(process.argv[1]); process.exitCode = 1; }
    catch (error) { if (error.code !== 'ENOENT') throw error; console.log('expected ENOENT'); }
    if (process.argv[2] === 'hold') {
      mkdirSync(join(process.env.TMPDIR, 'synthetic-fixture'));
      writeFileSync(join(process.env.TMPDIR, 'synthetic-fixture', 'marker'), 'owned');
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log('synthetic fixture ready');
      setInterval(() => {}, 1000);
    }`;
  const socket = join(root, 'lamplit-partner-test-XXXXXX/workspace/.lamplit/run/codex.sock');
  if (Buffer.byteLength(socket) > (process.platform === 'darwin' ? 103 : 107)) {
    await rm(root, { recursive: true, force: true });
    throw new Error('Test-owned TMPDIR is too long for the fixture socket');
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(root, 'missing'), hold ? 'hold' : ''], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  const closed = once(child, 'close');
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([closed, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 8000); })]);
    if (!result) { stop(); await closed; }
    return { root, pid: child.pid!, result, output };
  } finally {
    if (timer) clearTimeout(timer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (child.exitCode === null && child.signalCode === null) { stop(); await closed.catch(() => {}); }
    await rm(root, { recursive: true, force: true });
  }
}

test('Post host releases its resources when static assets are unavailable', { timeout: 15_000 }, async () => {
  const probe = await probeFailedHost();
  assert.ok(probe.result, `Post host initialization leaked resources: ${probe.output}`);
  assert.equal(probe.result[0], 0, probe.output);
  assert.match(probe.output, /expected ENOENT/);
  await assert.rejects(access(probe.root), { code: 'ENOENT' });
});

test('Post host probe cleans its process group and fixture after a timeout', { timeout: 15_000 }, async () => {
  const probe = await probeFailedHost(true);
  assert.equal(probe.result, null, probe.output);
  assert.match(probe.output, /expected ENOENT/);
  assert.match(probe.output, /synthetic fixture ready/);
  assert.throws(() => process.kill(-probe.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(probe.root), { code: 'ENOENT' });
});

test('Post native browser history control puts the retained older source in one real public page', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'post-host-assets-'));
  try {
    const host = await postAcceptanceHost(assets);
    let client: Awaited<ReturnType<typeof openChat>> | undefined;
    let view: ChatView | undefined;
    const source: PostSource = { kind: 'post', platform: 'qq', conversationType: 'group', conversationId: 'owned-chat', conversationName: 'Owned group', senderId: 'owned-sender', senderDisplayName: 'Owned peer' };
    const incoming = (id: string, history = false) => host.action({ action: 'incoming', id, source, text: `${id} original`, createdAt: 1791320400000, history });
    try {
      await incoming('initial'); await incoming('older', true);
      client = await openChat(new WebSocket(host.origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Cookie: 'post-test-owner=1' } }) as unknown as globalThis.WebSocket, value => { view = value; }, () => {});
      for (let n = 0; n < 7; n++) await incoming(`later-${n}`);
      await client.submit({ operationId: crypto.randomUUID(), text: 'owned ordinary web input' });
      await host.action({ action: 'complete' }); await host.action({ action: 'reminder' }); await incoming('reconnect');
      await eventually(async () => !!view?.messages.some(m => m.text === 'reconnect original') && !!view?.before);
      assert(!view!.messages.some(m => m.text === 'older original'), 'older source is actually outside the live public page');
      const page = await client.history(view!.before!);
      const next = page.before ? await client.history(page.before) : undefined;
      assert(page.messages.some(m => m.text === 'older original' && m.source?.kind === 'post'), JSON.stringify({ firstPostSources: page.messages.filter(m => m.source?.kind === 'post').length, nextHasOlder: next?.messages.some(m => m.text === 'older original' && m.source?.kind === 'post') }));
    } finally { client?.close(); await host.close(); }
  } finally { await rm(assets, { recursive: true, force: true }); }
});
