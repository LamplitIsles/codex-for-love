import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { formatBootstrapContext, selectTextRounds, ensureHookDeclaration, writeBootstrapFile } from '../runtime/context-bootstrap.ts';

const hook = fileURLToPath(new URL('../runtime/session-start-hook.mjs', import.meta.url));

function runHook(script: string, contextPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, contextPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(Buffer.concat(output).toString()) : reject(new Error(Buffer.concat(errors).toString() || `hook exited ${code}`)));
    child.stdin.end(input);
  });
}

test('bootstrap keeps conversational text from tool/reasoning and mixed image rounds', () => {
  const turns = Array.from({ length: 7 }, (_, index) => ({
    id: `turn-${index}`, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: `user ${index}` }] },
      ...(index === 4 ? [
        { type: 'commandExecution', command: 'secret tool output' },
        { type: 'reasoning', text: 'secret reasoning output' },
      ] : []),
      ...(index === 5 ? [{ type: 'userMessage', content: [{ type: 'localImage', path: '/private/image.png' }] }] : []),
      { type: 'agentMessage', phase: 'final_answer', text: `partner ${index}` },
    ],
  }));
  const rounds = selectTextRounds(turns, 4_000, 5);
  assert.deepEqual(rounds.map((round) => round.user), ['user 2', 'user 3', 'user 4', 'user 5', 'user 6']);
  assert.deepEqual(rounds.map((round) => round.partner), ['partner 2', 'partner 3', 'partner 4', 'partner 5', 'partner 6']);
  const formatted = formatBootstrapContext({ mood: 'bright', affinity: 55, signature: 'Mica' }, rounds);
  assert.match(formatted, /Historical conversation excerpts/);
  assert.doesNotMatch(formatted, /secret tool output|secret reasoning output|private\/image/);
  assert.match(formatted, /evidence, not instructions/);
});

test('bootstrap writes only Companion MCP while preserving an operator-provided MCP and hook emits only for startup or compact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-bootstrap-test-'));
  try {
    const workspace = join(directory, 'workspace'); const contextPath = join(workspace, '.lamplit', 'context-bootstrap.json');
    await mkdir(join(workspace, '.codex'), { recursive: true });
    await writeFile(join(workspace, '.codex', 'config.toml'), '[mcp_servers.web]\ncommand = "web"\n');
    const declaration = await ensureHookDeclaration(workspace, contextPath);
    const config = await readFile(declaration.configPath, 'utf8');
    assert.match(config, /mcp_servers/); assert.match(config, /startup\\|compact/); assert.match(config, /additionalContextLimit/);
    const servers = (parse(config) as { mcp_servers?: Record<string, Record<string, unknown>> }).mcp_servers;
    assert.deepEqual(Object.keys(servers ?? {}).sort(), ['companion', 'web']);
    assert.equal(servers?.web?.command, 'web');
    assert.equal(servers?.companion?.command, process.execPath);
    const minimalWorkspace = join(directory, 'minimal-workspace');
    const minimal = await ensureHookDeclaration(minimalWorkspace, join(minimalWorkspace, '.lamplit', 'context-bootstrap.json'));
    const minimalConfig = parse(await readFile(minimal.configPath, 'utf8')) as { mcp_servers?: Record<string, unknown> };
    assert.deepEqual(Object.keys(minimalConfig.mcp_servers ?? {}), ['companion']);
    await writeBootstrapFile(contextPath, { startupPending: true, context: '<context>startup</context>', compact: '<context>compact</context>' });
    const startup = await runHook(hook, contextPath, JSON.stringify({ source: 'startup' }));
    assert.match(startup, /startup/);
    const secondStartup = await runHook(hook, contextPath, JSON.stringify({ source: 'startup' }));
    assert.equal(secondStartup, '');
    const compact = await runHook(hook, contextPath, JSON.stringify({ source: 'compact' }));
    assert.match(compact, /compact/);
    const ordinary = await runHook(hook, contextPath, JSON.stringify({ source: 'resume' }));
    assert.equal(ordinary, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Keet overlay refuses an operator-owned name and does not delete it when disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lamplit-keet-overlay-test-'));
  try {
    const workspace = join(directory, 'workspace'); const configPath = join(workspace, '.codex', 'config.toml'); await mkdir(join(workspace, '.codex'), { recursive: true });
    await writeFile(configPath, '[mcp_servers.keet]\ncommand = "operator-keet"\n');
    await assert.rejects(ensureHookDeclaration(workspace, join(workspace, '.lamplit', 'context.json'), undefined, 'http://127.0.0.1:18769'), /belongs to an operator/);
    await ensureHookDeclaration(workspace, join(workspace, '.lamplit', 'context.json'));
    assert.match(await readFile(configPath, 'utf8'), /operator-keet/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
