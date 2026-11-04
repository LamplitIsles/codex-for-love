import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, chmod, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTtsSettings } from '../runtime/tts-settings.ts';
import { voiceFixture } from './voice-fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { once } from 'node:events';
import type { AuthStore } from '../runtime/auth.ts';
import { fixture } from './fixture.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

test('TTS settings preserve four selections, separate keys, legacy defaults and concurrent updates', async () => {
  const state = await mkdtemp(join(tmpdir(),'tts-settings-'));
  const fallback = () => ({tts:{provider:'minimax' as const,voice:'legacy',speed:1.2},credentials:{speech:'asr-key',tts:'legacy-tts'}});
  try {
    const settings = createTtsSettings(state,fallback);
    assert.deepEqual(await settings.snapshot(),{provider:'minimax',voices:{minimax:'legacy',alibaba:'',bytedance:'',elevenlabs:''},speeds:{minimax:1.2,bytedance:null},configured:{alibaba:true,bytedance:true,elevenlabs:false}});
    await Promise.all([settings.saveKey({provider:'alibaba',apiKey:'output-key'}),settings.saveKey({provider:'elevenlabs',apiKey:'eleven-key'}),settings.save({provider:'bytedance',voice:' byte ',speed:1.3})]);
    const reloaded = createTtsSettings(state,fallback);
    assert.equal((await reloaded.selection()).keys.alibaba,'output-key');
    assert.equal((await reloaded.selection()).keys.bytedance,'legacy-tts');
    assert.equal((await reloaded.selection()).keys.elevenlabs,'eleven-key');
    for (const provider of ['alibaba','elevenlabs','minimax','bytedance'] as const) await reloaded.save({provider,voice:`${provider}-id`,speed:provider === 'minimax' || provider === 'bytedance' ? 1.1 : null});
    const snapshot = await reloaded.snapshot();
    assert.deepEqual(snapshot.voices,{minimax:'minimax-id',alibaba:'alibaba-id',bytedance:'bytedance-id',elevenlabs:'elevenlabs-id'});
    assert.equal(snapshot.provider,'bytedance'); assert.doesNotMatch(JSON.stringify(snapshot),/key/);
    assert.equal((await stat(join(state,'tts-settings.json'))).mode & 0o777,0o600);
    assert.equal(fallback().credentials.speech,'asr-key');
    for (const value of [{provider:'alibaba',voice:'v',speed:1},{provider:'elevenlabs',voice:' ',speed:null},{provider:'minimax',voice:'v',speed:2.1},{provider:'minimax',voice:'v',speed:null,extra:1}]) await assert.rejects(settings.save(value),{code:'invalid_tts_settings'});
    for (const apiKey of ['', ' secret','a\nb','x'.repeat(513)]) await assert.rejects(settings.saveKey({provider:'alibaba',apiKey}),{code:'invalid_tts_key'});
    const before = await readFile(join(state,'tts-settings.json'),'utf8');
    await assert.rejects(settings.saveKey({provider:'alibaba',apiKey:'denied'},()=>false),{code:'unauthorized'});
    assert.equal(await readFile(join(state,'tts-settings.json'),'utf8'),before);
    await chmod(join(state,'tts-settings.json'),0o644); await assert.rejects(settings.snapshot(),{code:'tts_settings_unavailable'});
    await rm(join(state,'tts-settings.json')); await symlink(join(state,'other'),join(state,'tts-settings.json')); await assert.rejects(settings.snapshot(),{code:'tts_settings_unavailable'});
  } finally { await rm(state,{recursive:true,force:true}); }
});

