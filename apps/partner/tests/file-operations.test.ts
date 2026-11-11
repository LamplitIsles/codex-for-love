import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { appendFileSync, truncateSync } from 'node:fs';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from './web-server.ts';
import { validateManifest } from '../runtime/file-operations.ts';
import { FileOperationNotFound, FileOperationRetired } from '../runtime/store.ts';
import { FileRefSchema, validate } from '@lamplit/contracts';
import { fixtureImage } from './panels-seed.ts';
import { readTestFile, stageTestFiles } from './file-fixture.ts';
import { imagePath } from '../runtime/images.ts';

test('manifest enforces exact per-file and aggregate boundaries', () => {
  const manifest = { sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'one', name: 'one', mediaType: '', size: 100_000_000 }, { id: 'two', name: 'two', mediaType: '', size: 100_000_000 }] };
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.throws(() => validateManifest({ ...manifest, files: [{ ...manifest.files[0]!, size: 100_000_001 }] }));
  assert.throws(() => validateManifest({ ...manifest, files: [...manifest.files, { id: 'three', name: 'three', mediaType: '', size: 1 }] }));
  assert.throws(() => validateManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] }));
  assert.throws(() => validateManifest({ ...manifest, files: [...manifest.files, ...Array.from({ length: 5 }, (_, index) => ({ id: `x${index}`, name: 'x', mediaType: '', size: 0 }))] }));
  assert.throws(() => validateManifest({ sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'one', name: 'one', mediaType: '', size: 100_000_000 }, { id: 'two', name: 'two', mediaType: '', size: 100_000_001 }] }));
});

test('manifest text limits count Unicode code points, including supplementary characters', () => {
  const make = (name: string, mediaType: string) => ({ sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'a', name, mediaType, size: 0 }] });
  assert.doesNotThrow(() => validateManifest(make('😀'.repeat(200), '🦊'.repeat(255))));
  assert.throws(() => validateManifest(make('😀'.repeat(201), '')));
  assert.throws(() => validateManifest(make('valid', '🦊'.repeat(256))));
  assert.doesNotThrow(() => validateManifest({ ...make('valid', ''), sessionId: '😀'.repeat(300) }));
  assert.throws(() => validateManifest({ ...make('valid', ''), sessionId: '😀'.repeat(301) }));
  for (const [name, mediaType] of [['😀'.repeat(200), '🦊'.repeat(255)], ['😀'.repeat(201), ''], ['x', '🦊'.repeat(256)], ['\ud800'.repeat(200), '']]) {
    const accepted = (fn: () => unknown) => { try { fn(); return true; } catch { return false; } };
    assert.equal(accepted(() => validateManifest(make(name!, mediaType!))), accepted(() => validate(FileRefSchema, { attachmentId: 'a', name, mediaType, size: 0, availability: 'available' })));
  }
});

test('matching contracts advertise streaming limits and the published old pin fails closed', async () => {
  const f = await fixture(); let oldRoot: string | undefined;
  try {
    const partner = await f.createPartner();
    assert.deepEqual(await partner.sharedFileLimits(), { maxFilesPerMessage: 6, maxFileBytes: 100_000_000, maxMessageFileBytes: 200_000_000 });
    oldRoot = await fs.mkdtemp(join(tmpdir(), 'lamplit-old-contracts-'));
    const archive = fileURLToPath(new URL('./fixtures/lamplit-contracts-9b30d315.tar.gz', import.meta.url));
    assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'), 'bfa450d08ae466ce6dc4fca524d3706a20949c8c213313d006fd27c495f78b42');
    await promisify(execFile)('tar', ['-xzf', archive, '-C', oldRoot]);
    const oldPackage = join(oldRoot, 'package');
    const source = JSON.parse(await fs.readFile(join(oldPackage, 'lamplit-source.json'), 'utf8'));
    assert.equal(source.revision, '9b30d315453c1dd833b52b7a38b53e6ea4f745e0');
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const oldPackage = process.argv[2], matchingEntry = process.argv[3];
      const oldBase = pathToFileURL(oldPackage + '/').href;
      const exports = JSON.parse(readFileSync(join(oldPackage, 'package.json'), 'utf8')).exports;
      const loaded = new Set();
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === matchingEntry || specifier === '@lamplit/contracts' || specifier.startsWith('@lamplit/contracts/')) {
          const key = specifier === matchingEntry || specifier === '@lamplit/contracts' ? '.' : '.' + specifier.slice('@lamplit/contracts'.length);
          loaded.add(key);
          return { url: new URL(exports[key].import, oldBase).href, shortCircuit: true };
        }
        if (context.parentURL?.startsWith(oldBase) && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
          return nextResolve(specifier, { ...context, parentURL: matchingEntry });
        }
        return nextResolve(specifier, context);
      } });
      const oldContracts = await import(process.argv[3]);
      assert.ok('FILE_UPLOAD_PATH' in oldContracts && !('FILE_OPERATIONS_PATH' in oldContracts));
      loaded.clear();
      const { fixture } = await import(process.argv[1]);
      assert.ok(loaded.has('.') && loaded.has('./server'));
      const f = await fixture();
      try { await assert.rejects(f.createPartner(), /Matching streaming file contracts are required/); }
      finally { await f.close(); }
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, new URL('./fixture.ts', import.meta.url).href, oldPackage, import.meta.resolve('@lamplit/contracts')]);
  } finally { try { if (oldRoot) await fs.rm(oldRoot, { recursive: true, force: true }); } finally { await f.close(); } }
});

