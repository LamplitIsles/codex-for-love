import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, stat, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { compressBackground, createBackgroundSettings, MAX_BACKGROUND_BYTES, BACKGROUND_EDGE } from '../runtime/background-settings.ts';
import { acquirePrivateFileLock } from '../runtime/private-file-lock.ts';
import { fixture } from './fixture.ts';
import { createWebServer } from './web-server.ts';
import { voiceFixture } from './voice-fixture.ts';

const image = () => sharp({create:{width:30,height:20,channels:3,background:'red'}});
const noop = () => {};

test('background decoder accepts static raster formats, applies EXIF, bounds pixels and strips metadata', async () => {
  for (const format of ['png','jpeg','webp','gif'] as const) {
    const input = await image()[format]().toBuffer();
    const output = await compressBackground(input,`image/${format}`);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format,'webp');
    assert.equal(metadata.width,30); assert.equal(metadata.height,20);
    assert.equal(metadata.exif,undefined);
  }
  const input = await sharp({create:{width:3000,height:1500,channels:3,background:'blue'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const output = await compressBackground(input,'image/jpeg');
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width,1280); assert.equal(metadata.height,BACKGROUND_EDGE);
  assert.equal(metadata.orientation,undefined); assert.equal(metadata.exif,undefined);
  assert.ok(output.length < 3000 * 1500 * 3 / 10);
  const animated = await sharp(Buffer.from([255,0,0,255,0,255,0,255]),{raw:{width:1,height:2,channels:4,pageHeight:1}}).gif({delay:[100,100]}).toBuffer();
  const huge = await image().png().toBuffer(); huge.writeUInt32BE(40_000_001,16);
  for (const [bytes,type] of [[animated,'image/gif'],[await image().png().toBuffer(),'image/jpeg'],[Buffer.from('bad'),'image/png'],[Buffer.alloc(MAX_BACKGROUND_BYTES+1),'image/png'],[huge,'image/png']] as const) {
    await assert.rejects(compressBackground(bytes,type),{code:'invalid_background'});
  }
});

test('per-slot persistence, fallback, concurrency, revocation and failed writes preserve committed images', async () => {
  const root = await mkdtemp(join(tmpdir(),'background-settings-'));
  const directory = join(root,'.lamplit','profile','background-settings');
  try {
    const png = await image().png().toBuffer();
    const legacyPath = join(root,'legacy.png'); await writeFile(legacyPath,png);
    const legacyLink = join(root,'legacy-link.png'); await symlink(legacyPath,legacyLink);
    const settings = await createBackgroundSettings(root,{portrait:legacyLink});
    assert.deepEqual(settings.snapshot(),{landscape:false,portrait:true});
    assert.deepEqual(settings.effective('landscape')!.data,png);
    await settings.save('landscape',png,'image/png',()=>true,noop);
    const saved = settings.effective('landscape')!.data;
    assert.equal((await stat(join(directory,'landscape.webp'))).mode & 0o777,0o600);
    assert.equal((await stat(directory)).mode & 0o777,0o700);
    assert.deepEqual(await readFile(legacyPath),png);
    await symlink(root,join(root,'alias'));
    const aliased = await createBackgroundSettings(join(root,'alias'),{portrait:join(root,'alias','legacy.png')});
    assert.deepEqual(aliased.snapshot(),{landscape:true,portrait:true});
    const single = await createBackgroundSettings(root);
    assert.deepEqual(single.snapshot(),{landscape:true,portrait:false});
    assert.deepEqual(single.effective('portrait')!.data,saved);
    const reloaded = await createBackgroundSettings(root,{landscape:join(root,'superseded-missing.png'),portrait:legacyPath});
    assert.deepEqual(reloaded.snapshot(),{landscape:true,portrait:true});
    assert.deepEqual(reloaded.effective('landscape')!.data,saved);
    await assert.rejects(createBackgroundSettings(root,{portrait:join(root,'missing.png')}),/ENOENT/);
    const lock = await acquirePrivateFileLock(join(directory,'landscape.webp.lock')); assert.ok(lock);
    try { await assert.rejects(settings.save('landscape',png,'image/png',()=>true,noop),{status:409}); }
    finally { await lock.close(); }
    await assert.rejects(settings.save('landscape',png,'image/png',()=>false,noop),{status:401});
    await assert.rejects(settings.save('landscape',Buffer.from('bad'),'image/png',()=>true,noop),{status:400});
    assert.deepEqual(settings.effective('landscape')!.data,saved);
    assert.deepEqual(await readFile(join(directory,'landscape.webp')),saved);
    const overlapping = await Promise.allSettled([settings.save('landscape',png,'image/png',()=>true,noop),settings.save('landscape',png,'image/png',()=>true,noop)]);
    assert.equal(overlapping.filter(value=>value.status==='fulfilled').length,1);
    assert.ok(overlapping.some(value=>value.status==='rejected' && value.reason.status===409));
    const results = await Promise.all([settings.save('landscape',png,'image/png',()=>true,noop),settings.save('portrait',png,'image/png',()=>true,noop)]);
    assert.deepEqual(settings.snapshot(),{landscape:true,portrait:true});
    assert.ok(results.every(value => value.landscape));
    for (const kind of ['landscape','portrait'] as const) {
      assert.deepEqual(settings.effective(kind)!.data,await readFile(join(directory,`${kind}.webp`)));
      assert.equal(settings.effective(kind)!.mediaType,'image/webp');
    }
    // Force a precommit staging failure without relying on Unix user/root permissions.
    await rename(directory,`${directory}.saved`); await symlink(legacyPath,directory);
    await assert.rejects(settings.save('landscape',png,'image/png',()=>true,noop),{status:503});
    assert.deepEqual(settings.effective('landscape')!.data,saved);
    assert.deepEqual(await readFile(join(`${directory}.saved`,'landscape.webp')),saved);
    assert.deepEqual(await readFile(legacyPath),png);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('HTTP uploads update appearance and native snapshots without restart or message-library admission', async () => {
  const f = await fixture();
  const png = await image().png().toBuffer();
  let allowed = true;
  const partner = await f.createPartner();
  const app = createWebServer(partner,join(f.directory,'assets'),{authorize:async()=>allowed});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const upload = (kind:string,bytes:Buffer = png,type = 'image/png',site = origin) => fetch(`${origin}/api/background-settings/${kind}`,{method:'POST',headers:{origin:site,'content-type':type},body:new Uint8Array(bytes)}).then(response => {assert.equal(response.headers.get('cache-control'),'no-store'); return response;});
  try {
    let response = await fetch(`${origin}/api/background-settings`);
    assert.deepEqual(await response.json(),{landscape:false,portrait:false});
    assert.equal(response.headers.get('cache-control'),'no-store');
    allowed = false;
    for (const response of [await fetch(`${origin}/api/background-settings`),await upload('landscape'),await fetch(`${origin}/api/backgrounds/landscape`)]) {
      assert.equal(response.status,401); assert.equal(response.headers.get('cache-control'),'no-store');
    }
    allowed = true;
    response = await upload('landscape',png,'image/png','http://evil.invalid'); assert.equal(response.status,403);
    response = await upload('landscape',png,'image/svg+xml'); assert.equal(response.status,415);
    response = await upload('landscape',Buffer.from('bad')); assert.equal(response.status,400);
    response = await upload('unknown'); assert.equal(response.status,400);
    response = await upload('portrait',Buffer.alloc(MAX_BACKGROUND_BYTES+1)); assert.equal(response.status,413);
    let notifications = 0; const off = partner.subscribe(()=>notifications++);
    response = await upload('landscape');
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{landscape:true,portrait:false});
    assert.equal(notifications,1); off();
    const urls = {landscape:'/api/backgrounds/landscape',portrait:'/api/backgrounds/portrait'};
    assert.deepEqual(partner.appearance().backgrounds,urls);
    assert.deepEqual((await partner.snapshot()).backgrounds,urls);
    const landscape = await fetch(`${origin}${urls.landscape}?v=first`), portrait = await fetch(`${origin}${urls.portrait}?v=first`);
    assert.equal(landscape.headers.get('content-type'),'image/webp');
    assert.equal(portrait.headers.get('cache-control'),'no-store');
    const old = Buffer.from(await landscape.arrayBuffer());
    assert.deepEqual(Buffer.from(await portrait.arrayBuffer()),old);
    const blue = await sharp({create:{width:20,height:30,channels:3,background:'blue'}}).png().toBuffer();
    response = await upload('portrait',blue); assert.deepEqual(await response.json(),{landscape:true,portrait:true});
    assert.notDeepEqual(Buffer.from(await (await fetch(`${origin}${urls.portrait}?v=second`)).arrayBuffer()),old);
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}${urls.landscape}?v=second`)).arrayBuffer()),old);
    assert.equal((await partner.conversationImages({})).images.length,0);
    assert.equal((await f.requests()).some(value=>value.method==='turn/start'),false);
    await app.close();
    const restarted = await f.createPartner();
    assert.deepEqual(restarted.backgroundSettings(),{landscape:true,portrait:true});
    assert.deepEqual(restarted.appearance().backgrounds,urls);
  } finally { await app.close(); await f.close(); }
});


test('background uploads do not interrupt an established voice recording', async () => {
  const f = await voiceFixture();
  try {
    const recording = await f.client(); await recording.wait('ready');
    const bytes = await image().png().toBuffer();
    const response = await fetch(`${f.origin}/api/background-settings/portrait`,{method:'POST',headers:{origin:f.origin,'content-type':'image/png'},body:new Uint8Array(bytes)});
    assert.equal(response.status,200);
    assert.equal(recording.ws.readyState,1);
    recording.ws.send(Buffer.alloc(3200)); recording.ws.send(JSON.stringify({type:'finish'}));
    assert.equal((await recording.wait('result')).type,'result');
    assert.equal((await f.f.requests()).some(value=>value.method==='turn/start'),false);
  } finally { await f.close(); }
});
