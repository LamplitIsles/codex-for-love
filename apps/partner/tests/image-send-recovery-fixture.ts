import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { imageLimits, imagePath, materializeGeneratedImage } from '../runtime/images.ts';
import { fixtureImage } from './panels-seed.ts';
import { Store } from '../runtime/store.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import type { Submission } from '@lamplit/contracts';

/** TEST ONLY: real Partner/storage/SDK; controls drive its fake official server. */
export async function imageAcceptanceFixture(assets: string, port = 0, controlPort = 0) {
  let f = await fixture();
  let partner: Awaited<ReturnType<typeof f.createPartner>>;
  let app: ReturnType<typeof createWebServer>;
  let disabled = false, uploadFailure = false;
  const submissions: Submission[] = [];
  const listeners = new Set<() => void>();
  let control: Record<string, unknown> = { hold: true, mode: 'consumed' };
  async function writeControl() {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path + '.next', JSON.stringify(control)); await rename(path + '.next', path);
  }
  async function start() {
    f.appServer.env.FAKE_IMAGES_FIXTURE = 'true';
    await writeControl();
    // Seed fixture artifact metadata; only the fake official completed item makes it album/chat membership.
    await mkdir(partnerPaths(f.workspace).managedRoot, { recursive: true });
    const store = new Store(partnerPaths(f.workspace).database);
    const generated = await materializeGeneratedImage(f.workspace, 'turn:turn-1', { id: 'generated', result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=' });
    await store.saveGeneratedImage({ ...generated!, name: 'generated.png' }, 'generated'); await store.close();
    partner = await f.createPartner();
    const subscribe = partner.subscribe.bind(partner);
    partner.subscribe = listener => { listeners.add(listener); const off = subscribe(listener); return () => { listeners.delete(listener); off(); }; };
    const upload = partner.uploadImages.bind(partner), limits = partner.sharedImageLimits.bind(partner), submit = partner.submitShared.bind(partner);
    partner.sharedImageLimits = async () => disabled ? false : limits();
    partner.uploadImages = async (input, authorize) => { if (uploadFailure) throw new Error('Test-owned storage unavailable'); return upload(input, authorize); };
    partner.submitShared = async input => {
      const result = await submit(input);
      if (!submissions.some(item => item.operationId === input.operationId)) submissions.push(structuredClone(input));
      return result;
    };
    app = createWebServer(partner, assets, {
      authorize: async request => request.headers.cookie?.includes('image-fixture-owner=1') === true,
    });
    // Authentication bootstrap belongs only to this isolated fixture, never product routing.
    app.server.prependListener('request', (request, response) => {
      if (request.url === '/' || request.url === '/chat') response.setHeader('Set-Cookie', 'image-fixture-owner=1; Path=/; SameSite=Strict');
    });
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    port = (app.server.address() as { port: number }).port;
  }
  async function command(action: string, inputs?: unknown) {
    const id = crypto.randomUUID(); control.command = { id, action, inputs }; await writeControl();
    await eventually(async () => { try { return await readFile(join(f.directory, 'command-done'), 'utf8') === id; } catch { return false; } });
    await partner.snapshot();
  }
  async function state() {
    if (process.env.IMAGE_FIXTURE_EVIDENCE) {
      await mkdir(process.env.IMAGE_FIXTURE_EVIDENCE, { recursive: true });
      await writeFile(join(process.env.IMAGE_FIXTURE_EVIDENCE, `native-${f.directory.split('/').at(-1)}.json`), JSON.stringify({ workspace: f.workspace, requests: await f.requests(), submissions }, null, 2));
    }
    const backend = createCodexChatBackend(partner);
    const view = await backend.read();
    const album = await backend.album({ sessionId: view.sessionId, cursor: null });
    const requests = await f.requests();
    return { executions: requests.filter(r => r.fixtureExecution === true).length, submissions, recovery: view.recovery,
      messages: view.messages, limits: imageLimits, album: album.images };
  }
  async function action(input: { action: string; enabled?: boolean; state?: string }) {
    if (input.action === 'reset') {
      await app.close(); await f.close(); f = await fixture(); disabled = false; uploadFailure = false; submissions.length = 0;
      control = { hold: true, mode: 'consumed' }; await start();
    } else if (input.action === 'mode') { control.mode = input.state; await writeControl(); }
    else if (input.action === 'disabled') { disabled = !!input.enabled; for (const listener of listeners) listener(); }
    else if (input.action === 'uploadFailure') { uploadFailure = !!input.enabled; }
    else if (input.action === 'complete' || input.action === 'history') {
      await command(input.action);
      await eventually(async () => input.action === 'complete' ? (await partner.snapshot()).results.some(r => r.completedMessages.some(m => m.text === '完整图片回复')) : (await f.requests()).length > 0);
    } else if (input.action === 'nativeRecovery') {
      const previous = control.mode; control.mode = 'unconsumed'; await writeControl();
      const id = crypto.randomUUID();
      await partner.submit(id, '原生恢复输入', [{ type: 'image', name: 'native.png', mediaType: 'image/png', data: fixtureImage.toString('base64') }]).catch(() => undefined);
      control.mode = previous; await writeControl();
    } else if (input.action === 'missing') {
      for (const source of await partner.sharedRecovery()) for (const image of source.images)
        await rm(imagePath(f.workspace, { id: image.attachmentId, media_type: image.mediaType }), { force: true });
    } else if (input.action === 'consume') {
      const recovery = await partner.sharedRecovery();
      await command('consume', recovery.map(source => ({ id: source.sourceId, text: source.text,
        images: source.images.filter(image => image.availability === 'available').map(image => ({ path: imagePath(f.workspace, { id: image.attachmentId, media_type: image.mediaType }) })) })));
      await eventually(async () => (await partner.sharedRecovery()).length === 0);
    } else if (input.action !== 'state') throw new Error('Unknown fixture action');
    return state();
  }
  await start();
  const controls = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const result = await action(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { console.error(error); response.writeHead(500); response.end(String(error)); }
  });
  controls.listen(controlPort, '127.0.0.1'); await once(controls, 'listening');
  return { get f() { return f; }, get partner() { return partner; }, action,
    origin: `http://127.0.0.1:${port}`, controlUrl: `http://127.0.0.1:${(controls.address() as { port: number }).port}/__test/image-send-recovery`,
    async close() { await app.close(); await f.close(); await new Promise<void>(done => controls.close(() => done())); } };
}

if (process.argv[1] === import.meta.filename) {
  const host = await imageAcceptanceFixture(resolve(process.argv[2]!), Number(process.argv[3] ?? 0), Number(process.argv[4] ?? 0));
  console.log(JSON.stringify({ origin: host.origin, controlUrl: host.controlUrl, workspace: host.f.workspace }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().then(() => process.exit()); });
}
