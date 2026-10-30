import assert from 'node:assert/strict';
import sharp from 'sharp';
import { test } from 'node:test';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, eventually } from './fixture.ts';
import { event, examples, postService } from './post-fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { postInput, postInputId, discoverPost, postConversationName } from '../runtime/post.ts';
import { ToolInputs, ToolOutputs, PostEventV1 } from '../runtime/post-contract.ts';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { fetchPostAsset, uploadPostAsset, savePostAsset } from '../runtime/post-assets.ts';
import { postEndpoint, loadConfig, loadCredentials } from '../runtime/config.ts';
import { ensureHookDeclaration } from '../runtime/context-bootstrap.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import type { Partner } from '../runtime/partner.ts';

const starts = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.requests()).filter(r => r.method === 'turn/start').map(r => r.params as { threadId: string; clientUserMessageId: string; input: Array<{ type: string; text?: string; path?: string }>; additionalContext: Record<string,{ kind: string; value: string }> });
const accounts = (platforms: string[]) => ({ items: platforms.map(platform => ({ ...examples.tools.list_accounts.result.items[0], account_id: `${platform}-main`, platform })) });
const discoveries = (post: Awaited<ReturnType<typeof postService>>) => post.requests.filter(r => r.tool === 'list_accounts').length;
async function setup() {
  const post = await postService(), f = await fixture();
  f.appServer.env.HOME = f.directory;
  f.config.post = { endpoint: post.endpoint, agent_id: 'cfl' }; f.credentials.post = post.token; f.credentials.post_receiver = post.receiver;
  return { post, f, async close() { await f.close(); await post.close(); } };
}
async function host(partner: Partner, dir: string, receiver: string) {
  const app = createWebServer(partner,join(dir,'assets'));
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { ...app, origin, send(value: unknown, token = receiver) { return fetch(origin + '/api/post/events',{ method:'POST',headers: { authorization:`Bearer ${token}`, 'content-type':'application/json' },body: typeof value === 'string' ? value : JSON.stringify(value) }); } };
}

test('later authorized QQ account reaches receiver without restart after Matrix-only startup', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    post.accounts = accounts(['matrix']);
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    post.accounts = accounts(['matrix', 'qq']);
    const qq = event('later-qq');
    const response = await h.send(qq);
    assert.equal(response.status, 202, await response.text());
    await eventually(async () => (await starts(f)).length === 1);
    assert.equal((await starts(f))[0]!.clientUserMessageId, postInputId(post.endpoint, qq));
    const direct = event('later-qq-private'); direct.message.conversation.type = 'direct'; direct.wake.reason = 'direct_message';
    assert.equal((await h.send(direct)).status, 202);
    await eventually(async () => (await starts(f)).length === 2);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});

test('late account refresh preserves validation, authority, retryable failures and concurrent dedupe', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    post.accounts = accounts(['matrix']);
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    const qq = event('refresh-guards');
    const before = discoveries(post);
    const invalids = [
      { ...qq, agent_id: 'other' }, { ...qq, unknown: true },
      { ...qq, message: { ...qq.message, direction: 'outbound' } },
      { ...qq, message: { ...qq.message, mutation: 'edit' } },
      { ...qq, message: { ...qq.message, assets: [] } },
      { ...qq, message: { ...qq.message, assets: [{ ...qq.message.assets[0], download_path: 'https://invalid.test/asset' }] } },
    ];
    assert.equal((await h.send(qq, 'wrong')).status, 401);
    assert.equal((await h.send('invalid json')).status, 400);
    for (const value of invalids) assert.equal((await h.send(value)).status, 422);
    assert.equal(discoveries(post), before, 'invalid requests cannot cause authenticated discovery');
    assert.equal((await h.send(qq)).status, 422, 'unknown account not listed by authority');
    post.accounts = accounts(['matrix']);
    const wrongPlatform = event('wrong-platform'); wrongPlatform.message.account_id = 'matrix-main';
    assert.equal((await h.send(wrongPlatform)).status, 422);
    assert.equal((await starts(f)).length, 0);
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length, 0);

    post.accountMode = 'fail';
    assert.equal((await h.send(qq)).status, 503, 'transport failure is retryable');
    post.accountMode = 'unauthorized';
    assert.equal((await h.send(qq)).status, 503, 'failed authority authentication cannot authorize the account');
    post.accountMode = 'normal'; post.accounts = { items: [] };
    assert.equal((await h.send(qq)).status, 503, 'unusable authority is not a terminal event rejection');
    post.accounts = accounts(['matrix', 'qq']);
    // Changed content after failed lookups proves no earlier durable receipt.
    qq.message.content.push({ type: 'text', text: 'test-only retry after failed discovery' });
    const lookups = discoveries(post);
    const replies = await Promise.all(Array.from({ length: 4 }, () => h!.send(qq)));
    assert.deepEqual(replies.map(r => r.status), [202, 202, 202, 202]);
    assert.equal(discoveries(post), lookups + 1, 'concurrent misses share one lookup');
    await eventually(async () => (await starts(f)).length === 1 && !(await partner.snapshot()).typing);
    const conflict = structuredClone(qq); conflict.message.sender.native_id = 'changed';
    assert.equal((await h.send(conflict)).status, 409);
    post.accountMode = 'fail';
    assert.equal((await h.send(qq)).status, 202);
    assert.equal((await h.send(event('known-matrix', 'matrix'))).status, 202);
    await eventually(async () => (await starts(f)).length === 2 && !(await partner.snapshot()).typing);
    assert.equal(discoveries(post), lookups + 1, 'known accounts need no lookup');
    assert.equal((await starts(f))[0]!.threadId, (await starts(f))[1]!.threadId);
    post.accountMode = 'normal'; post.accounts = accounts(['matrix']);
    const ungranted = event('not-authorized'); ungranted.message.account_id = 'ungranted';
    assert.equal((await h.send(ungranted)).status, 422);
    assert.equal((await h.send(qq)).status, 422, 'a refreshed map does not retain removed accounts');
    await h.close(); h = undefined;
    post.accounts = accounts(['matrix', 'qq']);
    const restarted = await f.createPartner(); h = await host(restarted, f.directory, post.receiver);
    assert.equal((await h.send(qq)).status, 202);
    assert.equal((await starts(f)).length, 2, 'durable duplicate never executes again');
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});

for (const mode of ['stall-headers', 'stall-body'] as const) test(`shutdown retires account discovery ${mode} before storage and allows clean retry`, async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    post.accounts = accounts(['matrix']);
    let partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    post.accounts = accounts(['matrix', 'qq']); post.accountMode = mode;
    const qq = event(`shutdown-${mode}`), pending = h.send(qq);
    await eventually(async () => post.discoveryOpen === 1);
    const began = Date.now(); await partner.close();
    assert(Date.now() - began < 2000, 'close cancels lookup rather than waiting for deadline');
    assert.equal((await pending).status, 503);
    await eventually(async () => post.discoveryOpen === 0);
    assert.equal((await starts(f)).length, 0);
    await h.close(); h = undefined;
    post.accountMode = 'normal';
    partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    qq.message.content.push({ type: 'text', text: 'no receipt before cancelled lookup' });
    assert.equal((await h.send(qq)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});

test('account lookup body deadline returns retryable failure and retires actual IO', { timeout: 10_000 }, async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    post.accounts = accounts(['matrix']);
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    post.accountMode = 'stall-body';
    const began = Date.now();
    assert.equal((await h.send(event('lookup-deadline'))).status, 503);
    assert(Date.now() - began < 6500);
    await eventually(async () => post.discoveryOpen === 0);
    assert.equal((await starts(f)).length, 0);
  } finally { await h?.close(); await s.close(); }
});

function contextValue(call: Awaited<ReturnType<typeof starts>>[number], prefix: string) {
  return Object.entries(call.additionalContext).filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => value.value.replace(/^Part \d+\/\d+: /, '')).join('');
}

