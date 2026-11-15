import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCredentials } from '../runtime/config.ts';
import { createTtsSettings } from '../runtime/tts-settings.ts';
import { openMigratedVault } from '../runtime/migrated-vault.ts';

function credential(config: string, name: string, value: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['runtime/cli.ts', 'credential', config, name, '--stdin'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.once('error', reject); child.once('close', code => resolve({ code, output })); child.stdin.end(value);
  });
}

test('legacy migration and CLI writes preserve TTS precedence and nonvoice credentials', async () => {
  const state = await mkdtemp(join(tmpdir(), 'cfl-voice-entry-'));
  try {
    const config = join(state, 'partner.toml');
    await writeFile(config, `name = "test"\nprompts = { persona = "persona.md" }\nstate = ${JSON.stringify(state)}\n`);
    await writeFile(join(state, 'credentials.json'), JSON.stringify({ speech: 'legacy-speech', tts: 'legacy-tts', post: 'post-value' }), { mode: 0o600 });
    await writeFile(join(state, 'voice-settings.json'), JSON.stringify({ region: 'singapore', apiKey: 'old-input' }), { mode: 0o600 });
    const tts = createTtsSettings(state, () => ({}));
    assert.equal((await tts.selection()).keys.alibaba, 'legacy-speech');
    const vault = await openMigratedVault(state);
    assert.deepEqual(JSON.parse(vault.get('legacy.voice-input')!), { region: 'singapore', apiKey: 'old-input' }); vault.close();
    const results = await Promise.all([credential(config, 'speech', 'new-speech'), credential(config, 'tts', 'new-tts'), credential(config, 'keet', 'keet-value'), credential(config, 'post_receiver', 'receiver-value')]);
    for (const result of results) { assert.equal(result.code, 0, result.output); assert.doesNotMatch(result.output, /new-speech|new-tts|keet-value|receiver-value/); }
    assert.deepEqual(await loadCredentials(state), { speech: 'new-speech', tts: 'new-tts', post: 'post-value', keet: 'keet-value', post_receiver: 'receiver-value' });
    assert.equal((await tts.selection()).keys.alibaba, 'new-speech');
    await tts.saveKey({ provider: 'alibaba', apiKey: 'independent-output' });
    assert.equal((await tts.selection()).keys.alibaba, 'independent-output');
    assert.equal((await tts.selection()).keys.bytedance, 'new-tts');
    const oldFile = await readFile(join(state, 'credentials.json'), 'utf8');
    assert.doesNotMatch(oldFile, /legacy-speech|legacy-tts|new-speech|new-tts/);
    assert.deepEqual(JSON.parse(await readFile(join(state, 'voice-settings.json'), 'utf8')), { region: 'singapore' });
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('failed migration blocks TTS, credentials and CLI without plaintext fallback', async () => {
  const state = await mkdtemp(join(tmpdir(), 'cfl-voice-fail-'));
  try {
    const config = join(state, 'partner.toml');
    await writeFile(config, `name = "test"\nprompts = { persona = "persona.md" }\nstate = ${JSON.stringify(state)}\n`);
    const source = '{"broken":"synthetic-sensitive"}';
    await writeFile(join(state, 'tts-settings.json'), source, { mode: 0o600 });
    await assert.rejects(createTtsSettings(state, () => ({})).selection(), { code: 'tts_settings_unavailable' });
    await assert.rejects(loadCredentials(state), /vault_migration_unavailable/);
    const result = await credential(config, 'post', 'synthetic-post');
    assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /synthetic-sensitive|synthetic-post/);
    assert.equal(await readFile(join(state, 'tts-settings.json'), 'utf8'), source);
  } finally { await rm(state, { recursive: true, force: true }); }
});
