import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';
import { seedSmokeFrontend, smokeHtml, smokeRevision } from '../../../scripts/smoke-frontend.mjs';

test('source CLI serves selected cache by default and fails when latest is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfl-frontend-cli-'));
  let f;
  try {
    f = await fixture();
    const cache = join(root, 'cache');
    await seedSmokeFrontend(cache);
    const bin = join(root, 'bin'); await mkdir(bin);
    const curl = join(bin, 'curl');
    await writeFile(curl, `#!/bin/sh\nprintf '%s' '{"sha":"${smokeRevision}"}'\n`, { mode: 0o755 });
    const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(done => reserve.close(done));
    const marker = `CFL_SMOKE_HTTP_OK_${randomUUID()}`;
    const config = join(root, 'partner.toml');
    const base = `name = "Mica"\nprompts = { persona = ${JSON.stringify(f.config.prompts.persona)} }\nstate = ${JSON.stringify(f.directory)}\nworkspace = ${JSON.stringify(f.workspace)}\nport = ${port}\n[codex]\ncommand = ${JSON.stringify(f.config.codex.command)}\nhome = ${JSON.stringify(f.config.codex.home)}\n`;
    const start = () => spawn(process.execPath, [join(import.meta.dirname, '../runtime/cli.ts'), 'serve', config], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CACHE_HOME: cache, ...f.appServer.env, NODE_OPTIONS: `--import=${pathToFileURL(join(import.meta.dirname, '../../../scripts/artifact-smoke-probe.mjs')).href}`, CFL_SMOKE_PROBE_PORT: String(port), CFL_SMOKE_PROBE_MARKER: marker, CFL_SMOKE_PROBE_HTML: smokeHtml }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killGroup = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    for (const selector of ['', 'frontend = "latest"\n', `frontend = "${smokeRevision}"\n`]) {
      await writeFile(config, selector + base);
      const child = start(); const closed = once(child, 'close'); let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
      try {
        await eventually(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(errors); return output.split('\n').includes(marker); }, 15000);
        assert.match(output, new RegExp(`Frontend App ${smokeRevision}`));
      } finally {
        child.kill('SIGTERM'); const timer = setTimeout(() => killGroup(child), 10000);
        try { const [code] = await closed; assert.equal(code, 0, errors); } finally { clearTimeout(timer); }
      }
    }
    await writeFile(curl, '#!/bin/sh\necho offline >&2\nexit 1\n', { mode: 0o755 });
    await writeFile(config, base);
    const child = start(); let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => killGroup(child), 10000);
    try { const [code] = await once(child, 'close'); assert.notEqual(code, 0); assert.match(errors, /Frontend startup failed:.*offline/s); }
    finally { clearTimeout(timer); }
  } finally { try { await f?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