test('startup preserves unregistered empty directories', async () => {
  const f = await fixture();
  try {
    const path = join(f.workspace, '.lamplit', 'attachments', '.file-operations', 'empty-before-reservation');
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    const partner = await f.createPartner();
    assert.equal((await fs.lstat(path)).isDirectory(), true);
    await partner.close();
  } finally { await f.close(); }
});

test('stream operations survive restart, reject conflicts and publish only complete files', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
  const check = async () => true, commit = () => true;
  const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'a', name: 'data', mediaType: '', size: 4 }, { id: 'b', name: 'empty', mediaType: '', size: 0 }] };
  const bytes = async function* (...chunks: string[]) { for (const chunk of chunks) yield Buffer.from(chunk); };
  try {
    assert.deepEqual((await partner.fileOperationReserve(manifest, owner, check, commit)).uploaded, []);
    await assert.rejects(partner.fileOperationComplete(manifest.operationId, owner, check, commit));
    await assert.rejects(partner.fileOperationReceive(manifest.operationId, 'a', bytes('abc'), owner, check, commit));
    await assert.rejects(partner.fileOperationReceive(manifest.operationId, 'a', bytes('abcde'), owner, check, commit));
    await assert.rejects(partner.fileOperationReceive(manifest.operationId, 'a', (async function* () { yield Buffer.from('ab'); throw new Error('interrupted'); })(), owner, check, commit), /interrupted/);
    await partner.fileOperationReceive(manifest.operationId, 'a', bytes('ab', 'cd'), owner, check, commit);
    await partner.fileOperationReceive(manifest.operationId, 'a', bytes('abcd'), owner, check, commit);
    await assert.rejects(partner.fileOperationReceive(manifest.operationId, 'a', bytes('abce'), owner, check, commit));
    await assert.rejects(partner.fileOperationReserve({ ...manifest, files: [{ ...manifest.files[0]!, name: 'changed' }] }, owner, check, commit));
    assert.equal(await partner.fileOperationStatus(manifest.operationId, { ...owner, sessionId: 'other' }, check).catch(() => null), null);
    await partner.close(); partner = await f.createPartner();
    assert.deepEqual((await partner.fileOperationStatus(manifest.operationId, owner, check))!.uploaded, ['a']);
    await partner.fileOperationReceive(manifest.operationId, 'b', bytes(), owner, check, commit);
    const completed = await partner.fileOperationComplete(manifest.operationId, owner, check, commit);
    assert.deepEqual(await partner.fileOperationComplete(manifest.operationId, owner, check, commit), completed);
    const first = await partner.openSharedFile(completed.files[0]!.ref.attachmentId, owner); assert.ok(first); try { assert.deepEqual(await first.handle.readFile(), Buffer.from('abcd')); } finally { await first.handle.close(); }
    const empty = await partner.openSharedFile(completed.files[1]!.ref.attachmentId, owner); assert.ok(empty); try { assert.deepEqual(await empty.handle.readFile(), Buffer.alloc(0)); } finally { await empty.handle.close(); }
  } finally { await partner.close(); await f.close(); }
});

