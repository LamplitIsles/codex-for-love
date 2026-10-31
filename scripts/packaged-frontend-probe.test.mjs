import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../apps/partner/tests/fixture.ts';
import { AuthStore } from '../apps/partner/runtime/auth.ts';
import { createWebServer } from '../apps/partner/runtime/server.ts';
import { run } from './packaged-frontend-probe.mjs';

test('packaged probe enrolls and checks a session against the source runtime', async () => {
  const f = await fixture();
  const previousArgs = process.argv[1];
  const keys = ['CFL_SMOKE_BROWSER_MANIFEST', 'CFL_SMOKE_CONFIG', 'CFL_SMOKE_WORKSPACE', 'HOME'];
  const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let app;
  let auth;
  try {
    const html = '<!doctype html><title>test frontend</title>';
    const assets = join(f.directory, 'assets');
    await writeFile(join(assets, 'index.html'), html);
    const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(done => reserve.close(done));
    const config = join(f.directory, 'partner.toml');
    await writeFile(config, `name = "Mica"\nprompts = { persona = ${JSON.stringify(f.config.prompts.persona)} }\nstate = ${JSON.stringify(f.directory)}\nworkspace = ${JSON.stringify(f.workspace)}\nport = ${port}\n[codex]\ncommand = ${JSON.stringify(f.config.codex.command)}\nhome = ${JSON.stringify(f.config.codex.home)}\n`);
    auth = new AuthStore(f.directory, `http://localhost:${port}`); await auth.initialize();
    app = createWebServer(await f.createPartner(), assets, { auth });
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    process.argv[1] = join(import.meta.dirname, '../apps/partner/runtime/cli.ts');
    process.env.CFL_SMOKE_BROWSER_MANIFEST = JSON.stringify({ 'index.html': createHash('sha256').update(html).digest('hex') });
    process.env.CFL_SMOKE_CONFIG = config;
    process.env.CFL_SMOKE_WORKSPACE = f.workspace;
    process.env.HOME = f.directory;
    await run(port);
  } finally {
    process.argv[1] = previousArgs;
    for (const key of keys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    try { if (app) await app.close(); else auth?.close(); } finally { await f.close(); }
  }
});