test('current source name requires an admitted exact identity across bounded directory pages', async () => {
  const post = await postService();
  try {
    const e = event('directory'); e.message.conversation.name = 'Stale capture';
    const source = { ...examples.tools.get_conversation.result, name: ' Current name ' };
    const other = { ...source, conversation_id: 'another', native_id: 'another-native', name: 'Other' };
    post.conversationPages = { '': { items: [other], next_before: 'next' }, next: { items: [], next_before: 'last' }, last: { items: [source], next_before: null } };
    assert.equal(await postConversationName(post.endpoint, post.token, e, new AbortController().signal), ' Current name ');
    const calls = post.requests.filter(r => r.tool === 'list_conversations');
    assert.deepEqual(calls.map(r => r.args), [{ account_id: 'qq-main', limit: 100 }, { account_id: 'qq-main', limit: 100, before: 'next' }, { account_id: 'qq-main', limit: 100, before: 'last' }]);
    post.conversationPages = { '': { items: [other], next_before: null } };
    assert.equal(await postConversationName(post.endpoint, post.token, e, new AbortController().signal), null);
    post.conversationPages = { '': { items: [], next_before: 'loop' }, loop: { items: [], next_before: 'loop' } };
    assert.equal(await postConversationName(post.endpoint, post.token, e, new AbortController().signal), null);
    post.conversationPages = { '': { items: Array.from({ length: 101 }, () => other), next_before: null } };
    assert.equal(await postConversationName(post.endpoint, post.token, e, new AbortController().signal), null);
    post.conversationPages = { '': { items: [{ ...other, name: 'x'.repeat(1024 * 1024) }], next_before: null } };
    assert.equal(await postConversationName(post.endpoint, post.token, e, new AbortController().signal), null);
    const pages = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i ? String(i) : '', { items: [], next_before: String(i + 1) }]));
    post.conversationPages = pages;
    const before = post.requests.filter(r => r.tool === 'list_conversations').length;
    assert.equal(await postConversationName(post.endpoint, post.token, e, new AbortController().signal), null);
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length - before, 10);
    post.conversationMode = 'unauthorized';
    assert.equal(await postConversationName(post.endpoint, post.token, e, new AbortController().signal), null);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await post.close(); }
});

test('retained capture stays immutable while native input uses the current source name', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    const e = event('renamed-source'); e.message.conversation.name = 'Former name'; e.message.sender.name = 'Sender nickname';
    post.conversation = { ...examples.tools.get_conversation.result, name: 'Current name' };
    assert.equal((await h.send(e)).status, 202);
    await eventually(async () => (await starts(f)).length === 1 && !(await partner.snapshot()).typing);
    const call = (await starts(f))[0]!;
    assert.equal(JSON.parse(contextValue(call, 'codex-for-love.post-authored')).conversation_name, 'Current name');
    assert.match(call.input[0]!.text!, /Current name/);
    assert.equal((await partner.snapshot()).messages.find(m => m.id === postInputId(post.endpoint, e))!.post!.source.conversationName, 'Former name');
    assert.equal((await h.send(e)).status, 202);
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length, 1);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});

test('accepted group and direct work deliver genuine bounded names and type to native context', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    for (const [index, type] of (['group', 'direct'] as const).entries()) {
      const e = event(`names-${type}`); delete e.message.conversation.name; e.message.conversation.type = type;
      e.message.sender.name = 'Contact "name"\n' + '界'.repeat(300);
      const name = type === 'group' ? 'Real "group"\n' + '界'.repeat(200) : 'Genuine contact';
      post.conversation = { ...examples.tools.get_conversation.result, account_id: e.message.account_id,
        conversation_id: e.message.conversation.id, native_id: e.message.conversation.native_id, type, name };
      assert.equal((await h.send(e)).status, 202);
      await eventually(async () => (await starts(f)).length === index + 1 && !(await partner.snapshot()).typing);
      const call = (await starts(f))[index]!;
      const authored = JSON.parse(contextValue(call, 'codex-for-love.post-authored'));
      assert.deepEqual(authored.sender, e.message.sender, 'existing sender-name control');
      assert.equal(JSON.parse(contextValue(call, 'codex-for-love.post-metadata')).conversation.type, type, 'existing type control');
      assert.equal(authored.conversation_name, Array.from(name).slice(0, 256).join(''));
      for (const [key, value] of Object.entries(call.additionalContext)) if (key.startsWith('codex-for-love.post-authored')) {
        assert.equal(value.kind, 'untrusted'); assert(Buffer.byteLength(value.value) < 850);
      }
      assert.equal((await h.send(e)).status, 202);
    }
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length, 2, 'duplicates do not re-fetch names');
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});

test('accepted Post input prioritizes genuine names with bounded escaped ID fallback and stable source identity', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  const events = [], rendered = [];
  try {
    let partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    for (const [index, type] of (['group', 'direct', 'group', 'direct'] as const).entries()) {
      const e = event(`readable-${index}`); delete e.message.conversation.name; e.message.conversation.type = type;
      e.message.sender.name = index < 2 ? 'Real "sender"\n' + '界'.repeat(300) : index === 3 ? 'Known sender' : undefined;
      const name = index < 2 ? `Genuine ${type} "name"\n` + '界'.repeat(200) : undefined;
      post.conversationMode = index === 3 ? 'fail' : 'normal';
      post.conversation = { ...examples.tools.get_conversation.result, account_id: e.message.account_id,
        conversation_id: e.message.conversation.id, native_id: e.message.conversation.native_id, type, name };
      events.push(e);
      assert.equal((await h.send(e)).status, 202);
      await eventually(async () => (await starts(f)).length === index + 1 && !(await partner.snapshot()).typing);
      const call = (await starts(f))[index]!, text = call.input[0]!.text!;
      rendered.push(text);
      const [header, ...body] = text.split('\n');
      assert(header!.startsWith(`[Post qq; ${type} `));
      const authored = JSON.parse(contextValue(call, 'codex-for-love.post-authored'));
      assert.equal(body.join('\n'), postInput(e, authored.media).split('\n').slice(1).join('\n'), 'body/media remain exact');
      assert.equal(call.input.filter(p => p.type === 'localImage').length, 1);
      if (name) {
        assert(header!.includes(JSON.stringify(Array.from(name).slice(0, 256).join(''))));
        assert(header!.includes(JSON.stringify(Array.from(e.message.sender.name!).slice(0, 256).join(''))));
        for (const id of [e.message.account_id, e.message.conversation.id, e.message.sender.native_id]) assert(!header!.includes(id));
      } else {
        assert(header!.includes('name unavailable'));
        assert(header!.includes(e.message.sender.name ? `sender ${JSON.stringify(e.message.sender.name)}` : `sender unknown (ID ${JSON.stringify(e.message.sender.native_id)})`));
        assert(!header!.includes(e.message.account_id));
      }
      assert(Array.from(header!).length < 700);
      assert.equal(call.clientUserMessageId, postInputId(post.endpoint, e));
      assert.deepEqual(JSON.parse(contextValue(call, 'codex-for-love.post-metadata')).conversation, { id:e.message.conversation.id,native_id:e.message.conversation.native_id,type:e.message.conversation.type });
      for (const [key, value] of Object.entries(call.additionalContext)) if (key.startsWith('codex-for-love.post-authored')) assert.equal(value.kind, 'untrusted');
      const snapshot = await partner.snapshot();
      assert(snapshot.messages.some(m => m.input === text), 'accepted native text projects through existing source location');
      assert.equal((await h.send(e)).status, 202);
    }
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length, 4);
    await h.close(); h = undefined;
    partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    for (const e of events) assert.equal((await h.send(e)).status, 202);
    const restartedView = await partner.snapshot();
    for (const text of rendered) assert(restartedView.messages.some(m => m.input === text), 'restart preserves exact accepted source text/body');
    assert.equal((await starts(f)).length, 4, 'restart duplicate does not rewrite or repeat accepted native input');
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length, 4);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});