test('streamed file and image staging can share an operation and be admitted together', async () => {
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    const image = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: Buffer.from([255, 216, 255, 217]).toString('base64'), model: Buffer.from([255, 216, 255, 217]).toString('base64') }] });
    const manifest = { sessionId, operationId, files: [{ id: 'file', name: 'note', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'file', (async function* () { yield Buffer.from('x'); })(), owner, async () => true, () => true);
    const files = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    await partner.submitNativeDelivery({ operationId, text: 'mixed', images: image.images.map(item => item.ref), files: files.files.map(item => item.ref) });
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
  } finally { await partner.close(); await f.close(); }
});

test('HTTP raw upload and bounded download enforce authorization', async () => {
  const f = await fixture(); const partner = await f.createPartner(); let authorized = true;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: (() => authorized) as unknown as () => Promise<boolean> });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'hello', mediaType: 'text/plain', size: 5 }] };
    const root = `${origin}/api/chat/file-operations`;
    assert.equal((await fetch(`${origin}/api/chat/files`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(root, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(manifest) })).status, 200);
    assert.equal((await fetch(`${root}/${operationId}/files/a`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: 'hello' })).status, 204);
    const completed = await fetch(`${root}/${operationId}/complete`, { method: 'POST', headers: { origin } }); assert.equal(completed.status, 200);
    const result = await completed.json() as { files: Array<{ ref: { attachmentId: string } }> };
    const download = await fetch(`${origin}/api/chat/files/${result.files[0]!.ref.attachmentId}`);
    assert.equal(download.headers.get('content-length'), '5');
    assert.equal(download.headers.get('content-disposition'), 'attachment');
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(download.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(await download.text(), 'hello');
    authorized = false;
    assert.equal((await fetch(`${root}/${operationId}`)).status, 401);
    assert.equal((await fetch(`${origin}/api/chat/files/${result.files[0]!.ref.attachmentId}`)).status, 401);
  } finally { await app.close(); await f.close(); }
});

