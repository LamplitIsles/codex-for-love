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
    assert.equal((await loadConfig(path)).codex.command, 'codex-app-server');

    await writeFile(path, 'name = "Mica"\npersona = "persona.md"\nstate = "state"\n[codex]\nexecutable_type = "cli"\n');
    await assert.rejects(loadConfig(path), /executable_type/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