test('conversation name absent, failed or mismatched is unknown without rejecting accepted work', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    const cases = [{ name: undefined }, { account_id: 'other' }, { conversation_id: 'other' }, { native_id: 'other' }, { type: 'direct' }, null, 'fail'] as const;
    for (const [index, change] of cases.entries()) {
      post.conversationMode = change === 'fail' ? 'fail' : 'normal';
      post.conversation = change === null ? null : { ...examples.tools.get_conversation.result, name: 'Must not misattribute', ...(typeof change === 'object' ? change : {}) };
      const e = event(`unknown-name-${index}`); delete e.message.conversation.name;
      assert.equal((await h.send(e)).status, 202);
      await eventually(async () => (await starts(f)).length === index + 1 && !(await partner.snapshot()).typing);
      const call = (await starts(f))[index]!;
      assert.equal(JSON.parse(contextValue(call, 'codex-for-love.post-authored')).conversation_name, null);
      assert(call.input[0]!.text!.split('\n')[0]!.includes('name unavailable'));
      assert.deepEqual(JSON.parse(contextValue(call, 'codex-for-love.post-metadata')).conversation, { id:e.message.conversation.id,native_id:e.message.conversation.native_id,type:e.message.conversation.type });
    }
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});

for (const mode of ['stall-headers', 'stall-body'] as const) test(`conversation lookup ${mode} stays outside receipt and retires before native submission on close`, async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    let partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    post.conversationMode = mode;
    const e = event(`name-cancel-${mode}`), began = Date.now();
    assert.equal((await h.send(e)).status, 202); assert(Date.now() - began < 1000);
    await eventually(async () => post.conversationOpen === 1);
    assert.equal((await h.send(e)).status, 202);
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length, 1);
    const closingAt = Date.now(); await partner.close(); assert(Date.now() - closingAt < 2000);
    await eventually(async () => post.conversationOpen === 0);
    assert.equal((await starts(f)).length, 0);
    await h.close(); h = undefined;
    post.conversationMode = 'normal'; post.conversation = { ...examples.tools.get_conversation.result, name: 'Retained group' };
    partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    assert.equal((await h.send(e)).status, 202);
    await eventually(async () => (await starts(f)).length === 1 && !(await partner.snapshot()).typing);
    assert.equal(JSON.parse(contextValue((await starts(f))[0]!, 'codex-for-love.post-authored')).conversation_name, 'Retained group');
    assert.equal((await h.send(e)).status, 202); assert.equal((await starts(f)).length, 1);
  } finally { await h?.close(); await s.close(); }
});

test('conversation lookup whole-body deadline falls back to unknown and preserves the accepted turn', { timeout: 10_000 }, async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    post.conversationMode = 'stall-body';
    const e = event('name-deadline'); delete e.message.conversation.name;
    const began = Date.now(); assert.equal((await h.send(e)).status, 202);
    await eventually(async () => (await starts(f)).length === 1, 6500);
    assert(Date.now() - began < 6500); await eventually(async () => post.conversationOpen === 0);
    assert.equal(JSON.parse(contextValue((await starts(f))[0]!, 'codex-for-love.post-authored')).conversation_name, null);
  } finally { await h?.close(); await s.close(); }
});

test('Post diagnostics expose only finite receiver, admission, native and send categories', async t => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const records = () => lines.filter(line => line.startsWith('[partner] ')).map(line => JSON.parse(line.slice(10))).filter(r => r.event.startsWith('post.'));
  try {
    f.appServer.env.FAKE_STREAM_FIXTURE = 'true'; await f.chatPhase('partial');
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    const direct = event('DIAGNOSTIC_PRIVATE_ID'); direct.message.conversation.type = 'direct'; direct.wake.reason = 'direct_message';
    direct.message.content = [{ type: 'text', text: 'DIAGNOSTIC_PRIVATE_CONTENT' }]; direct.message.assets = [];
    direct.message.sender.name = 'DIAGNOSTIC_PRIVATE_NAME';
    assert.equal((await h.send(direct, 'DIAGNOSTIC_PRIVATE_TOKEN')).status, 401);
    assert.equal((await h.send({ ...direct, agent_id: 'other' })).status, 422);
    const unknown = structuredClone(direct); unknown.message.account_id = 'DIAGNOSTIC_PRIVATE_ACCOUNT';
    assert.equal((await h.send(unknown)).status, 422);
    post.accountMode = 'fail'; assert.equal((await h.send(unknown)).status, 503); post.accountMode = 'normal';
    assert.equal((await h.send(direct)).status, 202);
    await eventually(async () => (await starts(f)).length === 1);
    const native = await f.nativeState(), turnId = native.active;
    await f.streamCommand({ action: 'event', notification: { method: 'item/completed', params: { threadId: native.threadId, turnId, completedAtMs: Date.now(), item: { type: 'mcpToolCall', id: 'DIAGNOSTIC_PRIVATE_TOOL_ID', server: 'post', tool: 'send_message', arguments: { private: 'DIAGNOSTIC_PRIVATE_ARGS' }, status: 'failed', result: null, error: { message: 'DIAGNOSTIC_PRIVATE_ERROR https://private.invalid' } } } } });
    await eventually(async () => records().some(r => r.event === 'post.tool'));
    await partner.chatStop(turnId); await f.rejectStart(true);
    const rejected = structuredClone(direct); rejected.delivery_id += '-rejected'; rejected.message.id += '-rejected'; rejected.message.native_message_id += '-rejected';
    assert.equal((await h.send(rejected)).status, 202);
    await eventually(async () => records().some(r => r.event === 'post.execution' && r.stage === 'native_start' && r.status === 'failed'));
    assert(records().some(r => r.event === 'post.receiver' && r.status === 401));
    assert(records().some(r => r.event === 'post.ingress' && r.stage === 'validation' && r.status === 'rejected'));
    assert(records().some(r => r.event === 'post.ingress' && r.stage === 'account' && r.status === 'rejected'));
    assert(records().some(r => r.event === 'post.ingress' && r.stage === 'account' && r.status === 'unavailable'));
    assert(records().some(r => r.event === 'post.ingress' && r.stage === 'retained' && r.kind === 'direct'));
    assert(records().some(r => r.event === 'post.execution' && r.status === 'accepted' && r.kind === 'direct'));
    assert(records().some(r => r.event === 'post.tool' && r.category === 'transport' && r.status === 'failed'));
    for (const r of records()) {
      assert(Object.keys(r).every(k => ['component','event','stage','status','category','platform','kind'].includes(k)));
      assert(Buffer.byteLength(JSON.stringify(r)) < 300);
    }
    const output = lines.join('\n');
    for (const secret of ['DIAGNOSTIC_PRIVATE','private.invalid','group-openid','app-scoped-openid',post.token,post.receiver,native.threadId,turnId]) assert(!output.includes(secret), secret);
  } finally { await h?.close(); await s.close(); }
});