test('writable workspace permits uploads without changing permissions or existing downloads', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, root = `${origin}/api/chat/file-operations`;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, oldId = crypto.randomUUID();
    const original = { sessionId, operationId: oldId, files: [{ id: 'f', name: 'file', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(original, owner, async () => true, () => true);
    await partner.fileOperationReceive(oldId, 'f', (async function* () { yield Buffer.from('x'); })(), owner, async () => true, () => true);
    const saved = await partner.fileOperationComplete(oldId, owner, async () => true, () => true);
    for (const mode of [0o770, 0o707]) {
      await fs.chmod(f.workspace, mode);
      const next = { ...original, operationId: crypto.randomUUID() };
      assert.equal((await fetch(root, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(next) })).status, 200);
      assert.equal((await fetch(`${root}/${next.operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: 'y' })).status, 204);
      assert.equal((await fs.stat(f.workspace)).mode & 0o777, mode);
    }
    const download = await fetch(`${origin}/api/chat/files/${saved.files[0]!.ref.attachmentId}`);
    assert.equal(download.status, 200); assert.equal(await download.text(), 'x');
  } finally { await app.close(); await f.close(); }
});

test('HTTP reports retired operations distinctly and never reuses their identity', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, root = `${origin}/api/chat/file-operations`;
  const status = partner.fileOperationStatus, reserveOperation = partner.fileOperationReserve;
  const operationId = crypto.randomUUID();
  const manifest = { sessionId: 'session', operationId, files: [{ id: 'f', name: 'f', mediaType: '', size: 0 }] };
  const reserve = () => fetch(root, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
  try {
    partner.fileOperationStatus = async () => { throw new FileOperationRetired(); };
    partner.fileOperationReserve = async () => { throw new FileOperationRetired(); };
    for (const response of [await fetch(`${root}/${operationId}`), await reserve(), await fetch(`${root}/${operationId}/complete`, { method: 'POST', headers: { origin } }), await fetch(`${root}/${operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: '' })]) {
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), { error: { code: 'file_operation_retired', message: 'File operation retired; start a new attempt explicitly.' } });
    }
    partner.fileOperationStatus = async () => { throw new FileOperationNotFound(); };
    partner.fileOperationReserve = async () => { throw new FileOperationNotFound(); };
    assert.equal((await fetch(`${root}/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await reserve()).status, 404);
  } finally { partner.fileOperationStatus = status; partner.fileOperationReserve = reserveOperation; await app.close(); await f.close(); }
});

test('retired and missing responses recheck authorization and session after a race', async () => {
  const f = await fixture(); const partner = await f.createPartner(); let authorized = true, sessionChanged = false;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: (() => authorized) as unknown as () => Promise<boolean> });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const root = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/file-operations/${crypto.randomUUID()}`;
  const status = partner.fileOperationStatus, snapshot = partner.snapshot;
  try {
    partner.fileOperationStatus = async () => { authorized = false; throw new FileOperationRetired(); };
    assert.equal((await fetch(root)).status, 403);
    authorized = true;
    partner.snapshot = async () => { const value = await snapshot.call(partner); return sessionChanged ? { ...value, sessionId: 'different-session' } : value; };
    partner.fileOperationStatus = async () => { sessionChanged = true; throw new FileOperationNotFound(); };
    assert.equal((await fetch(root)).status, 403);
    sessionChanged = false;
    partner.fileOperationStatus = async () => { sessionChanged = true; return { manifest: { sessionId: 'old', operationId: crypto.randomUUID(), files: [] }, uploaded: [] }; };
    assert.equal((await fetch(root)).status, 403);
  } finally { partner.fileOperationStatus = status; partner.snapshot = snapshot; await app.close(); await f.close(); }
});

test('HTTP operation status remains available when intake is disabled or reduced', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const originalLimits = partner.sharedFileLimits;
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, root = `${origin}/api/chat/file-operations`;
  const reserve = (manifest: unknown) => fetch(root, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
  try {
    const sessionId = (await partner.snapshot()).sessionId;
    const make = (size: number) => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size }] });
    const idle = make(0); assert.equal((await reserve(idle)).status, 200);
    const active = make(2); assert.equal((await reserve(active)).status, 200);
    const verifyStatus = async () => {
      const existing = await fetch(`${root}/${active.operationId}`); assert.equal(existing.status, 200); assert.deepEqual((await existing.json() as { manifest: unknown }).manifest, active);
      assert.equal((await fetch(`${root}/${idle.operationId}`)).status, 200);
      assert.equal((await fetch(`${root}/${crypto.randomUUID()}`)).status, 404);
    };
    partner.sharedFileLimits = async () => false;
    await verifyStatus();
    assert.equal((await reserve(make(0))).status, 503);
    assert.equal((await reserve(idle)).status, 503);
    assert.equal((await fetch(`${root}/${idle.operationId}/complete`, { method: 'POST', headers: { origin } })).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: 'xx' })).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/complete`, { method: 'POST', headers: { origin } })).status, 503);
    partner.sharedFileLimits = async () => ({ maxFilesPerMessage: 6, maxFileBytes: 1, maxMessageFileBytes: 1 });
    await verifyStatus();
    assert.equal((await reserve(make(2))).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: 'xx' })).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/complete`, { method: 'POST', headers: { origin } })).status, 503);
  } finally { partner.sharedFileLimits = originalLimits; await app.close(); await f.close(); }
});

test('HTTP manifest accepts escaped six-file metadata and enforces 32,768-byte body limit', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const sessionId = (await partner.snapshot()).sessionId;
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: Array.from({ length: 6 }, (_, index) => ({ id: `f${index}`, name: '\u0000'.repeat(200), mediaType: '\u0000'.repeat(255), size: 0 })) };
    const json = JSON.stringify(manifest);
    assert.ok(Buffer.byteLength(json) > 16_384);
    const send = (value: string) => fetch(`${origin}/api/chat/file-operations`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: value });
    assert.equal((await send(json)).status, 200);
    const exact = json + ' '.repeat(32_768 - Buffer.byteLength(json));
    assert.equal(Buffer.byteLength(exact), 32_768);
    assert.equal((await send(exact)).status, 200);
    assert.equal((await send(`${exact} `)).status, 413);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(exact)); controller.enqueue(Buffer.from(' ')); controller.close(); } });
    const streamed = await fetch(`${origin}/api/chat/file-operations`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    assert.equal(streamed.status, 400);
  } finally { await app.close(); await f.close(); }
});

