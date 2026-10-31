// Runs inside the test-owned packaged runtime after its listener is bound.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authenticator } from '../apps/partner/tests/synthetic-auth.ts';

export async function run(port) {
  const origin = `http://127.0.0.1:${port}`;
  const fetchOwned = (path, options = {}) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(5000) });
  const source = JSON.parse(process.env.CFL_SMOKE_BROWSER_MANIFEST);
  const rootHtml = await (await fetchOwned('/')).text();
  assert.equal(await (await fetchOwned('/chat')).text(), rootHtml);
  let verified = 0;
  for (const [path, expected] of Object.entries(source)) {
    const response = await fetchOwned(`/${path}`); assert.equal(response.status, 200, path);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), expected, path); verified++;
  }
  for (const path of ['/slice', '/slice/', '/management', '/assets/missing.js']) assert.equal((await fetchOwned(path)).status, 404);
  assert.equal((await fetchOwned('/api/session')).status, 401);
  const canonical = `http://localhost:${port}`;
  const pairOutput = execFileSync(process.execPath, [process.argv[1], 'pair', process.env.CFL_SMOKE_CONFIG], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 10000 });
  const pairingCode = pairOutput.match(/Pairing code \(valid for 10 minutes\): ([A-Za-z0-9_-]+)/u)?.[1];
  assert.ok(pairingCode);
  const postAuth = (path, data, cookies = []) => fetchOwned(path, { method: 'POST', headers: { origin: canonical, 'content-type': 'application/json', ...(cookies.length ? { cookie: cookies.join('; ') } : {}) }, body: JSON.stringify(data) });
  const getCookie = (response, name) => {
    const value = response.headers.getSetCookie().find(cookie => cookie.startsWith(`${name}=`));
    assert.ok(value, `Missing ${name} cookie`);
    return value.split(';')[0];
  };
  const pairing = await postAuth('/api/auth/pairing', { code: pairingCode });
  assert.equal(pairing.status, 200);
  const pairingCookie = getCookie(pairing, 'cfl_pairing');
  const options = await fetchOwned('/api/auth/passkey/generate-register-options', { headers: { origin: canonical, cookie: pairingCookie } });
  assert.equal(options.status, 200);
  const { challenge } = await options.json();
  const device = authenticator(canonical);
  const verifiedRegistration = await postAuth('/api/auth/passkey/verify-registration', { createSession: true, response: device.register(challenge) }, [pairingCookie, getCookie(options, 'better-auth.better-auth-passkey')]);
  assert.equal(verifiedRegistration.status, 200);
  const cookie = getCookie(verifiedRegistration, 'better-auth.session_token');
  const session = await (await fetchOwned('/api/session', { headers: { cookie } })).json(); assert.equal(session.name, 'Mica'); assert.ok(session.sessionId);
  const sharp = createRequire(new URL('../apps/partner/package.json', import.meta.url))('sharp');
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#cc8844' } }).png().toBuffer();
  await writeFile(join(process.env.CFL_SMOKE_WORKSPACE, 'package 图片%20.png'), image);
  const imageResponse = await fetchOwned(`/api/chat/workspace-image?${new URLSearchParams({ path: 'package 图片%20.png' })}`, { headers: { cookie } });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.equal(imageResponse.headers.get('cache-control'), 'no-store');
  assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image);
  console.log(`Runtime served ${verified} test frontend files, identical / and /chat, canonical 404 boundaries, a fake-engine session and workspace image bytes.`);
}