test('QQ and Matrix use one native thread, immutable provenance, generic images/text and durable dedupe after restart', async () => {
  const s = await setup(), { f,post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  const qq = event('qq'), matrix = event('matrix','matrix');
  try {
    post.conversationsByAccount = {
      'qq-main': examples.tools.get_conversation.result,
      'matrix-main': { ...examples.tools.get_conversation.result, account_id: 'matrix-main', name: 'Matrix group' },
    };
    let partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    await f.holdProvider(true);
    assert.equal((await h.send(qq)).status,202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.equal((await h.send(matrix)).status,202);
    assert.equal((await h.send(qq)).status,202);
    await f.holdProvider(false);
    await eventually(async () => (await starts(f)).length === 2 && !(await partner.snapshot()).typing);
    const calls = await starts(f);
    assert.equal(calls[0]!.threadId,calls[1]!.threadId);
    for (const [index,e] of [qq,matrix].entries()) {
      const call = calls[index]!; assert.equal(call.clientUserMessageId,postInputId(post.endpoint,e));
      assert.match(call.input[0]!.text!,new RegExp(`Post ${e.message.platform}`));
      assert.equal(call.input.filter(p => p.type === 'localImage').length,1);
      const metadata = Object.entries(call.additionalContext).filter(([k]) => k.startsWith('codex-for-love.post-metadata')).sort(([a],[b]) => a.localeCompare(b,undefined,{ numeric:true })).map(([,v]) => v.value).join('');
      const source = JSON.parse(metadata); assert.equal(source.platform,e.message.platform); assert.equal(source.account_id,e.message.account_id); assert.deepEqual(source.conversation,{ id:e.message.conversation.id,native_id:e.message.conversation.native_id,type:e.message.conversation.type });
      const authoredEntries = Object.entries(call.additionalContext).filter(([key]) => key.startsWith('codex-for-love.post-authored'));
      assert(authoredEntries.length > 0);
      for (const [, entry] of authoredEntries) assert.equal(entry.kind, 'untrusted');
      const authored = JSON.parse(contextValue(call, 'codex-for-love.post-authored'));
      assert.equal(authored.conversation_name, index === 0 ? 'Example group' : 'Matrix group');
      assert.deepEqual(authored.content, e.message.content);
    }
    const view = await createCodexChatBackend(partner).read();
    assert(view.messages.some(m => m.source?.kind === 'post'));
    assert(!view.messages.some(m => m.source?.kind === 'matrix'));
    const before = post.requests.filter(r => r.path?.startsWith('/assets')).length;
    assert.equal(before,2);
    await h.close(); h = undefined;
    partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    assert.equal((await h.send(qq)).status,202);
    assert.equal((await h.send({ ...qq, message: { ...qq.message, sender: { native_id:'changed' } } })).status,409);
    const alias = structuredClone(qq); alias.delivery_id += '-alias';
    assert.equal((await h.send(alias)).status,202);
    assert.equal((await starts(f)).length,2);
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,before);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length,0);
  } finally { await h?.close(); await s.close(); }
});

test('receiver auth and semantic validation precede durable receipt; storage failure is retryable', async t => {
  const s = await setup(), { f,post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    assert.equal((await h.send('invalid json','wrong')).status,401);
    assert.equal((await h.send('invalid json')).status,400);
    const wrong = event('invalid');
    const cases: unknown[] = [ { ...wrong,agent_id:'other' }, { ...wrong,unknown:true }, { ...wrong,schema_version:2 },
      { ...wrong,message:{ ...wrong.message,account_id:'unknown' } }, { ...wrong,message:{ ...wrong.message,platform:'matrix' } },
      { ...wrong,message:{ ...wrong.message,direction:'outbound' } }, { ...wrong,message:{ ...wrong.message,mutation:'edit' } },
      { ...wrong,message:{ ...wrong.message,assets:[] } }, { ...wrong,message:{ ...wrong.message,assets:[...wrong.message.assets,...wrong.message.assets] } },
      { ...wrong,message:{ ...wrong.message,assets:[{ ...wrong.message.assets[0],download_path:'https://evil.test/assets/ast_example' }] } },
      { ...wrong,wake:{ reason:'unauthenticated_boolean' } } ];
    for (const value of cases) assert.equal((await h.send(value)).status,422);
    assert.equal((await starts(f)).length,0);
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,0);
    const original = partner.ingestPost;
    const mock = t.mock.method(partner,'ingestPost',async () => { throw new Error('test-only storage failure'); });
    assert.equal((await h.send(event('retry'))).status,503); mock.mock.restore();
    assert.equal(partner.ingestPost,original);
    const admitted = event('policy'); admitted.message.content = [{ type:'text',text:'ordinary group without alias, mention or reply' }]; admitted.message.assets = []; admitted.message.mentions = { self:false,native_user_ids:[] };
    assert.equal((await h.send(admitted)).status,202);
    await eventually(async () => (await starts(f)).length === 1);
  } finally { await h?.close(); await s.close(); }
});

test('durable receipt does not wait for asset fetch; shutdown cancels body and restart continues once', async () => {
  const s = await setup(), {f,post} = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    post.assetMode = 'stall'; let partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    const e = event('slow'); const begin = Date.now();
    assert.equal((await h.send(e)).status,202); assert(Date.now() - begin < 1000);
    await eventually(async () => post.requests.some(r => r.path?.startsWith('/assets')));
    const closeStart = Date.now(); await h.close(); h = undefined; assert(Date.now() - closeStart < 2000);
    assert.equal((await starts(f)).length,0);
    post.assetMode = 'normal'; partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    await eventually(async () => (await starts(f)).length === 1 && !(await partner.snapshot()).typing);
    assert.equal((await h.send(e)).status,202);
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,2);
    assert.equal((await starts(f))[0]!.input.filter(p => p.type === 'localImage').length,1);
  } finally { await h?.close(); await s.close(); }
});

test('unavailable and failed image/file/audio/video stay truthful and do not invoke STT or block text', async () => {
  const s = await setup(), {f,post} = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    post.assetMode = 'corrupt'; const partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    const e = event('media');
    for (const type of ['file','audio','video'] as const) {
      const id = `ast_${type}`; e.message.content.push({ type,asset_id:id });
      e.message.assets.push({ asset_id:id,status:'unavailable',mime:`${type}/unknown`,name:'untrusted',size:null,download_path:null,reason:'not captured' });
    }
    assert.equal((await h.send(e)).status,202);
    await eventually(async () => (await starts(f)).length === 1);
    const call = (await starts(f))[0]!;
    assert.equal(call.input.length,1); assert.match(call.input[0]!.text!,/unavailable \(transfer or image bounds\)/);
    assert.match(call.input[0]!.text!,/audio.*unavailable/);
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,2);
  } finally { await h?.close(); await s.close(); }
});