test('streamed downloads stop at verified size, abort on truncation and support empty files', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const originalOpen = fs.open;
  const app = createWebServer(partner, join(f.directory, 'assets'));
  let sent = 0;
  app.server.prependListener('request', (request, response) => {
    if (!request.url?.startsWith('/api/chat/files/')) return;
    const write = response.write.bind(response);
    response.write = ((chunk: Uint8Array, ...args: unknown[]) => { sent += chunk.byteLength; return (write as (...values: unknown[]) => boolean)(chunk, ...args); }) as typeof response.write;
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'data', mediaType: '', size: 5 }, { id: 'empty', name: 'empty', mediaType: '', size: 0 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { yield Buffer.from('hello'); })(), owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'empty', (async function* () {})(), owner, async () => true, () => true);
    const result = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations');
    const directory = join(root, (await fs.readdir(root))[0]!);
    const target = join(directory, (await fs.readdir(directory)).find(name => name.startsWith('p0-'))!);
    let mutation: 'grow' | 'shrink' | undefined = 'grow';
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === target) {
        const create = handle.createReadStream.bind(handle);
        handle.createReadStream = ((options?: Parameters<typeof handle.createReadStream>[0]) => {
          if (mutation === 'grow') appendFileSync(target, 'excess');
          else if (mutation === 'shrink') truncateSync(target, 2);
          mutation = undefined;
          return create(options);
        }) as typeof handle.createReadStream;
      }
      return handle;
    };
    syncBuiltinESMExports();
    const url = `${origin}/api/chat/files/${result.files[0]!.ref.attachmentId}`;
    const grown = await fetch(url); assert.equal(await grown.text(), 'hello'); assert.equal(sent, 5);
    await fs.writeFile(target, 'hello'); mutation = 'shrink'; sent = 0;
    await assert.rejects(async () => { const truncated = await fetch(url); await truncated.arrayBuffer(); });
    assert.ok(sent <= 2);
    const empty = await fetch(`${origin}/api/chat/files/${result.files[1]!.ref.attachmentId}`);
    assert.equal(empty.status, 200); assert.equal(empty.headers.get('content-length'), '0'); assert.equal(await empty.text(), '');
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await app.close(); await f.close(); }
});

test('simultaneous downloads are bounded before opening files', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    await partner.fileOperationReserve({ sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size: 1 }] }, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { yield Buffer.from('a'); })(), owner, async () => true, () => true);
    const result = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const open = partner.openSharedFile.bind(partner); let started = 0;
    partner.openSharedFile = async (...args) => { started++; await gate; return open(...args); };
    const url = `${origin}/api/chat/files/${result.files[0]!.ref.attachmentId}`;
    const pending = Array.from({ length: 4 }, () => fetch(url));
    await eventually(async () => started === 4);
    assert.equal((await fetch(url)).status, 503); assert.equal(started, 4);
    release();
    for (const response of await Promise.all(pending)) { assert.equal(response.status, 200); assert.equal(await response.text(), 'a'); }
    const recovered = await fetch(url); assert.equal(recovered.status, 200); await recovered.arrayBuffer();
    partner.openSharedFile = async () => { throw new Error('injected download failure'); };
    for (const response of await Promise.all(Array.from({ length: 4 }, () => fetch(url)))) assert.equal(response.status, 400);
    partner.openSharedFile = open;
    const afterFailures = await fetch(url); assert.equal(afterFailures.status, 200); await afterFailures.arrayBuffer();
  } finally { release(); await app.close(); await f.close(); }
});

