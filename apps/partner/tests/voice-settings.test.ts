import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, mkdir, chmod, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceSettings } from '../runtime/voice-settings.ts';
import { voiceFixture } from './voice-fixture.ts';

test('voice settings persist atomically, preserve CLI secrets and require a new key on region changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-settings-'));
  try {
    const credentials = '{"speech":"legacy","tts":"other"}';
    await writeFile(join(directory, 'credentials.json'), credentials);
    const settings = createVoiceSettings(directory, () => 'legacy');
    assert.deepEqual(await settings.snapshot(), { region: 'beijing', configured: true });
    await settings.save({ region: 'beijing', apiKey: '' });
    await assert.rejects(settings.save({ region: 'singapore', apiKey: '' }), { code: 'voice_key_required' });
    await settings.save({ region: 'singapore', apiKey: 'singapore-secret' });
    assert.deepEqual(await createVoiceSettings(directory, () => 'changed-cli').selection(), { region: 'singapore', apiKey: 'singapore-secret' });
    assert.equal(await readFile(join(directory, 'credentials.json'), 'utf8'), credentials);
    assert.equal((await stat(join(directory, 'voice-settings.json'))).mode & 0o777, 0o600);
    for (const input of [{region:'other',apiKey:'key'}, {region:'beijing',apiKey:' key'}, {region:'beijing',apiKey:'a\nb'}, {region:'beijing',apiKey:'x'.repeat(513)}, {region:'beijing',apiKey:'key',extra:true}]) {
      await assert.rejects(settings.save(input), { code: 'invalid_voice_settings' });
    }
    const results = await Promise.allSettled([settings.save({region:'beijing',apiKey:'bj'}), settings.save({region:'singapore',apiKey:'sg'})]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.some(result => result.status === 'rejected' && result.reason.code === 'voice_settings_busy'));
    const current = await settings.selection();
    assert.equal(current.apiKey, current.region === 'beijing' ? 'bj' : 'sg');
    await assert.rejects(settings.save({region:'beijing',apiKey:'denied'}, () => false), {code:'unauthorized'});
    assert.deepEqual(await settings.selection(), current);
    // A leftover lock inode is harmless; the kernel owns lock lifetime.
    await settings.save({region:current.region,apiKey:''});
    assert.deepEqual(await settings.selection(), current);
    await chmod(join(directory, 'voice-settings.json'), 0o644);
    await assert.rejects(settings.snapshot(), {code:'voice_settings_unavailable'});
    await rm(join(directory, 'voice-settings.json'));
    await symlink(join(directory, 'credentials.json'), join(directory, 'voice-settings.json'));
    await assert.rejects(settings.snapshot(), {code:'voice_settings_unavailable'});
    await rm(join(directory, 'voice-settings.json'));
    await mkdir(join(directory, 'voice-settings.json'));
    await assert.rejects(settings.save({region:'beijing',apiKey:'failed'}), {code:'voice_settings_unavailable'});
    await rm(join(directory, 'voice-settings.json'), {recursive:true});
    await writeFile(join(directory, 'voice-settings.json'), '{invalid', {mode:0o600});
    await assert.rejects(settings.snapshot(), {code:'voice_settings_unavailable'});
  } finally { await rm(directory, { recursive:true, force:true }); }
});