test('TTS HTTP endpoints enforce origin, methods, validation, and never return secrets', async () => {
  const f = await voiceFixture();
  try {
    const url = `${f.origin}/api/tts/settings`;
    const post = (path:string, input:unknown, origin=f.origin) => fetch(`${f.origin}${path}`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)});
    let r = await fetch(url); assert.equal(r.status,200); assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal((await r.json() as any).provider,null);
    r = await post('/api/tts/settings/key',{provider:'alibaba',apiKey:'secret'},'http://evil.invalid'); assert.equal(r.status,403);
    r = await post('/api/tts/settings/key',{provider:'alibaba',apiKey:'output-secret'}); assert.equal(r.status,200); assert.doesNotMatch(await r.text(),/output-secret/);
    assert.equal((await f.partner.voiceSettings.selection()).apiKey,'fixture-key');
    r = await post('/api/tts/settings',{provider:'elevenlabs',voice:'id',speed:null}); assert.equal(r.status,200); assert.equal((await r.json() as any).provider,'elevenlabs');
    r = await post('/api/tts/settings',{provider:'elevenlabs',voice:'id',speed:1}); assert.equal(r.status,400);
    r = await fetch(`${f.origin}/api/tts/elevenlabs/voices`); assert.equal(r.status,400); assert.equal(r.headers.get('cache-control'),'no-store');
    r = await post('/api/tts/settings/key',{provider:'elevenlabs',apiKey:'voice-secret'}); assert.equal(r.status,200);
    const realFetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = async (input, init) => {
      const target = new URL(String(input));
      if (target.hostname !== 'api.elevenlabs.io') return realFetch(input, init);
      calls++; assert.equal(target.searchParams.get('voice_type'),'saved');
      if (calls === 2) return new Response('voice-secret', {status:403});
      return Response.json({ voices:[{voice_id:'id',name:'Saved',category:'cloned'}],has_more:true,next_page_token:'next',total_count:1 });
    };
    try {
      r = await realFetch(`${f.origin}/api/tts/elevenlabs/voices`); assert.deepEqual(await r.json(),{voices:[{id:'id',name:'Saved'}],nextCursor:'next'});
      r = await realFetch(`${f.origin}/api/tts/elevenlabs/voices?cursor=next`); assert.equal(r.status,503); assert.doesNotMatch(await r.text(),/voice-secret/);
      r = await realFetch(`${f.origin}/api/tts/elevenlabs/voices?cursor=x&cursor=y`); assert.equal(r.status,400); assert.equal(calls,2);
    } finally { globalThis.fetch = realFetch; }
    r = await fetch(url,{method:'PUT',headers:{origin:f.origin}}); assert.equal(r.status,405);
    let authorized = false;
    const auth = { authorize: () => authorized, sameOrigin: () => true, close() {} } as unknown as AuthStore;
    const app = createWebServer(f.partner, `${f.f.directory}/assets`, {auth});
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try {
      const origin = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
      for (const path of ['/api/tts/settings','/api/tts/elevenlabs/voices']) { const denied = await fetch(`${origin}${path}`); assert.equal(denied.status,401); assert.equal(denied.headers.get('cache-control'),'no-store'); }
      const denied = await fetch(`${origin}/api/tts/settings/key`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'alibaba',apiKey:'unauthorized'})}); assert.equal(denied.status,401);
      authorized = true;
      assert.equal((await (await fetch(`${origin}/api/tts/settings`)).json() as any).configured.alibaba,true);
    } finally { await app.close(); }

  } finally { await f.close(); }
});


test('live TOML and CLI credential fallbacks agree between HTTP settings and the next Companion dispatch', async () => {
  const f = await fixture();
  const configPath = join(f.directory, 'partner.toml');
  const credentialsPath = join(f.directory, 'credentials.json');
  const configText = (provider: string, voice: string) => `name = "test"\nstate = ${JSON.stringify(f.directory)}\nworkspace = ${JSON.stringify(f.workspace)}\nprompts = { persona = "persona.md" }\n[speech.tts]\nprovider = "${provider}"\nvoice = "${voice}"\n`;
  const audioDir = join(f.workspace, '.lamplit', 'audio');
  const client = new Client({ name: 'test', version: '1' });
  let app: ReturnType<typeof createWebServer> | undefined;
  try {
    await writeFile(configPath, configText('minimax', 'old-voice'));
    await writeFile(credentialsPath, JSON.stringify({ speech: 'old-input' }), { mode: 0o600 });
    f.config.configPath = configPath;
    f.config.speech = { tts: { provider: 'minimax', voice: 'old-voice' } };
    f.credentials.speech = 'old-input';
    const partner = await f.createPartner();
    const auth = { authorize: () => true, sameOrigin: () => true, close() {} } as unknown as AuthStore;
    app = createWebServer(partner, join(f.directory, 'assets'), { auth });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const snapshot = async () => (await (await fetch(`${origin}/api/tts/settings`)).json()) as Awaited<ReturnType<typeof partner.ttsSettings.snapshot>>;
    assert.equal((await snapshot()).voices.minimax, 'old-voice');
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../runtime/companion-mcp.ts', import.meta.url)), f.workspace, configPath], stderr: 'ignore' }));
    await mkdir(audioDir, { recursive: true });
    const audioId = createHash('sha256').update(JSON.stringify([2, 'elevenlabs', 'eleven_v4', 'new-voice', 1, 'hello'])).digest('hex');
    await writeFile(join(audioDir, `${audioId}.mp3`), Buffer.from('test-owned cache'));
    await writeFile(configPath, configText('elevenlabs', 'new-voice'));
    await writeFile(credentialsPath, JSON.stringify({ tts: 'new-byte-key' }), { mode: 0o600 });
    const current = await snapshot();
    assert.equal(current.provider, 'elevenlabs'); assert.equal(current.voices.elevenlabs, 'new-voice');
    assert.deepEqual(current.configured, { alibaba: false, bytedance: true, elevenlabs: false });
    const sent = await client.callTool({ name: 'send_voice', arguments: { text: 'hello' } });
    assert.equal(sent.isError, undefined);
    assert.deepEqual(JSON.parse((sent.content as Array<{text:string}>)[0].text), { kind: 'voice', audioId });
    assert.equal((await partner.voiceSettings.selection()).apiKey, 'old-input');
    await partner.ttsSettings.saveKey({ provider: 'alibaba', apiKey: 'output-only' }, () => true);
    await partner.ttsSettings.save({ provider: 'minimax', voice: 'override', speed: null }, () => true);
    const overridden = await snapshot();
    assert.equal(overridden.provider, 'minimax'); assert.equal(overridden.voices.elevenlabs, 'new-voice');
    assert.deepEqual(overridden.configured, { alibaba: true, bytedance: true, elevenlabs: false });
    assert.equal((await partner.voiceSettings.selection()).apiKey, 'old-input');
  } finally {
    await client.close();
    if (app) await app.close();
    await f.close();
  }
});