test('download slots stay occupied after end until small and empty responses finish', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  const held: Array<{ response: import('node:http').ServerResponse; release: () => void }> = [];
  app.server.prependListener('request', (request, response) => {
    if (!request.url?.startsWith('/api/chat/files/') || held.length >= 4) return;
    const socket = response.socket!; const write = socket._write.bind(socket), writev = socket._writev?.bind(socket); let released = false;
    const hold = (callback: (error?: Error | null) => void, error?: Error | null) => {
      held.push({ response, release: () => { if (released) return; released = true; socket._write = write; socket._writev = writev; callback(error); } });
    };
    socket._write = ((chunk, encoding, callback) => {
      write(chunk, encoding, error => hold(callback, error));
    }) as typeof socket._write;
    if (writev) socket._writev = ((chunks, callback) => { writev(chunks, error => hold(callback, error)); }) as typeof socket._writev;
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    await partner.fileOperationReserve({ sessionId, operationId, files: [{ id: 'empty', name: 'empty', mediaType: '', size: 0 }, { id: 'small', name: 'small', mediaType: '', size: 1 }] }, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'empty', (async function* () {})(), owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'small', (async function* () { yield Buffer.from('a'); })(), owner, async () => true, () => true);
    const result = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const open = partner.openSharedFile.bind(partner); let closed = 0;
    partner.openSharedFile = async (...args) => {
      const file = await open(...args);
      if (file) { const close = file.handle.close.bind(file.handle); file.handle.close = async () => { try { await close(); } finally { closed++; } }; }
      return file;
    };
    const urls = result.files.map(file => `${origin}/api/chat/files/${file.ref.attachmentId}`);
    const request = (url: string) => new Promise<IncomingMessage>((resolve, reject) => { const req = httpGet(url, { agent: false }, resolve); req.once('error', reject); });
    const pending = [request(urls[0]!), request(urls[1]!), request(urls[0]!), request(urls[1]!)];
    await eventually(async () => held.length === 4 && closed >= 4 && held.every(entry => entry.response.writableEnded && !entry.response.writableFinished)).catch(error => { throw new Error(`pending responses: held=${held.length} closed=${closed} states=${held.map(entry => `${entry.response.writableEnded}/${entry.response.writableFinished}`).join(',')}`, { cause: error }); });
    await new Promise(resolve => setImmediate(resolve));
    const denied = await request(urls[1]!); assert.equal(denied.statusCode, 503); denied.resume();
    held[0]!.release();
    await eventually(async () => held[0]!.response.writableFinished);
    const next = await request(urls[1]!); assert.equal(next.statusCode, 200); next.resume();
    for (const entry of held) entry.release();
    for (const response of await Promise.all(pending)) { assert.equal(response.statusCode, 200); response.resume(); }
  } finally { for (const entry of held) entry.release(); await app.close(); await f.close(); }
});

test('slow HTTP download sockets stay bounded and release their slots on disconnect', async t => {
  const f = await fixture(); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const responses: IncomingMessage[] = [];
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId }, size = 24_000_000;
    await partner.fileOperationReserve({ sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size }] }, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { const chunk = Buffer.alloc(64 * 1024); for (let left = size; left > 0;) { const count = Math.min(left, chunk.length); left -= count; yield chunk.subarray(0, count); } })(), owner, async () => true, () => true);
    const result = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const url = `${origin}/api/chat/files/${result.files[0]!.ref.attachmentId}`, before = process.memoryUsage().rss;
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const request = httpGet(url, response => { response.pause(); responses.push(response); resolve(); });
      request.once('error', reject);
    })));
    assert.equal((await fetch(url)).status, 503);
    const increase = process.memoryUsage().rss - before;
    t.diagnostic(`RSS increase with four paused 24 MB downloads: ${increase} bytes`);
    assert.ok(increase < 96_000_000, `unexpected retained download memory: ${increase}`);
    responses[0]!.destroy();
    await eventually(async () => { const probe = await fetch(url); if (probe.status !== 200) return false; await probe.body?.cancel(); return true; });
  } finally { for (const response of responses) response.destroy(); await app.close(); await f.close(); }
});

test('staging has no global operation or byte quota', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = (size: number) => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'a', name: 'a', mediaType: '', size }, { id: 'b', name: 'b', mediaType: '', size: 100_000_000 - size }] });
    const operations: string[] = [];
    for (let index = 0; index < 24; index++) {
      const input = manifest(100_000_000);
      operations.push(input.operationId);
      assert.deepEqual((await partner.fileOperationReserve(input, owner, async () => true, () => true)).uploaded, []);
    }
    for (const operationId of operations) assert.ok(await partner.fileOperationStatus(operationId, owner, async () => true));
  } finally { await partner.close(); await f.close(); }
});