test('Post MCP bootstrap, tools and private credential CLI preserve operator declarations and remove only owned Matrix', async () => {
  const s = await setup(), { f,post } = s;
  const configPath = join(f.directory,'partner.toml'), codexPath = join(f.workspace,'.codex/config.toml');
  try {
    await mkdir(join(f.workspace,'.codex'),{ recursive:true });
    await writeFile(codexPath,'model_reasoning_effort="low"\n[mcp_servers.matrix]\nurl="http://127.0.0.1:1234/mcp"\nbearer_token_env_var="CFL_MATRIX_TOKEN"\n[mcp_servers.operator]\ncommand="operator-tool"\n');
    await writeFile(configPath,`name="Test"\nprompts={ persona="persona.md" }\nstate="."\n[post]\nendpoint="${post.endpoint}"\nagent_id="cfl"\n`);
    assert.deepEqual((await loadConfig(configPath)).post,f.config.post);
    async function credential(name: string, token: string) {
      const child = spawn(process.execPath,[join(import.meta.dirname,'../runtime/cli.ts'),'credential',configPath,name,'--stdin'],{ stdio:['pipe','pipe','pipe'] });
      const output: Buffer[] = []; child.stdout.on('data', b => output.push(b)); child.stderr.on('data',b => output.push(b));
      child.stdin.end(token); const [code] = await once(child,'exit'); assert.equal(code,0,Buffer.concat(output).toString()); assert(!Buffer.concat(output).includes(Buffer.from(token)));
    }
    await credential('post',post.token); await credential('post_receiver',post.receiver);
    assert.deepEqual(await loadCredentials(f.directory),f.credentials);
    assert.equal((await stat(join(f.directory,'credentials.json'))).mode & 0o777,0o600);
    f.appServer.env.FAKE_EXPECT_POST_TOKEN = post.token;
    const partner = await f.createPartner();
    const raw = await readFile(codexPath,'utf8'), config = parse(raw), servers = config.mcp_servers as Record<string,Record<string,unknown>>;
    assert.equal(config.model_reasoning_effort,'low'); assert.equal(servers.operator!.command,'operator-tool'); assert.equal(servers.matrix,undefined);
    assert.deepEqual(servers.post,{ url:post.endpoint+'/mcp',bearer_token_env_var:'CFL_POST_TOKEN' });
    assert(!raw.includes(post.token)); assert(!raw.includes(post.receiver));
    assert.equal(JSON.parse(await readFile(f.appServer.env.FAKE_SERVER_CONTEXT!,'utf8')).postTokenMatches,true);
    const client = new Client({ name:'native-bootstrap-fixture',version:'1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(servers.post!.url as string),{ requestInit:{ headers:{ authorization:`Bearer ${post.token}` } } }));
      assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),Object.keys(examples.tools).sort());
      for (const [name, fixture] of Object.entries(examples.tools) as Array<[string,{ arguments:Record<string,unknown>; result:unknown }]>) {
        const result = await client.callTool({ name,arguments:fixture.arguments });
        const expected = name === 'list_accounts' ? { items:['qq','matrix'].map(platform => ({ ...examples.tools.list_accounts.result.items[0],account_id:`${platform}-main`,platform })) } : fixture.result;
        assert.deepEqual(result.structuredContent,expected);
        assert.deepEqual(JSON.parse((result.content as Array<{ text:string }>)[0]!.text),expected);
      }
    } finally { await client.close(); }
    await partner.close(); f.config.post = undefined; f.credentials.post = undefined; f.credentials.post_receiver = undefined;
    await f.createPartner();
    assert.equal((parse(await readFile(codexPath,'utf8')).mcp_servers as Record<string,unknown>).post,undefined);
    await writeFile(codexPath,'[mcp_servers.matrix]\ncommand="operator-matrix"\n[mcp_servers.post]\ncommand="operator-post"\n');
    await ensureHookDeclaration(f.workspace,join(f.workspace,'.lamplit/context.json'));
    assert.equal(((parse(await readFile(codexPath,'utf8')).mcp_servers as Record<string,Record<string,unknown>>).matrix!).command,'operator-matrix');
    await assert.rejects(ensureHookDeclaration(f.workspace,join(f.workspace,'.lamplit/context.json'),undefined,undefined,post.endpoint),/belongs to an operator/);
  } finally { await s.close(); }
});

test('asset helpers enforce origin, encoded route, redirect, full-body cancellation, byte/MIME/image bounds and raw upload', async () => {
  const s = await setup(), redirect = await postService(), {f,post} = s; const asset = examples.upload.result;
  try {
    const path = join(f.directory,'upload.png'); await writeFile(path,post.bytes);
    assert.deepEqual(await uploadPostAsset(post.endpoint,post.token,path,'image/png'),asset);
    const saved = join(f.directory,'download.png'); await savePostAsset(post.endpoint,post.token,asset.asset_id,asset.mime,saved);
    assert.deepEqual(await readFile(saved),post.bytes); assert.equal((await stat(saved)).mode & 0o777,0o600);
    await assert.rejects(savePostAsset(post.endpoint,post.token,asset.asset_id,asset.mime,saved));
    await fetchPostAsset(post.endpoint,post.token,{ ...asset,asset_id:'opaque/id ?#' });
    assert(post.requests.some(r => r.path === '/assets/opaque%2Fid%20%3F%23'));
    const count = post.requests.length;
    for (const asset_id of ['.', '..']) await assert.rejects(fetchPostAsset(post.endpoint,post.token,{ ...asset,asset_id }));
    assert.equal(post.requests.length,count,'URL normalization cannot select another route');
    post.redirectTo = redirect.endpoint + '/assets/leak';
    for (const mode of ['fail','redirect','oversize','mime'] as const) { post.assetMode = mode; await assert.rejects(fetchPostAsset(post.endpoint,post.token,asset)); }
    assert.equal(redirect.requests.length,0,'redirect cannot receive agent credentials');
    post.assetMode = 'stall'; const start = Date.now();
    await assert.rejects(fetchPostAsset(post.endpoint,post.token,asset,AbortSignal.timeout(100))); assert(Date.now()-start < 1000);
    post.assetMode = 'normal'; await writeFile(path,Buffer.alloc(68)); await assert.rejects(uploadPostAsset(post.endpoint,post.token,path,'image/png'));
    for (const endpoint of ['http://example.com','http://user:secret@127.0.0.1:80','https://example.com/mcp','https://example.com?token=secret','file:///tmp/private']) assert.throws(() => postEndpoint(endpoint));
    assert.equal(postEndpoint('https://example.com/'),'https://example.com');
    assert(post.requests.filter(r => r.path).every(r => r.authorization === `Bearer ${post.token}`));
  } finally { await s.close(); await redirect.close(); }
});

test('SQLite receipt conflict/rollback, canonical message dedupe, media checkpoint and historical Matrix read-only provenance', async () => {
  const f = await fixture(); await mkdir(join(f.workspace,'.lamplit'),{ recursive:true });
  const path = partnerPaths(f.workspace).database; let store = new Store(path);
  const e = event('sqlite'), body = JSON.stringify(e), service = 'http://127.0.0.1:8787', id = postInputId(service,e);
  try {
    const broken = event('rollback'); broken.message.assets.push(broken.message.assets[0]!);
    await assert.rejects(store.recordPostEvent(service,broken,JSON.stringify(broken)));
    assert.equal((await store.pendingMessages()).length,0);
    assert.equal(await store.recordPostEvent(service,e,body),id);
    await assert.rejects(store.recordPostEvent(service,e,body+' '));
    const again = structuredClone(e); again.delivery_id += '-same-message';
    assert.equal(await store.recordPostEvent(service,again,JSON.stringify(again)),id);
    const conflict = structuredClone(again); conflict.message.content = [{ type:'text',text:'changed' }]; conflict.message.assets = [];
    await assert.rejects(store.recordPostEvent(service,conflict,JSON.stringify(conflict)));
    assert.equal((await store.pendingMessages()).length,1);
    assert.equal((await store.postMediaAttempt(id,'ast_example')).claimed,true);
    assert.equal((await store.postMediaAttempt(id,'ast_example')).claimed,true);
    await store.close(); store = new Store(path);
    assert.equal((await store.postMediaAttempt(id,'ast_example')).claimed,false);
    await store.recordPostMedia(id,'ast_example','unavailable (test transfer)'); await store.finishPostMedia(id);
    assert.equal((await store.postContext(id))!.ready,true);
    assert.deepEqual((await store.postContext(id))!.event,e);
    assert.match((await store.inputPayload(id))!.input,/unavailable \(test transfer\)/);
    await store.close();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO message_meta(id,created) VALUES(?,?)').run('historical-matrix',123);
    const old = { sender_id:'@alice:test',sender_display_name:'Alice',room_id:'!room:test',body:'original history',timestamp:123 };
    db.prepare('INSERT INTO matrix_sources(message_id,context) VALUES(?,?)').run('historical-matrix',JSON.stringify({ provenance:old,trigger:'mention' })); db.close();
    store = new Store(path); assert.deepEqual((await store.matrixSources(['historical-matrix'])).get('historical-matrix'),old);
  } finally { await store.close(); await f.close(); }
});

