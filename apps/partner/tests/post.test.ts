import assert from 'node:assert/strict';
import sharp from 'sharp';
import { test } from 'node:test';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, eventually } from './fixture.ts';
import { event, examples, postService } from './post-fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { postInputId, discoverPost } from '../runtime/post.ts';
import { fetchPostAsset, uploadPostAsset, savePostAsset } from '../runtime/post-assets.ts';
import { postEndpoint, loadConfig, loadCredentials } from '../runtime/config.ts';
import { ensureHookDeclaration } from '../runtime/context-bootstrap.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import type { Partner } from '../runtime/partner.ts';

const starts = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.requests()).filter(r => r.method === 'turn/start').map(r => r.params as { threadId: string; clientUserMessageId: string; input: Array<{ type: string; text?: string; path?: string }>; additionalContext: Record<string,{ kind: string; value: string }> });
async function setup() {
  const post = await postService(), f = await fixture();
  f.config.post = { endpoint: post.endpoint, agent_id: 'cfl' }; f.credentials.post = post.token; f.credentials.post_receiver = post.receiver;
  return { post, f, async close() { await f.close(); await post.close(); } };
}
async function host(partner: Partner, dir: string, receiver: string) {
  const app = createWebServer(partner,join(dir,'assets'));
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { ...app, origin, send(value: unknown, token = receiver) { return fetch(origin + '/api/post/events',{ method:'POST',headers: { authorization:`Bearer ${token}`, 'content-type':'application/json' },body: typeof value === 'string' ? value : JSON.stringify(value) }); } };
}

test('QQ and Matrix use one native thread, immutable provenance, generic images/text and durable dedupe after restart', async () => {
  const s = await setup(), { f,post } = s; let h: Awaited<ReturnType<typeof host>> | undefined;
  const qq = event('qq'), matrix = event('matrix','matrix');
  try {
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
      const source = JSON.parse(metadata); assert.equal(source.platform,e.message.platform); assert.equal(source.account_id,e.message.account_id); assert.deepEqual(source.conversation,e.message.conversation);
      assert.match(call.additionalContext['codex-for-love.post-source']!.value,/does not authorize outgoing/);
    }
    const view = await createCodexChatBackend(partner).read();
    assert(view.messages.some(m => m.text.includes('Post qq')));
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
    await writeFile(configPath,`name="Test"\npersona="persona.md"\nstate="."\n[post]\nendpoint="${post.endpoint}"\nagent_id="cfl"\n`);
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

test('Post full-body deadline aborts a stalled response without caller cancellation', { timeout:20_000 }, async () => {
  const post = await postService(); post.assetMode = 'stall'; const start = Date.now();
  try { await assert.rejects(fetchPostAsset(post.endpoint,post.token,examples.upload.result)); assert(Date.now()-start < 17_000); }
  finally { await post.close(); }
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
    assert.deepEqual(post.requests.filter(r => r.path?.startsWith('/assets')).map(r => r.path),['/assets/ast_a','/assets/ast_b'],'checkpoint restart does not refetch either image');
  } finally { await h?.close(); await s.close(); }
});
