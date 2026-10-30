import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, loadCredentials } from '../runtime/config.ts';
import { loadPrompts } from '../runtime/load-prompts.ts';
import { companionPrompt, compactionPrompt } from '../runtime/prompts.ts';

test('prompt paths and local compaction are resolved and validated independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-prompts-config-'));
  try {
    const path = join(directory, 'partner.toml');
    const base = 'name = "Mica"\n';
    const prompts = '[prompts]\npersona = "persona.md"\n';
    for (const invalid of ['', '[prompts]\n', '[prompts]\npersona = ""\n']) {
      await writeFile(path, base + invalid);
      await assert.rejects(loadConfig(path), /prompts|persona/);
    }
    await writeFile(path, `${base}persona = "old.md"\n${prompts}`);
    await assert.rejects(loadConfig(path), /persona/);
    const absolutePersona = join(directory, 'absolute.md');
    await writeFile(path, `${base}state = "state"\nworkspace = "workspace"\n[prompts]\npersona = ${JSON.stringify(absolutePersona)}\n`);
    const absolute = await loadConfig(path);
    assert.equal(absolute.prompts.persona, absolutePersona);
    assert.equal(absolute.state, join(directory, 'state'));
    assert.equal(absolute.workspace, join(directory, 'workspace'));
    for (const entry of ['', '[codex]\n']) {
      await writeFile(path, base + entry + prompts);
      const config = await loadConfig(path);
      assert.equal(config.prompts.persona, join(directory, 'persona.md'));
      assert.equal(config.codex.local_compaction, true);
      assert.deepEqual(await loadPrompts(config), { companion: companionPrompt, compaction: compactionPrompt });
    }
    await writeFile(path, `${base}[codex]\nlocal_compaction = false\n${prompts}`);
    assert.equal((await loadConfig(path)).codex.local_compaction, false);
    await writeFile(path, `${base}[codex]\nlocal_compaction = false\n${prompts}compaction = "compact.md"\n`);
    await assert.rejects(loadConfig(path), /local_compaction/);
    for (const value of ['""', '"   "', '1']) {
      await writeFile(path, `${base}${prompts}companion = ${value}\n`);
      await assert.rejects(loadConfig(path), /companion/);
    }
    await writeFile(path, `${base}${prompts}unknown = "prompt.md"\n`);
    await assert.rejects(loadConfig(path));
    const companion = join(directory, 'companion');
    const compaction = join(directory, 'compact.md');
    await writeFile(companion, '\ufeff  replacement base\n');
    await writeFile(compaction, 'replacement compact\n');
    await writeFile(path, `${base}${prompts}companion = "companion"\n`);
    let config = await loadConfig(path);
    assert.equal(config.prompts?.companion, companion);
    assert.deepEqual(await loadPrompts(config), { companion: '\ufeff  replacement base\n', compaction: compactionPrompt });
    await writeFile(path, `${base}${prompts}compaction = ${JSON.stringify(compaction)}\n`);
    config = await loadConfig(path);
    assert.equal(config.prompts?.compaction, compaction);
    assert.deepEqual(await loadPrompts(config), { companion: companionPrompt, compaction: 'replacement compact\n' });
    await writeFile(compaction, ' \n\t');
    await assert.rejects(loadPrompts(config), /prompts\.compaction.*empty/);
    await writeFile(compaction, Buffer.from([0xff]));
    await assert.rejects(loadPrompts(config), /prompts\.compaction.*UTF-8/);
    await rm(compaction);
    await assert.rejects(loadPrompts(config), /prompts\.compaction.*compact\.md/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private Post credentials load independently without platform environment overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-credentials-test-'));
  try {
    assert.deepEqual(await loadCredentials(directory), {});
    const stored = JSON.stringify({ speech: 'owned-speech', keet: 'owned-keet', post: 'owned-api', post_receiver: 'owned-receiver' });
    await writeFile(join(directory, 'credentials.json'), stored);
    assert.deepEqual(await loadCredentials(directory), JSON.parse(stored));
    assert.equal(await readFile(join(directory, 'credentials.json'), 'utf8'), stored);
    await writeFile(join(directory, 'credentials.json'), JSON.stringify({ matrix: 'obsolete' }));
    await assert.rejects(loadCredentials(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CFL config fixes execution to a direct app-server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-config-test-'));
  try {
    const path = join(directory, 'partner.toml');
    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\n');
    const defaults = await loadConfig(path);
    assert.equal(defaults.codex.command, 'codex-app-server');
    assert.equal(defaults.codex.context_round_limit, 10);
    assert.equal(defaults.codex.socket_path, undefined);
    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\n[codex]\nsocket_path = "run/codex.sock"\n');
    assert.equal((await loadConfig(path)).codex.socket_path, join(directory, 'run/codex.sock'));
    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\n[codex]\nsocket_path = ""\n');
    await assert.rejects(loadConfig(path), /socket_path/);
    assert.equal(defaults.listen_host, '127.0.0.1');

    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\nlisten_host = "0.0.0.0"\n');
    assert.equal((await loadConfig(path)).listen_host, '0.0.0.0');

    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\nlisten_host = "localhost"\n');
    await assert.rejects(loadConfig(path), /IPv4/);

    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\n[codex]\ncontext_round_limit = 3\n');
    assert.equal((await loadConfig(path)).codex.context_round_limit, 3);

    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\n[codex]\ncontext_round_limit = -1\n');
    await assert.rejects(loadConfig(path), />=0/);

    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\n[codex]\nexecutable_type = "cli"\n');
    await assert.rejects(loadConfig(path), /executable_type/);

    await writeFile(path, 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\n[codex]\nprovenance = "./provenance.json"\n');
    await assert.rejects(loadConfig(path), /provenance/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Keet configuration is optional but rejects non-loopback or path endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-keet-config-test-'));
  try {
    const path = join(directory, 'partner.toml'); const base = 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\n';
    await writeFile(path, `${base}[keet]\nendpoint = "http://127.0.0.1:18769"\n`); assert.equal((await loadConfig(path)).keet?.endpoint, "http://127.0.0.1:18769");
    await writeFile(path, `${base}[keet]\nmedia_root = "/tmp/media"\n`); await assert.rejects(loadConfig(path));
    await writeFile(path, `${base}[keet]\nendpoint = "http://example.test:1"\n`); await assert.rejects(loadConfig(path), /bare/);
    await writeFile(path, `${base}[keet]\nendpoint = "http://127.0.0.1:18769/cfl"\n`); await assert.rejects(loadConfig(path), /bare/);
    await writeFile(path, `${base}[keet]\ntrusted_groups = ["Our little home"]\ntrigger_aliases = ["shio", "汐"]\n`);
    assert.deepEqual((await loadConfig(path)).keet?.trusted_groups, ['Our little home']);
    assert.deepEqual((await loadConfig(path)).keet?.trigger_aliases, ['shio', '汐']);
    for (const entry of ['trusted_groups = ["", "Friends"]', 'trusted_groups = ["Friends", "Friends"]', 'trigger_aliases = ["shio", "shio"]', 'trigger_aliases = [" shio"]', `trigger_aliases = [${Array(33).fill('"x"').join(', ')}]`]) {
      await writeFile(path, `${base}[keet]\n${entry}\n`);
      await assert.rejects(loadConfig(path));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('TTS speed is a bounded provider capability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-tts-config-test-'));
  try {
    const path = join(directory, 'partner.toml'); const base = 'name = "Mica"\nprompts = { persona = "persona.md" }\nstate = "state"\n[speech.tts]\n';
    await writeFile(path, `${base}provider = "minimax"\nvoice = "Chinese (Mandarin)_Soft_Girl"\nspeed = 1.15\n`); assert.equal((await loadConfig(path)).speech?.tts?.speed, 1.15);
    await writeFile(path, `${base}provider = "alibaba"\nvoice = "Cherry"\nspeed = 1.15\n`); await assert.rejects(loadConfig(path), /Alibaba TTS speed/);
    await writeFile(path, `${base}provider = "bytedance"\nvoice = "voice"\nspeed = 2.1\n`); await assert.rejects(loadConfig(path), /<=2/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('background configuration is optional and requires both relative compositions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-background-config-'));
  try {
    const path = join(directory, 'partner.toml');
    const base = 'name = "Mica"\nprompts = { persona = "persona.md" }\n';
    await writeFile(path, base);
    assert.equal((await loadConfig(path)).backgrounds, undefined);
    await writeFile(path, `${base}[backgrounds]\nlandscape = "workspace/wide.jpg"\nportrait = "workspace/tall.webp"\n`);
    assert.deepEqual((await loadConfig(path)).backgrounds, { landscape: join(directory, 'workspace/wide.jpg'), portrait: join(directory, 'workspace/tall.webp') });
    await writeFile(path, `${base}[backgrounds]\nlandscape = "workspace/wide.jpg"\n`);
    await assert.rejects(loadConfig(path), /portrait/);
    await writeFile(path, `${base}[backgrounds]\nlandscape = ""\nportrait = "workspace/tall.webp"\n`);
    await assert.rejects(loadConfig(path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('codex.fast is strictly boolean and defaults false at both nesting levels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-fast-config-'));
  try {
    const path = join(directory, 'partner.toml'); const base = 'name = "Mica"\nprompts = { persona = "persona.md" }\n';
    for (const [entry, expected] of [['', false], ['[codex]\n', false], ['[codex]\nfast = true\n', true], ['[codex]\nfast = false\n', false]] as const) {
      await writeFile(path, base + entry);
      assert.equal((await loadConfig(path)).codex.fast, expected);
    }
    for (const value of ['"true"', '1', '[]']) {
      await writeFile(path, `${base}[codex]\nfast = ${value}\n`);
      await assert.rejects(loadConfig(path), /fast/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
