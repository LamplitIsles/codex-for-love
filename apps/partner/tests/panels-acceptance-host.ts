// Test-only actual Node host for the unchanged common panels runner.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { fixture, eventually } from './fixture.ts';
import { seedPanels, seedNow } from './panels-seed.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { createWebServer } from '../runtime/server.ts';
const evidence = resolve(process.argv[3]!); await mkdir(evidence, { recursive: true });
const f = await fixture(); const root = f.directory; const seed = await seedPanels(f.workspace, f.appServer.env.FAKE_SERVER_STATE!);
f.config.speech = { endpoint: 'http://127.0.0.1/unused-batch' }; f.credentials.speech = 'synthetic-fixture-key';
let clock = seedNow;
const sourceAlarm = createAlarm(partnerPaths(f.workspace).alarms, '这是应用的提醒', { kind: 'once', at: new Date(clock + 1000).toISOString() }, clock);
clock += 1000;
const partner = await f.createPartner({ now: () => clock });
await eventually(async () => (await partner.snapshot()).results.some(r => r.chatStatus === 'completed'));
// Exercise genuine missing-file races after a native list, without mocking its DTO.
const diary = partner.diary.bind(partner);
partner.diary = async () => {
  await writeFile(join(f.workspace, 'memory', seed.dates[1]!), 'removed after native listing');
  const entries = await diary(); await rm(join(f.workspace, 'memory', seed.dates[1]!)); return entries;
};
const provider = createServer(); const sockets = new WebSocketServer({ noServer: true });
const voice = { frames: 0, bytes: 0, tasks: 0 };
provider.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws)));
sockets.on('connection', ws => {
  let taskId = '';
  const event = (name: string, payload: object = {}) => ws.send(JSON.stringify({ header: { event: name, task_id: taskId }, payload }));
  ws.on('message', (raw, binary) => {
    if (binary) { voice.frames++; voice.bytes += raw instanceof ArrayBuffer ? raw.byteLength : Array.isArray(raw) ? raw.reduce((sum, b) => sum + b.length, 0) : raw.length; return; }
    const req = JSON.parse(raw.toString()); taskId = req.header.task_id;
    if (req.header.action === 'run-task') { voice.tasks++; event('task-started'); }
    else { event('result-generated', { output: { sentence: { sentence_id: 1, sentence_end: true, text: 'recognized final' } } }); event('task-finished'); }
  });
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const port = (provider.address() as { port: number }).port;
const app = createWebServer(partner, resolve('apps/partner/build'), { chatAssets: resolve(process.argv[2]!), authorize: async request => request.headers.cookie?.includes('panels-test-owner=1') === true, voice: { connect: () => new WebSocket(`ws://127.0.0.1:${port}`) } });
app.server.prependListener('request', (request, response) => { if (request.url?.startsWith('/slice')) response.setHeader('Set-Cookie', 'panels-test-owner=1; Path=/; SameSite=Strict'); });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
console.log(JSON.stringify({ url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}/slice/`, root, sourceAlarm }));
async function close() { await writeFile(join(evidence, 'native.json'), JSON.stringify({ voice, requests: await f.requests(), workspace: f.workspace })); await app.close(); await f.close(); for (const ws of sockets.clients) ws.terminate(); sockets.close(); provider.close(); process.exit(0); }
process.once('SIGTERM', close); process.once('SIGINT', close);