test('HTTP voice setup works without speech TOML and recordings retain their connection snapshot', async () => {
  const f = await voiceFixture();
  try {
    delete f.f.config.speech;
    const request = (input: unknown, origin = f.origin) => fetch(`${f.origin}/api/voice/settings`, { method:'POST', headers:{origin,'content-type':'application/json'},body:JSON.stringify(input) });
    let response = await fetch(`${f.origin}/api/voice/settings`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {region:'beijing',configured:false});
    response = await request({region:'beijing',apiKey:''});
    assert.equal(response.status,400);
    assert.equal(response.headers.get('cache-control'),'no-store');
    response = await request({region:'beijing',apiKey:'secret'}, 'http://evil.invalid');
    assert.equal(response.status,403);
    assert.equal(response.headers.get('cache-control'),'no-store');
    response = await request({region:'beijing',apiKey:'beijing-secret'});
    assert.equal(response.status,200);
    assert.doesNotMatch(await response.text(), /secret/);
    assert.deepEqual(await (await fetch(`${f.origin}/api/voice/capability`)).json(), {available:true});
    const active = await f.client(); await active.wait('ready');
    assert.equal(f.state.auth,'Bearer beijing-secret');
    assert.equal(f.state.region,'beijing');
    response = await request({region:'singapore',apiKey:'singapore-secret'});
    assert.equal(response.status,200);
    assert.equal(active.ws.readyState,1);
    assert.equal(f.state.auth,'Bearer beijing-secret');
    assert.equal(f.state.region,'beijing');
    active.ws.send(Buffer.alloc(3200));
    active.ws.send(JSON.stringify({type:'finish'}));
    assert.equal((await active.wait('result')).type,'result');
    const next = await f.client(); await next.wait('ready');
    assert.equal(f.state.auth,'Bearer singapore-secret');
    assert.equal(f.state.region,'singapore');
    response = await request({region:'beijing',apiKey:''});
    assert.equal(response.status,400);
    assert.equal(response.headers.get('cache-control'),'no-store');
    response = await fetch(`${f.origin}/api/voice/settings`, {method:'PUT',headers:{origin:f.origin}});
    assert.equal(response.status,405);
    assert.equal(response.headers.get('cache-control'),'no-store');
    response = await fetch(`${f.origin}/api/voice/settings`, {method:'POST',headers:{origin:f.origin,'content-type':'text/plain'},body:'secret'});
    assert.equal(response.status,400);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const {default:koffi} = await import('koffi');
    const held = await open(join(f.f.directory,'voice-settings.json.lock'), 'r+');
    try {
      assert.equal(koffi.load(null).func('int flock(int fd, int operation)')(held.fd,6),0);
      response = await request({region:'singapore',apiKey:'secret'});
      assert.equal(response.status,409);
      assert.equal(response.headers.get('cache-control'),'no-store');
    } finally { await held.close(); }
    await writeFile(join(f.f.directory,'voice-settings.json'), '{invalid', {mode:0o600});
    for (const method of ['GET','POST']) {
      response = await fetch(`${f.origin}/api/voice/settings`, {method,headers:{origin:f.origin,'content-type':'application/json'}, ...(method === 'POST' ? {body:JSON.stringify({region:'beijing',apiKey:'secret'})} : {})});
      assert.equal(response.status,503);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.doesNotMatch(await response.text(), /secret|invalid.*JSON/i);
    }
  } finally { await f.close(); }
});

test('a killed settings writer releases the OS lock without stale-lock recovery', async () => {
  const { spawn } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'voice-lock-'));
  const settings = createVoiceSettings(directory, () => 'legacy');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import koffi from ${JSON.stringify(import.meta.resolve('koffi'))};
    import { openSync } from 'node:fs';
    const fd = openSync(process.argv[1], 'a', 0o600);
    const lock = koffi.load(null).func('int flock(int fd, int operation)');
    if (lock(fd, 6) !== 0) process.exit(1);
    console.log('locked');
    setInterval(() => {}, 1000);
  `, join(directory,'voice-settings.json.lock')], {stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout!, 'data');
    await assert.rejects(settings.save({region:'singapore',apiKey:'new-key'}), {code:'voice_settings_busy'});
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    assert.deepEqual(await settings.save({region:'singapore',apiKey:'new-key'}), {region:'singapore',configured:true});
  } finally { child.kill('SIGKILL'); await rm(directory, {recursive:true,force:true}); }
});


test('unavailable voice lock binding leaves import and reads usable and save fails safely', async () => {
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'voice-unavailable-'));
  try {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import {mock} from 'node:test';
      import assert from 'node:assert/strict';
      let calls = 0;
      mock.module(${JSON.stringify(import.meta.resolve('koffi'))}, {defaultExport:{load(){ calls++; throw new Error('private native loader details'); }}});
      const {createVoiceSettings} = await import(${JSON.stringify(new URL('../runtime/voice-settings.ts', import.meta.url).href)});
      const settings = createVoiceSettings(process.argv[1], () => 'legacy');
      assert.deepEqual(await settings.snapshot(), {region:'beijing',configured:true});
      assert.equal(calls,0);
      await assert.rejects(settings.save({region:'singapore',apiKey:'private-key'}), error => error.code === 'voice_settings_unavailable' && error.status === 503 && !/private/.test(error.message));
      assert.equal(calls,1);
      assert.deepEqual(await settings.snapshot(), {region:'beijing',configured:true});
    `, directory], {encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