test('partial configuration, reused secrets and invalid account discovery fail closed without native startup', async () => {
  const s = await setup(), {f,post} = s;
  try {
    f.credentials.post_receiver = undefined; await assert.rejects(f.createPartner(),/requires/);
    f.credentials.post_receiver = post.token; await assert.rejects(f.createPartner(),/must differ/);
    f.credentials.post_receiver = post.receiver; post.accounts = { accounts:[] };
    await assert.rejects(f.createPartner(),/Post startup discovery failed/);
    assert.equal((await f.requests()).length,0);
    for (const value of [null,{ items:[] },{ items:[examples.tools.list_accounts.result.items[0],examples.tools.list_accounts.result.items[0]] }]) { post.accounts=value; await assert.rejects(discoverPost(post.endpoint,post.token),/Post startup/); }
  } finally { await s.close(); }
});

test('Post deliveries remain ordered during compaction and survive a rejected native start without repeating images', async () => {
  const s = await setup(), {f,post} = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    await f.holdCompaction(true,true);
    let partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    await partner.compact();
    const qq = event('compact'), matrix = event('compact-matrix','matrix');
    assert.equal((await h.send(qq)).status,202); assert.equal((await h.send(matrix)).status,202);
    assert.equal((await starts(f)).length,0); assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,0);
    await f.rejectStart(true); // Releases fake compaction and rejects turn/start.
    await eventually(async () => (await starts(f)).length >= 1);
    const before = post.requests.filter(r => r.path?.startsWith('/assets')).length;
    assert.equal((await h.send(qq)).status,202);
    await partner.checkAlarms();
    assert.equal((await starts(f)).length,1,'failed Post head blocks later delivery until restart');
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,before);
    await h.close(); h = undefined; await f.rejectStart(false);
    partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    await eventually(async () => (await partner.snapshot()).messages.filter(m => m.id.startsWith('post:v1:') && m.delivery === 'acknowledged').length === 2);
    const all = await starts(f);
    assert.equal(all.at(-2)!.clientUserMessageId,postInputId(post.endpoint,qq));
    assert.equal(all.at(-1)!.clientUserMessageId,postInputId(post.endpoint,matrix));
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,2,'checkpointed image is not fetched again');
  } finally { await h?.close(); await s.close(); }
});

test('changed Post origin holds old pending source and permits current binding without rerouting', async () => {
  const s = await setup(), other = await postService(), {f,post} = s;
  let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    await mkdir(join(f.workspace,'.lamplit'),{ recursive:true });
    const store = new Store(partnerPaths(f.workspace).database);
    const held = event('held'); await store.recordPostEvent(post.endpoint,held,JSON.stringify(held)); await store.close();
    f.config.post!.endpoint = other.endpoint;
    const partner = await f.createPartner(); h = await host(partner,f.directory,other.receiver);
    assert.equal((await h.send(event('current'))).status,202);
    await eventually(async () => (await starts(f)).length === 1);
    assert.match((await starts(f))[0]!.input[0]!.text!,/hello/);
    assert.equal((await starts(f))[0]!.clientUserMessageId,postInputId(other.endpoint,event('current')));
    assert.equal(other.requests.filter(r => r.path?.startsWith('/assets')).length,1);
    assert.equal(post.requests.filter(r => r.path?.startsWith('/assets')).length,0);
  } finally { await h?.close(); await s.close(); await other.close(); }
});

