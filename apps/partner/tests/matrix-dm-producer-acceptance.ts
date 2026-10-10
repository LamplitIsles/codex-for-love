// Run only with Orc-relayed final producer originals, never against live services.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { matrixGateway } from './matrix-fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';

const [rawPath, producerCommit, evidencePath] = process.argv.slice(2);
assert(rawPath && evidencePath && /^[a-f0-9]{40}$/.test(producerCommit ?? ''), 'raw directory, exact producer commit and owned evidence directory required');
const raw = resolve(rawPath), evidence = resolve(evidencePath);
const manifestBytes = await readFile(join(raw, 'manifest.json'));
const bindingBytes = await readFile(join(raw, 'source-binding.json'));
const binding = JSON.parse(bindingBytes.toString()) as { producer_commit: string; producer_tree: string; manifest_sha256: string };
assert.equal(binding.producer_commit, producerCommit);
const manifest = JSON.parse(manifestBytes.toString()) as { cases: Array<{ name: string; file: string; sha256: string; bytes: number; receiver_identity: string }> };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(manifestBytes), binding.manifest_sha256);
const bodies = new Map<string, Buffer>();
for (const item of manifest.cases) {
  assert.equal(item.file, `${item.name}.json`);
  const bytes = await readFile(join(raw, item.file));
  assert.equal(bytes.length, item.bytes); assert.equal(sha(bytes), item.sha256);
  bodies.set(item.name, bytes);
}
for (const name of ['allowed-dm', 'denied-addressed-dm', 'unmarked-room', 'other-identity-room']) assert(bodies.has(name));
const deniedBody = JSON.parse(bodies.get('denied-addressed-dm')!.toString()).body as string;
assert(deniedBody.length > 0);
const results: unknown[] = [];
for (const identity of ['@self:test', '@second:test']) {
  const f = await fixture(), gateway = await matrixGateway();
  gateway.identity = { user_id: identity };
  f.config.matrix = { endpoint: gateway.endpoint, dm_allow_list: ['@allowed:test'], trigger_aliases: ['agent'] };
  f.credentials.matrix = gateway.token;
  let app: ReturnType<typeof createWebServer> | undefined;
  try {
    let partner = await f.createPartner();
    async function host() {
      app = createWebServer(partner, join(f.directory, 'assets'));
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      return `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/matrix/events`;
    }
    let url = await host();
    async function post(name: string) {
      // Buffer is the exact original HTTP body; parsing above never changes delivery bytes.
      const response = await fetch(url, { method: 'POST', body: new Uint8Array(bodies.get(name)!), headers: { 'content-type': 'application/json' } });
      assert.equal(response.status, 202); results.push({ identity, name, status: response.status, sha256: sha(bodies.get(name)!) });
    }
    const starts = async () => (await f.requests()).filter(row => row.method === 'turn/start');
    if (identity === '@self:test') {
      await post('denied-addressed-dm'); assert.equal((await starts()).length, 0);
      await post('allowed-dm');
      await eventually(async () => (await starts()).length === 1 && !(await partner.snapshot()).typing);
      const turn = (await starts())[0]!.params as { additionalContext: Record<string, { value: string }> };
      assert.equal(JSON.parse(turn.additionalContext['codex-for-love.matrix-metadata']!.value).trigger, 'dm');
      await post('unmarked-room'); assert.equal((await starts()).length, 1);
      assert(!JSON.stringify(await f.requests()).includes(deniedBody));
      const history = await createCodexChatBackend(partner).read();
      assert(!JSON.stringify(history).includes(deniedBody));
      await app!.close(); app = undefined;
      f.config.matrix.dm_allow_list = [];
      partner = await f.createPartner(); url = await host();
      await post('allowed-dm'); await post('denied-addressed-dm');
      assert.equal((await starts()).length, 1, 'immutable admitted receipt survives list change and real fake-engine process restart');
      assert.deepEqual(await createCodexChatBackend(partner).read(), history);
      await app!.close(); app = undefined;
      assert(!(await readFile(partnerPaths(f.workspace).database)).includes(Buffer.from(deniedBody)), 'no denied body in SQLite including freed pages');
    } else {
      await post('other-identity-room'); assert.equal((await starts()).length, 0, 'same room facts remain identity-relative');
    }
  } finally { await app?.close(); await f.close(); await gateway.close(); }
}
await mkdir(evidence, { recursive: true });
const consumer = execFileSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8' }).trim().split('\n');
await writeFile(join(evidence, 'producer-acceptance.json'), JSON.stringify({ spec: 3667, producerSpec: 3664, producerCommit,
  consumerCommit: consumer[0], consumerTree: consumer[1], raw, manifestSha256: sha(manifestBytes), results,
  producerTree: binding.producer_tree, sourceBindingSha256: sha(bindingBytes),
  runtimeAcceptance: 'PASS', crossRepositoryAcceptance: 'pending Orc', cleanup: 'owned fixture roots, fake engines and loopback gateways closed and removed' }, null, 2));
console.log('CFL exact-byte producer/native admission acceptance PASS; cross-repository acceptance pending Orc');
