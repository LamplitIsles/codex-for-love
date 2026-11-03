import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient, resolveCodexBinary } from '@jaminzhou/codex-app-server-client';

const root = await mkdtemp(join(tmpdir(), 'cfl-voice-real-'));
const workspace = join(root, 'workspace'), home = join(root, 'home'), socket = join(root, 'app.sock'), log = join(root, 'calls');
const companion = fileURLToPath(new URL('./fake-companion-entry.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fake-elevenlabs-mcp.mjs', import.meta.url));
let active = false, release;
const model = createServer(async (req, res) => {
  for await (const _ of req) {};
  active = true;
  await new Promise(resolve => { release = resolve; });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fake-response"}}\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await mkdir(join(workspace, '.lamplit'), { recursive: true }); await mkdir(home);
const config = join(root, 'partner.toml');
await writeFile(config, `name = "test"\nstate = "state"\nworkspace = ${JSON.stringify(workspace)}\nprompts = { persona = "persona.md" }\n[codex]\nsocket_path = ${JSON.stringify(socket)}\n[speech.tts]\nprovider = "elevenlabs"\nvoice = "fake-voice"\n`);
await writeFile(join(home, 'config.toml'), `model = "gpt-5.2"\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:${model.address().port}/v1"\n[mcp_servers.companion]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(companion)}, ${JSON.stringify(workspace)}, ${JSON.stringify(config)}]\n[mcp_servers.elevenlabs]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fake)}]\n[mcp_servers.elevenlabs.env]\nCFL_FAKE_ELEVEN_LOG = ${JSON.stringify(log)}\n[features]\nplugins = false\n`);
const binary = process.env.CODEX_PATCHED_CODEX ?? resolveCodexBinary().executablePath;
const processServer = spawn(binary, ['--listen', `unix://${socket}`], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'test-only', CODEX_DISABLE_UPDATE_CHECK: '1' }, stdio: 'ignore', detached: true });
const waitFor = async (fn, label) => { const deadline = Date.now() + 15000; while (!await fn()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); } };
let client;
try {
  await waitFor(async () => stat(socket).then(() => true, () => false), 'socket');
  client = new CodexAppServerClient({ transport: { type: 'unix', socketPath: socket }, capabilities: { experimentalApi: true, requestAttestation: false }, clientInfo: { name: 'cfl-test', title: 'CFL test', version: '1' }, requestTimeoutMs: 15000, protocolValidation: 'strict' });
  await client.connect();
  const started = await client.call('thread/start', { cwd: workspace, model: 'gpt-5.2', approvalPolicy: 'never', sandbox: 'danger-full-access' });
  const threadId = started.thread.id;
  await writeFile(join(workspace, '.lamplit/thread.json'), JSON.stringify({ threadId }));
  await waitFor(async () => { const statuses = await client.call('mcpServerStatus/list', { threadId }); return ['companion', 'elevenlabs'].every(name => statuses.data.some(x => x.name === name && x.runtimeStatus === 'connected')); }, 'fake MCPs');
  await client.call('turn/start', { threadId, input: [{ type: 'text', text: 'test only', text_elements: [] }] });
  await waitFor(() => active, 'active fake model');
  const result = await client.call('mcpServer/tool/call', { threadId, server: 'companion', tool: 'send_voice', arguments: { text: 'synthetic test' } });
  assert.notEqual(result.isError, true);
  const voice = JSON.parse(result.content[0].text);
  assert.equal(voice.kind, 'voice'); assert.match(voice.audioId, /^[a-f0-9]{64}$/u);
  const audio = await readFile(join(workspace, '.lamplit/audio', `${voice.audioId}.mp3`));
  assert.equal(audio.length, 417); assert.deepEqual([...audio.subarray(0, 4)], [0xff, 0xfb, 0x90, 0]);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.name), ['creative_generate_speech', 'creative_get_flow_run_status']);
  assert.equal(calls[0].arguments.generations_count, 1);
  assert.equal(calls[0].arguments.model_id, 'eleven_v4');
  assert.equal(active, true);
  console.log('PASS real app-server: active turn, nested Companion call, fake ElevenLabs and local Voice projection');
} finally {
  release?.();
  if (processServer.exitCode === null && processServer.signalCode === null) {
    const exited = new Promise(resolve => processServer.once('exit', resolve));
    try { process.kill(-processServer.pid, 'SIGTERM'); } catch {}
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (processServer.exitCode === null && processServer.signalCode === null) {
      try { process.kill(-processServer.pid, 'SIGKILL'); } catch {}
      await exited;
    }
  }
  await client?.close().catch(() => undefined);
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
