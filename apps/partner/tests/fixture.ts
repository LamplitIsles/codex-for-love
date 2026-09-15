import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CodexAppServerClientOptions } from '@jaminzhou/codex-app-server-client';
import type { Config, Credentials } from '../runtime/config.ts';
import { createPartner, type Partner } from '../runtime/partner.ts';

const fakeServer = fileURLToPath(new URL('./fake-app-server-entry.mjs', import.meta.url));
const hookScript = fileURLToPath(new URL('../runtime/session-start-hook.mjs', import.meta.url));

type FixtureAppServer = Partial<CodexAppServerClientOptions> & { env: NodeJS.ProcessEnv };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-partner-test-'));
  const workspace = join(directory, 'workspace');
  await mkdir(join(directory, 'assets'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const persona = join(directory, 'persona.md');
  await writeFile(persona, 'Your name is Mica. This is a fictional test conversation.');
  const requestsPath = join(directory, 'requests.jsonl');
  const controlPath = join(directory, 'control.json');
  const fakeStatePath = join(directory, 'fake-state.json');
  await writeFile(controlPath, '{}', { mode: 0o600 });
  const config: Config = {
    name: 'Mica', persona, state: directory, workspace, port: 3082,
    codex: { command: fakeServer, model: 'gpt-5.6-luna', version: '0.154.0', home: join(directory, 'codex-home'), local_compaction: false },
  };
  const credentials: Credentials = {};
  const environment: Record<string, string> = {
    FAKE_SERVER_ROOT: directory,
    FAKE_SERVER_STATE: fakeStatePath,
    FAKE_SERVER_REQUESTS: requestsPath,
    FAKE_SERVER_CONTROL: controlPath,
    FAKE_HOOK_COMMAND: `${shellQuote(process.execPath)} ${shellQuote(hookScript)} ${shellQuote(join(workspace, '.lamplit', 'context-bootstrap.json'))}`,
    FAKE_CONFIG_PATH: join(workspace, '.codex', 'config.toml'),
    FAKE_EARLY_TOOL: 'true',
    FAKE_SERVER_ARGS: join(directory, 'fake-server-args.json'),
    FAKE_SERVER_CONTEXT: join(directory, 'fake-server-context.json'),
    FAKE_SERVER_SENTINEL: 'preserved-by-sdk',
    FAKE_SERVER_LIFECYCLE: join(directory, 'fake-server-lifecycle.txt'),
  };
  const appServer: FixtureAppServer = {
    env: environment,
  };
  let partner: Partner | undefined;
  const requests = async () => {
    try { return (await readFile(requestsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
    catch { return []; }
  };
  return {
    directory, workspace, config, credentials, appServer, requests,
    async createPartner() { partner = await createPartner(config, credentials, { appServer }); return partner; },
    holdProvider(value: boolean) { return writeFile(controlPath, JSON.stringify({ hold: value }), { mode: 0o600 }); },
    async enableLocalCompaction() {
      const executable = join(directory, 'codex.mjs');
      await writeFile(executable, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fakeServer).href)};\n`, { mode: 0o755 });
      config.codex.command = executable;
      const helper = 'test-owned code-mode host';
      await writeFile(join(directory, 'codex-code-mode-host'), helper, { mode: 0o755 });
      const provenance = join(directory, 'provenance.json');
      const binarySha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
      await writeFile(provenance, `${JSON.stringify({
        schemaVersion: 1,
        forkRepository: 'https://github.com/lamplitisles/codex',
        sourceRevision: '445477b6a83514611ac206d2ab04b79374555a4c',
        releaseTag: 'cfl/v0.154.0-app-server-musl.1',
        codexVersion: '0.154.0',
        target: 'x86_64-unknown-linux-musl',
        executables: {
          'bin/codex-app-server': binarySha256,
          'bin/codex-code-mode-host': createHash('sha256').update(helper).digest('hex'),
        },
      }, null, 2)}\n`);
      config.codex.local_compaction = true;
      config.codex.provenance = provenance;
    },
    async close() { await partner?.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

export async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for observable state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
