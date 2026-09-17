import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../runtime/config.ts';

test('CFL config fixes execution to a direct app-server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-config-test-'));
  try {
    const path = join(directory, 'partner.toml');
    await writeFile(path, 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n');
    const defaults = await loadConfig(path);
    assert.equal(defaults.codex.command, 'codex-app-server');
    assert.equal(defaults.codex.context_round_limit, 10);

    await writeFile(path, 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n[codex]\ncontext_round_limit = 3\n');
    assert.equal((await loadConfig(path)).codex.context_round_limit, 3);

    await writeFile(path, 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n[codex]\ncontext_round_limit = -1\n');
    await assert.rejects(loadConfig(path), />=0/);

    await writeFile(path, 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n[codex]\nexecutable_type = "cli"\n');
    await assert.rejects(loadConfig(path), /executable_type/);

    await writeFile(path, 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n[codex]\nprovenance = "./provenance.json"\n');
    await assert.rejects(loadConfig(path), /provenance/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Keet configuration is optional but rejects non-loopback or path endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-keet-config-test-'));
  try {
    const path = join(directory, 'partner.toml'); const base = 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n';
    await writeFile(path, `${base}[keet]\nmedia_root = "/tmp/media"\n`); assert.equal((await loadConfig(path)).keet?.endpoint, undefined);
    await writeFile(path, `${base}[keet]\nendpoint = "http://example.test:1"\nmedia_root = "/tmp/media"\n`); await assert.rejects(loadConfig(path), /bare/);
    await writeFile(path, `${base}[keet]\nendpoint = "http://127.0.0.1:18769/cfl"\nmedia_root = "/tmp/media"\n`); await assert.rejects(loadConfig(path), /bare/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('TTS speed is a bounded provider capability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-tts-config-test-'));
  try {
    const path = join(directory, 'partner.toml'); const base = 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n[speech.tts]\n';
    await writeFile(path, `${base}provider = "minimax"\nvoice = "Chinese (Mandarin)_Soft_Girl"\nspeed = 1.15\n`); assert.equal((await loadConfig(path)).speech?.tts?.speed, 1.15);
    await writeFile(path, `${base}provider = "alibaba"\nvoice = "Cherry"\nspeed = 1.15\n`); await assert.rejects(loadConfig(path), /Alibaba TTS speed/);
    await writeFile(path, `${base}provider = "bytedance"\nvoice = "voice"\nspeed = 2.1\n`); await assert.rejects(loadConfig(path), /<=2/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
