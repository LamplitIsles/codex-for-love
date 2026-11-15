// Test-only actual Node host for the unchanged common panels runner.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { seedPanels, seedNow } from './panels-seed.ts';
import { createAlarm } from '../runtime/alarms.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { createWebServer } from './web-server.ts';
const evidence = resolve(process.argv[3]!); await mkdir(evidence, { recursive: true });
const f = await fixture(); const root = f.directory; const seed = await seedPanels(f.workspace, f.appServer.env.FAKE_SERVER_STATE!);
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
const app = createWebServer(partner, resolve(process.argv[2]!), { authorize: async request => request.headers.cookie?.includes('panels-test-owner=1') === true });
app.server.prependListener('request', (request, response) => { if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'panels-test-owner=1; Path=/; SameSite=Strict'); });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
console.log(JSON.stringify({ url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}/`, root, sourceAlarm }));
async function close() { await writeFile(join(evidence, 'native.json'), JSON.stringify({ requests: await f.requests(), workspace: f.workspace })); await app.close(); await f.close(); process.exit(0); }
process.once('SIGTERM', close); process.once('SIGINT', close);