test('abandoned staging and its files are retained indefinitely', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { yield Buffer.from('a'); })(), owner, async () => true, () => true);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations'), directory = join(root, (await fs.readdir(root))[0]!);
    const path = join(directory, (await fs.readdir(directory)).find(name => name.startsWith('p0-'))!);
    const unrelated = join(f.workspace, '.lamplit', 'attachments', 'unrelated.file'); await fs.writeFile(unrelated, 'keep');
    Date.now = () => realNow() + 30 * 24 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    assert.equal(await fs.readFile(path, 'utf8'), 'a');
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
    assert.deepEqual((await partner.fileOperationStatus(operationId, owner, async () => true))?.uploaded, ['a']);
    const completed = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    assert.equal(completed.files[0]?.ref.size, 1);
    assert.equal(await fs.readFile(path, 'utf8'), 'a');
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('failed and admitted attachments remain readable while an abandoned operation is retained', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const results: Array<{ operationId: string; files: Array<{ ref: import('@lamplit/contracts').FileRef }>; images: import('@lamplit/contracts').ImageRef[] }> = [];
    for (let i = 0; i < 3; i++) {
      const operationId = crypto.randomUUID(), manifest = { sessionId, operationId, files: [{ id: 'f', name: 'file', mediaType: '', size: 1 }] };
      const image = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: Buffer.from([255, 216, 255, 217]).toString('base64'), model: Buffer.from([255, 216, 255, 217]).toString('base64') }] });
      await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
      await partner.fileOperationReceive(operationId, 'f', (async function* () { yield Buffer.from('x'); })(), owner, async () => true, () => true);
      results.push({ ...await partner.fileOperationComplete(operationId, owner, async () => true, () => true), images: image.images.map(item => item.ref) });
    }
    const [abandoned, failed, admitted] = results;
    const failedImage = imagePath(f.workspace, { id: failed!.images[0]!.attachmentId, media_type: failed!.images[0]!.mediaType });
    await fs.writeFile(failedImage, Buffer.from('changed'));
    await partner.submitNativeDelivery({ operationId: failed!.operationId, text: 'failed', files: failed!.files.map(item => item.ref), images: failed!.images });
    await eventually(async () => (await partner.lookupNativeDelivery(failed!.operationId))?.state === 'failed');
    await fs.writeFile(failedImage, fixtureImage);
    await partner.submitNativeDelivery({ operationId: admitted!.operationId, text: 'admitted', files: admitted!.files.map(item => item.ref), images: admitted!.images });
    Date.now = () => realNow() + 30 * 24 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'new', mediaType: '', size: 0 }] }, owner, async () => true, () => true);
    for (const kept of [abandoned!, failed!, admitted!]) assert.ok((await partner.fileOperationStatus(kept.operationId, owner, async () => true))?.result);
    const attachments = join(f.workspace, '.lamplit', 'attachments');
    for (const kept of [failed!, admitted!]) { const opened = await partner.openSharedFile(kept.files[0]!.ref.attachmentId, owner); assert.ok(opened); await opened.handle.close(); }
    for (const item of results) assert.deepEqual((await partner.sharedMedia(item.images[0]!.attachmentId, 'original'))?.bytes, fixtureImage);
    for (const item of results) { const directory = join(attachments, '.file-operations'); assert.ok((await fs.readdir(directory)).length >= 3); }
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('an upload in flight is not reported as uploaded before it is recorded', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    const pending = partner.fileOperationReceive(manifest.operationId, 'f', (async function* () { started(); await gate; yield Buffer.from('x'); })(), owner, async () => true, () => true);
    await entered;
    assert.deepEqual((await partner.fileOperationStatus(manifest.operationId, owner, async () => true))?.uploaded, []);
    release(); await pending;
    assert.deepEqual((await partner.fileOperationStatus(manifest.operationId, owner, async () => true))?.uploaded, ['f']);
  } finally { release(); await partner.close(); await f.close(); }
});

test('four active uploads bound concurrent file writes', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const tasks: Promise<void>[] = [];
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifests = Array.from({ length: 5 }, () => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] }));
    for (const manifest of manifests) await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    const started: Promise<void>[] = [];
    for (const manifest of manifests.slice(0, 4)) {
      let entered!: () => void; started.push(new Promise<void>(resolve => { entered = resolve; }));
      tasks.push(partner.fileOperationReceive(manifest.operationId, 'f', (async function* () { entered(); await gate; yield Buffer.from('x'); })(), owner, async () => true, () => true));
    }
    await Promise.all(started);
    await assert.rejects(partner.fileOperationReceive(manifests[4]!.operationId, 'f', (async function* () { yield Buffer.from('x'); })(), owner, async () => true, () => true), /busy/);
    release(); await Promise.all(tasks);
  } finally { release(); await Promise.allSettled(tasks); await partner.close(); await f.close(); }
});

