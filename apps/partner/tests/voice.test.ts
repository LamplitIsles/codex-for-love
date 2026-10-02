import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { openChat } from '@lamplit/contracts/client';
import { MAX_VOICE_FRAME_BYTES } from '@lamplit/contracts/voice';
import { voiceFixture } from './voice-fixture.ts';
import { eventually } from './fixture.ts';

test('Node voice and chat share one upgrade owner; PCM streams before finish, final sentences replace/order, no Codex admission', async () => {
  const f = await voiceFixture();
  try {
    assert.deepEqual(await (await fetch(`${f.origin}/api/voice/capability`)).json(), {available: true});
    assert.equal(f.state.calls, 0);
    const chat = await openChat(new globalThis.WebSocket(`${f.origin.replace('http', 'ws')}/api/chat/socket`), () => {}, () => {});
    const c = await f.client(); await c.wait('ready');
    c.ws.send(Buffer.alloc(3200), {binary: true});
    await eventually(async () => f.state.frames === 1);
    assert.equal(f.state.auth, 'Bearer fixture-key');
    assert.deepEqual(c.events, [{type: 'ready'}]);
    assert.deepEqual(f.state.events, ['run-task', 'pcm']);
    c.ws.send(JSON.stringify({type: 'finish'}));
    assert.deepEqual(await c.wait('result'), {type: 'result', text: 'recognized final'});
    await eventually(async () => f.state.closes === 1);
    assert.equal((await f.f.requests()).some(r => r.method === 'turn/start'), false);
    await chat.submit({operationId: crypto.randomUUID(), text: 'explicit send'});
    await eventually(async () => (await f.f.requests()).some(r => r.method === 'turn/start'));
    chat.close();
  } finally {await f.close();}
});

test('exact voice Origin rejects missing and foreign origins before contacting provider; disabled capability keeps text usable', async () => {
  const f = await voiceFixture();
  try {
    await assert.rejects(f.client('http://other.invalid'));
    await assert.rejects(f.client(''));
    assert.equal(f.state.calls, 0);
    f.f.credentials.speech = undefined;
    assert.deepEqual(await (await fetch(`${f.origin}/api/voice/capability`)).json(), {available: false});
    const c = await f.client(); assert.deepEqual(await c.wait('error'), {type:'error', code:'voice_disabled'});
    assert.equal(f.state.calls, 0);
    const chat = await openChat(new globalThis.WebSocket(`${f.origin.replace('http','ws')}/api/chat/socket`), () => {}, () => {});
    await chat.submit({operationId:crypto.randomUUID(), text:'speech disabled text'}); chat.close();
    await eventually(async () => (await f.f.requests()).some(r => r.method === 'turn/start'));
    assert.equal((await fetch(`${f.origin}/api/voice/capability`, {method:'POST'})).status, 405);
    assert.equal((await fetch(`${f.origin}/api/voice/stream`)).status, 426);
  } finally {await f.close();}
});

test('cancel, disconnect and host shutdown terminate provider resources without a turn', async () => {
  const f = await voiceFixture();
  try {
    const cancel = await f.client(); await cancel.wait('ready'); cancel.ws.send(JSON.stringify({type:'cancel'}));
    assert.deepEqual(await cancel.wait('error'), {type:'error', code:'cancelled'});
    const gone = await f.client(); await gone.wait('ready'); gone.ws.close();
    await eventually(async () => f.state.closes === 2);
    const shutdown = await f.client(); await shutdown.wait('ready');
    const closed = once(shutdown.ws, 'close'); await f.app.close(); await closed;
    await eventually(async () => f.state.closes === 3);
    assert.equal((await f.f.requests()).some(r => r.method === 'turn/start'), false);
  } finally {await f.close();}
});

test('ready/finish gating, invalid controls/PCM and malformed or unfinished provider result fail closed', async () => {
  const f = await voiceFixture();
  try {
    f.state.holdReady = true;
    const early = await f.client(); early.ws.send(Buffer.alloc(2));
    assert.deepEqual(await early.wait('error'), {type:'error', code:'invalid_audio'});
    f.state.holdReady = false;
    for (const frame of [Buffer.alloc(0), Buffer.alloc(1), '', JSON.stringify({type:'finish', extra:true}), JSON.stringify({type:'finish'})]) {
      const c = await f.client(); await c.wait('ready'); c.ws.send(frame);
      assert.deepEqual(await c.wait('error'), {type:'error', code:'invalid_audio'});
    }
    const huge = await f.client(); await huge.wait('ready'); const closed = once(huge.ws, 'close'); huge.ws.send(Buffer.alloc(MAX_VOICE_FRAME_BYTES + 2)); await closed;
    for (const fault of ['malformed', 'unfinished'] as const) {
      f.state[fault] = true;
      const c = await f.client(); await c.wait('ready'); c.ws.send(Buffer.alloc(2)); c.ws.send(JSON.stringify({type:'finish'}));
      assert.deepEqual(await c.wait('error'), {type:'error', code:'transcript_invalid'}); f.state[fault] = false;
    }
    assert.equal((await f.f.requests()).some(r => r.method === 'turn/start'), false);
  } finally {await f.close();}
});

test('provider rejection maps stable wire errors, setup/lifetime/finish timeouts close upstream', async () => {
  const f = await voiceFixture({setup:1000, lifetime:1500, finish:1000});
  try {
    for (const [status, code] of [[401,'invalid_key'], [429,'rate_limited'], [500,'upstream_error']] as const) {
      f.state.reject = status; const c = await f.client(); assert.deepEqual(await c.wait('error'), {type:'error', code});
    }
    f.state.reject = 0; f.state.holdReady = true;
    const setup = await f.client(); assert.deepEqual(await setup.wait('error'), {type:'error', code:'timeout'});
    f.state.holdReady = false;
    const lifetime = await f.client(); await lifetime.wait('ready'); assert.deepEqual(await lifetime.wait('error'), {type:'error', code:'timeout'});
    f.state.holdFinish = true;
    const finish = await f.client(); await finish.wait('ready'); finish.ws.send(Buffer.alloc(2)); finish.ws.send(JSON.stringify({type:'finish'}));
    assert.deepEqual(await finish.wait('error'), {type:'error', code:'timeout'});
    await eventually(async () => f.state.closes === 3);
  } finally {await f.close();}
});