test('Post full-body deadline aborts a stalled response without caller cancellation', { timeout:20_000 }, async t => {
  const post = await postService(); post.assetMode = 'stall'; const start = Date.now();
  // Exercise GC during the pending body read without changing the suite's GC policy.
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { fetchPostAsset } from ${JSON.stringify(new URL('../runtime/post-assets.ts', import.meta.url).href)};
    const gc = setInterval(() => global.gc(), 100);
    try {
      await assert.rejects(fetchPostAsset(process.env.POST_TEST_ENDPOINT, process.env.POST_TEST_TOKEN,
        JSON.parse(process.env.POST_TEST_ASSET)), { name: 'TimeoutError' });
    } finally { clearInterval(gc); }
  `], { env: { POST_TEST_ENDPOINT:post.endpoint, POST_TEST_TOKEN:post.token, POST_TEST_ASSET:JSON.stringify(examples.upload.result) }, stdio:['ignore','ignore','pipe'] });
  const closed = once(child, 'close'); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { child.kill('SIGKILL'); });
  try {
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert(Date.now()-start < 17_000);
    await eventually(async () => post.assetOpen === 0);
  } finally { child.kill('SIGKILL'); await post.close(); }
});

test('historical Matrix provenance remains truthful in existing public history after restart', async () => {
  const f = await fixture(), id = 'historical-real-matrix-fixture';
  const provenance = { sender_id:'@alice:test',sender_display_name:'Alice',room_id:'!room:test',body:'historical matrix text',timestamp:1790000000000 };
  try {
    let partner = await f.createPartner(); await partner.submit(id,provenance.body);
    await eventually(async () => !(await partner.snapshot()).typing && await f.consumed(id));
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    db.prepare('INSERT INTO matrix_sources(message_id,context) VALUES(?,?)').run(id,JSON.stringify({ provenance,trigger:'mention' })); db.close();
    partner = await f.createPartner();
    const view = await createCodexChatBackend(partner).read(), historical = view.messages.find(m => m.id === id)!;
    assert(historical); assert.equal(historical.text,provenance.body); assert.equal(historical.createdAt,provenance.timestamp);
    assert.deepEqual(historical.source,{ kind:'matrix',senderId:provenance.sender_id,senderDisplayName:provenance.sender_display_name,roomId:provenance.room_id });
    assert.equal((await starts(f)).length,1,'history is read without reingestion');
  } finally { await f.close(); }
});

test('a failed Post head blocks later Post inputs until restart reconciliation', async t => {
  const s = await setup(), { f,post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  f.config.keet = { endpoint:post.endpoint }; f.credentials.keet = 'synthetic-keet-only-token';
  const a = event('fifo-a'), b = event('fifo-b','matrix');
  for (const e of [a,b]) { e.message.assets = []; e.message.content = [{ type:'text',text:e.message.id }]; }
  const aId = postInputId(post.endpoint,a), bId = postInputId(post.endpoint,b);
  try {
    await f.holdCompaction(true,true);
    let partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    await partner.compact();
    assert.equal((await h.send(a)).status,202); assert.equal((await h.send(b)).status,202);
    await f.rejectStart(true);
    await eventually(async () => (await partner.snapshot()).messages.some(m => m.id === aId && m.delivery === 'unresolved'));
    await partner.checkAlarms(); // Admission barrier: failed A has settled before recovery is enabled.
    await f.rejectStart(false);
    assert.equal((await h.send(b)).status,202); // Retry invalidation drives the real queue again.
    await partner.checkAlarms();
    const before = (await starts(f)).map(call => call.clientUserMessageId);
    // If the broken selector started B, let it finish before reopening the same owned state.
    if (before.includes(bId)) await eventually(async () => await f.consumed(bId) && !(await partner.snapshot()).typing);
    const keetId = crypto.randomUUID();
    await partner.ingestKeet({ type:'message',eventId:keetId,sequence:1,messageId:{ deviceId:'peer',seq:1 },timestamp:1,destination:{ groupName:'Peer',kind:'dm' },senderLabel:'Peer',text:'independent Keet input',addressing:{ mentionsIdentity:false } });
    await eventually(async () => await f.consumed(`keet:webhook:${keetId}`) && !(await partner.snapshot()).typing);
    assert.equal((await starts(f)).filter(call => call.clientUserMessageId === aId).length,1,'Keet completion cannot retry failed Post head');
    await h.close(); h = undefined;
    partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    await eventually(async () => await f.consumed(aId) && await f.consumed(bId) && !(await partner.snapshot()).typing);
    const after = (await starts(f)).map(call => call.clientUserMessageId).filter(id => id === aId || id === bId);
    const native = JSON.parse(await readFile(join(f.directory,'fake-state.json'),'utf8')) as { turns:Array<{ items:Array<{ type:string; clientId?:string }> }> };
    const executed = native.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage' && (item.clientId === aId || item.clientId === bId)).map(item => item.clientId!));
    const label = (ids: string[]) => ids.map(id => id === aId ? 'A' : id === bId ? 'B' : id);
    t.diagnostic(JSON.stringify({ beforeRestartAttempts:label(before), allAttempts:label(after), executionOrder:label(executed) }));
    assert.deepEqual(label(executed),['A','B']);
    assert.deepEqual(label(before),['A'],'later Post delivery cannot overtake a failed head or retry it in-process');
    assert.deepEqual(label(after),['A','A','B'],'only fresh restart reconciliation may retry the rejected head');
  } finally { await h?.close(); await s.close(); }
});

test('Post native images retain content order with reversed metadata and checkpoint restart', async t => {
  const s = await setup(), {f,post} = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  const a = post.bytes, b = await sharp({ create:{ width:1,height:1,channels:3,background:'#1f8c45' } }).png().toBuffer();
  post.assetBytes.set('ast_a',a); post.assetBytes.set('ast_b',b);
  const e = event('ordered-images');
  e.message.content = [{ type:'file',asset_id:'ast_b' },{ type:'image',asset_id:'ast_a' },{ type:'image',asset_id:'ast_b' }];
  e.message.assets = [['ast_b',b],['ast_a',a]].map(([id,bytes]) => ({ asset_id:id as string,status:'available',mime:'image/png',name:`${id}.png`,size:(bytes as Buffer).length,download_path:`/assets/${id}` }));
  try {
    await f.rejectStart(true);
    let partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    assert.equal((await h.send(e)).status,202);
    await eventually(async () => (await partner.snapshot()).messages.some(m => m.id === postInputId(post.endpoint,e) && m.delivery === 'unresolved'));
    await partner.checkAlarms();
    const order = async (call: Awaited<ReturnType<typeof starts>>[number]) => Promise.all(call.input.filter(p => p.type === 'localImage').map(async p => {
      const bytes = await readFile(p.path!); return bytes.equals(a) ? 'A' : bytes.equals(b) ? 'B' : 'unknown';
    }));
    const before = await order((await starts(f))[0]!);
    const downloads = post.requests.filter(r => r.path?.startsWith('/assets')).map(r => r.path);
    await h.close(); h = undefined; await f.rejectStart(false);
    partner = await f.createPartner(); h = await host(partner,f.directory,post.receiver);
    await eventually(async () => await f.consumed(postInputId(post.endpoint,e)) && !(await partner.snapshot()).typing);
    const after = await order((await starts(f))[1]!);
    t.diagnostic(JSON.stringify({ content:['A','B'],metadata:['B','A'],beforeRestartImages:before,afterRestartImages:after,downloads }));
    assert.deepEqual(before,['A','B']); assert.deepEqual(after,['A','B']);
    let displayed = (await createCodexChatBackend(partner).read()).messages.find(m => m.id === postInputId(post.endpoint,e))!;
    assert.equal(displayed.images!.length,2); assert(displayed.text.includes('[file "ast_b": attached]'));
    assert(!displayed.text.includes('[image '), 'each exact available attachment replaces only its image marker');
    const lost = (await starts(f))[1]!.input.filter(p => p.type === 'localImage')[0]!.path!;
    assert(lost.startsWith(f.directory + '/')); await unlink(lost);
    displayed = (await createCodexChatBackend(partner).read()).messages.find(m => m.id === postInputId(post.endpoint,e))!;
    assert(displayed.text.includes('[image "ast_a": attached]'));
    assert(!displayed.text.includes('[image "ast_b"'), 'remaining available B cannot hide missing A after reversed-metadata restart');

    assert.deepEqual(post.requests.filter(r => r.path?.startsWith('/assets')).map(r => r.path),['/assets/ast_a','/assets/ast_b'],'checkpoint restart does not refetch either image');
  } finally { await h?.close(); await s.close(); }
});


test('canonical send selector accepts names and rejects mixed targets through authenticated fixture MCP', async () => {
  const post = await postService(), client = new Client({ name: 'send-selector-fixture', version: '1' });
  const common = { request_id: 'owned-selector-request', content: [{ type: 'text', text: 'owned fake send only' }] };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(post.endpoint + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${post.token}` } } }));
    const listed = (await client.listTools()).tools.find(t => t.name === 'send_message')!;
    for (const target of [
      { conversation_name: 'Owned group' },
      { conversation_name: 'Owned peer', account_id: 'qq-main', platform: 'qq', conversation_type: 'direct' },
    ]) {
      const result = await client.callTool({ name: 'send_message', arguments: { ...common, ...target } });
      assert(!result.isError, 'canonical valid selector accepted by real MCP schema');
      assert.deepEqual(result.structuredContent, examples.tools.send_message.result, 'outputs unchanged; fixture does not resolve or send');
    }
    assert(listed.inputSchema.properties?.conversation_name, 'advertised tool exposes preferred name selector');
    for (const name of ['get_conversation', 'list_members', 'read_messages']) {
      assert(!(await client.callTool({ name, arguments: { conversation_name: 'Owned group', account_id: 'qq-main' } })).isError);
      assert.equal((await client.callTool({ name, arguments: { account_id: 'qq-main', conversation_id: 'owned-conversation' } })).isError, true);
    }
    for (const target of [
      {}, { account_id: 'qq-main' }, { conversation_id: 'owned-conversation' }, { account_id: 'qq-main', conversation_id: 'owned-conversation' },
      { conversation_name: '' }, { conversation_name: 'x'.repeat(257) },
      { conversation_name: 'Owned group', conversation_id: 'owned-conversation' },
      { conversation_name: 'Owned group', account_id: 'qq-main', conversation_id: 'owned-conversation' },
      { account_id: 'qq-main', conversation_id: 'owned-conversation', platform: 'qq' },
      { conversation_name: 'Owned group', extra: true },
    ]) {
      const result = await client.callTool({ name: 'send_message', arguments: { ...common, ...target } });
      assert.equal(result.isError, true, 'invalid selector rejected by actual MCP fixture');
    }
  } finally { await client.close(); await post.close(); }
});