test('private directory streaming waits for each bounded write before pulling another chunk', async () => {
  const f = await fixture(); const partner = await f.createPartner(), originalOpen = fs.open;
  let writing = false, writes = 0, pulls = 0;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'f', name: 'f', mediaType: '', size: 16 * 65536 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (/\/p[0-5]\.tmp$/u.test(String(args[0]))) {
        const write = handle.write.bind(handle);
        handle.write = (async (...values: Parameters<typeof handle.write>) => { writing = true; await new Promise(resolve => setImmediate(resolve)); const result = await write(...values); writes++; writing = false; return result; }) as typeof handle.write;
      }
      return handle;
    };
    syncBuiltinESMExports();
    const source = async function* () { const chunk = Buffer.alloc(65536); for (let index = 0; index < 16; index++) { assert.equal(writing, false); assert.equal(pulls, writes); pulls++; yield chunk; } };
    await partner.fileOperationReceive(operationId, 'f', source(), owner, async () => true, () => true);
    assert.equal(writes, 16);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('an idempotent reservation after a long idle returns the same operation', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 0 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    Date.now = () => realNow() + 30 * 24 * 60 * 60 * 1000;
    assert.deepEqual((await partner.fileOperationReserve(manifest, owner, async () => true, () => true)).uploaded, []);
    assert.ok(await partner.fileOperationStatus(manifest.operationId, owner, async () => true));
    await assert.rejects(partner.fileOperationReserve({ ...manifest, files: [{ id: 'f', name: 'changed', mediaType: '', size: 0 }] }, owner, async () => true, () => true), /different content/);
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('a submission cannot observe an operation while its upload is being recorded', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    const pending = partner.fileOperationReceive(manifest.operationId, 'f', (async function* () { started(); await gate; yield Buffer.from('x'); })(), owner, async () => true, () => true);
    await entered;
    await assert.rejects(partner.submitNativeDelivery({ operationId: manifest.operationId, text: 'send' }), /Upload busy/);
    release(); await pending;
    const result = await partner.fileOperationComplete(manifest.operationId, owner, async () => true, () => true);
    await partner.submitNativeDelivery({ operationId: manifest.operationId, text: 'send', files: result.files.map(file => file.ref) });
    await eventually(async () => (await partner.lookupNativeDelivery(manifest.operationId))?.state === 'submitted');
  } finally { release(); await partner.close(); await f.close(); }
});

// Per-file 100,000,000 and per-message 200,000,000 limits are covered by
// 'manifest enforces exact per-file and aggregate boundaries'; this case proves
// one bounded write per pulled chunk, so it keeps a 64 MB temp footprint.
test('raw upload writes each chunk before pulling the next for multi-megabyte files', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const originalOpen = fs.open; let writes = 0, pulled = 0, writing = false;
  const size = 32_000_000, chunkSize = 64 * 1024;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'large', name: 'large.bin', mediaType: '', size }, { id: 'large2', name: 'large2.bin', mediaType: '', size }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (/\/p[0-5]\.tmp$/u.test(String(args[0]))) {
        const write = handle.write.bind(handle);
        handle.write = (async (...writeArgs: Parameters<typeof handle.write>) => {
          writing = true; await new Promise(resolve => setImmediate(resolve));
          const value = await write(...writeArgs); writes++; writing = false; return value;
        }) as typeof handle.write;
      }
      return handle;
    };
    syncBuiltinESMExports();
    async function* source() {
      const chunk = Buffer.alloc(chunkSize, 0x51); let remaining = size;
      while (remaining) { assert.equal(writing, false); assert.equal(pulled, writes); const length = Math.min(chunk.length, remaining); pulled++; remaining -= length; yield chunk.subarray(0, length); }
    }
    await partner.fileOperationReceive(operationId, 'large', source(), owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'large2', source(), owner, async () => true, () => true);
    assert.equal(pulled, 2 * Math.ceil(size / chunkSize));
    assert.equal(writes, pulled);
    const completed = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    assert.equal(completed.files[0]!.ref.size, size);
    assert.equal(completed.files[1]!.ref.size, size);
    assert.deepEqual((await partner.fileOperationStatus(operationId, owner, async () => true))?.uploaded, ['large', 'large2']);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});