test('retained Post provenance reaches source UI with original body media and time across restart', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  const events: Array<ReturnType<typeof event>> = [], expectedMessages: ChatView['messages'] = [];
  let chat: Awaited<ReturnType<typeof openChat>> | undefined;
  let socket: WebSocket | undefined, publicView: ChatView | undefined;
  async function connect() {
    publicView = undefined;
    socket = new WebSocket(h!.origin.replace('http:', 'ws:') + '/api/chat/socket');
    chat = await openChat(socket, view => { publicView = view; }, () => {});
    await eventually(async () => publicView?.messages.filter(m => m.role === 'user').length === 4);
    for (const message of expectedMessages) assert.deepEqual(publicView!.messages.find(m => m.id === message.id), message, 'public strict serialized view matches retained source');
    const history = await chat.history(JSON.stringify({ before: Number.MAX_SAFE_INTEGER }));
    for (const message of expectedMessages) assert.deepEqual(history.messages.find(m => m.id === message.id), message);
  }
  try {
    let partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    for (const [index, platform] of (['qq', 'qq', 'matrix', 'qq'] as const).entries()) {
      const e = event(`source-ui-${index}`, platform);
      if (index === 0) e.message.conversation.name = 'Captured genuine group';
      else delete e.message.conversation.name;
      e.message.conversation.type = index === 1 || index === 3 ? 'direct' : 'group';
      if (index === 1) e.message.conversation.native_id = e.message.sender.native_id;
      e.message.sender.name = index === 0 ? '😀'.repeat(300) : index === 1 ? 'Owned direct peer' : index === 2 ? ' \n ' : 'Unrelated sender';
      e.message.content = [{ type: 'text', text: `Original body ${index}\nsecond line` }, { type: 'image', asset_id: 'ast_example' }];
      events.push(e);
      assert.equal((await h.send(e)).status, 202);
      await eventually(async () => (await starts(f)).length === index + 1 && !(await partner.snapshot()).typing);
      const view = await createCodexChatBackend(partner).read();
      const message = view.messages.find(m => m.id === postInputId(post.endpoint, e))!;
      assert.equal(message.source?.kind, 'post', 'real retained Post source is projected instead of an ordinary bubble');
      assert.deepEqual(message.source, { kind: 'post', platform, conversationType: e.message.conversation.type,
        conversationId: e.message.conversation.id, senderId: e.message.sender.native_id,
        ...(index === 2 ? {} : { senderDisplayName: Array.from(e.message.sender.name.trim()).slice(0, 256).join('') }),
        ...(index === 0 ? { conversationName: 'Captured genuine group' } : index === 1 ? { conversationName: e.message.sender.name } : {}) });
      assert.equal(message.text, `Original body ${index}\nsecond line`);
      assert.equal(message.createdAt, e.message.timestamp);
      assert.equal(message.images?.length, 1);
      assert.equal(message.images![0]!.availability, 'available');
      expectedMessages.push(message);
    }
    const reads = post.requests.filter(r => r.tool === 'list_conversations').length;
    const backend = createCodexChatBackend(partner);
    await backend.read();
    const history = await backend.history(JSON.stringify({ before: Number.MAX_SAFE_INTEGER }));
    for (const message of expectedMessages) assert.deepEqual(history.messages.find(m => m.id === message.id), message);
    await connect();
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length, reads, 'UI projection performs no remote metadata lookup');
    chat!.close(); chat = undefined; socket = undefined;
    await h.close(); h = undefined;
    partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    for (const e of events) assert.equal((await h.send(e)).status, 202);
    const restored = await createCodexChatBackend(partner).read();
    for (const message of expectedMessages) assert.deepEqual(restored.messages.find(m => m.id === message.id), message);
    await connect();
    assert.equal((await starts(f)).length, 4, 'history/duplicates never reingest or execute');
    assert.equal(post.requests.filter(r => r.tool === 'list_conversations').length, reads);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { chat?.close(); socket?.close(); await h?.close(); await s.close(); }
});


test('captured Post conversation names are accepted as immutable external display data with historical absence', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    post.conversationMode = 'fail';
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    for (const [index, name] of ['Captured real group', undefined].entries()) {
      const e = event(`captured-name-${index}`);
      e.message.conversation = { id: e.message.conversation.id, native_id: e.message.conversation.native_id,
        type: 'group', ...(name ? { name } : {}) };
      assert.equal((await h.send(e)).status, 202, 'canonical optional name accepted; historical absence stays valid');
      await eventually(async () => (await starts(f)).length === index + 1 && !(await partner.snapshot()).typing);
      const call = (await starts(f))[index]!;
      const routing = JSON.parse(contextValue(call, 'codex-for-love.post-metadata'));
      assert.deepEqual(routing.conversation, { id: e.message.conversation.id, native_id: e.message.conversation.native_id, type: 'group' });
      assert.equal(JSON.parse(contextValue(call, 'codex-for-love.post-authored')).conversation_name, null);
      assert(call.input[0]!.text!.split('\n')[0]!.includes('name unavailable'));
      assert.equal((await partner.snapshot()).messages.find(m => m.id === postInputId(post.endpoint, e))!.post!.source.conversationName, name);
      assert.equal((await h.send(e)).status, 202);
      const changed = structuredClone(e); changed.message.conversation = { ...e.message.conversation, name: 'Different captured name' };
      assert.equal((await h.send(changed)).status, 409, 'display metadata does not rewrite immutable receipt/body');
    }
    const invalid = event('invalid-captured-name');
    for (const name of ['', 'x'.repeat(257)]) assert.equal((await h.send({ ...invalid, message: { ...invalid.message, conversation: { ...invalid.message.conversation, name } } })).status, 422);
    assert.equal((await starts(f)).length, 2);
    assert.equal(post.requests.filter(r => r.tool === 'send_message').length, 0);
  } finally { await h?.close(); await s.close(); }
});


test('canonical send-only mention names use strict XOR while event and history content stays native-ID', async () => {
  const post = await postService(), client = new Client({ name: 'send-mention-fixture', version: '1' });
  const args = { request_id: 'owned-mention', conversation_name: 'Owned group' };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(post.endpoint + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${post.token}` } } }));
    for (const content of [[{ type: 'mention', name: 'Owned peer' }], [{ type: 'mention', native_user_id: 'owned-native-peer' }]]) {
      const result = await client.callTool({ name: 'send_message', arguments: { ...args, content } });
      assert(!result.isError, 'send-only name or native-ID mention accepted');
    }
    for (const mention of [{ type: 'mention' }, { type: 'mention', name: '' }, { type: 'mention', name: 'x'.repeat(257) },
      { type: 'mention', name: 'Owned peer', native_user_id: 'owned-native-peer' }, { type: 'mention', name: 'Owned peer', extra: true }]) {
      assert.equal((await client.callTool({ name: 'send_message', arguments: { ...args, content: [mention] } })).isError, true);
    }
    const e = event('mention-native-history');
    assert(PostEventV1.safeParse(e).success);
    const invalid = { ...e, message: { ...e.message, content: [{ type: 'mention', name: 'Must not enter history' }], assets: [] } };
    assert(!PostEventV1.safeParse(invalid).success);
    assert(ToolOutputs.read_messages.safeParse(examples.tools.read_messages.result).success);
    assert(!ToolOutputs.read_messages.safeParse({ items: [invalid.message], next_before: null }).success);
  } finally { await client.close(); await post.close(); }
});


test('Post display suppresses only the exact available shared image and preserves unavailable and other media', async () => {
  const s = await setup(), { f, post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  try {
    const partner = await f.createPartner(); h = await host(partner, f.directory, post.receiver);
    const e = event('display-media-correspondence');
    const original = e.message.assets[0]!;
    e.message.assets = [original, { ...original, asset_id: 'missing-image', status: 'unavailable', size: null, download_path: null },
      ...(['file', 'audio', 'video'] as const).map(type => ({ ...original, asset_id: type, download_path: `/assets/${type}` }))];
    e.message.content = [{ type: 'text', text: 'original body' }, { type: 'image', asset_id: original.asset_id },
      { type: 'image', asset_id: 'missing-image' }, ...(['file', 'audio', 'video'] as const).map(type => ({ type, asset_id: type }))];
    assert.equal((await h.send(e)).status, 202);
    await eventually(async () => (await starts(f)).length === 1 && !(await partner.snapshot()).typing);
    const call = (await starts(f))[0]!, id = postInputId(post.endpoint, e);
    assert(call.input[0]!.text!.includes('[image "ast_example": attached]'), 'native body stays unchanged');
    let message = (await createCodexChatBackend(partner).read()).messages.find(m => m.id === id)!;
    assert(!message.text.includes('[image "ast_example"'), 'actual available shared attachment represents this exact image part');
    assert(message.text.includes('[image "missing-image": unavailable (Post)]'));
    for (const type of ['file', 'audio', 'video']) assert(message.text.includes(`[${type} "${type}": available via Post asset-fetch]`));
    assert.equal(message.images!.length, 1); assert.equal(message.images![0]!.availability, 'available');
    const path = call.input.find(part => part.type === 'localImage')!.path!;
    assert(path.startsWith(f.directory + '/')); await unlink(path);
    message = (await createCodexChatBackend(partner).read()).messages.find(m => m.id === id)!;
    assert.equal(message.images![0]!.availability, 'missing');
    assert(message.text.includes('[image "ast_example": attached]'), 'checkpoint status alone cannot hide a nonavailable shared attachment');
  } finally { await h?.close(); await s.close(); }
});
