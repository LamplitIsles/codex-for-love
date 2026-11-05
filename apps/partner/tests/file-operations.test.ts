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

test('manifest enforces exact per-file and aggregate boundaries', () => {
  const manifest = { sessionId: 'session', operationId: crypto.randomUUID(), files: [{ id: 'one', name: 'one', mediaType: '', size: 100_000_000 }, { id: 'two', name: 'two', mediaType: '', size: 100_000_000 }] };
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.throws(() => validateManifest({ ...manifest, files: [{ ...manifest.files[0]!, size: 100_000_001 }] }));
  assert.throws(() => validateManifest({ ...manifest, files: [...manifest.files, { id: 'three', name: 'three', mediaType: '', size: 1 }] }));
  assert.throws(() => validateManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] }));
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
    await partner.submitShared({ operationId, text: 'mixed', images: image.images.map(item => item.ref), files: files.files.map(item => item.ref) });
    assert.equal((await partner.chatReceipt(operationId))?.state, 'submitted');
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
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, root = `${origin}/api/chat/file-operations`;
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'f', name: 'f', mediaType: '', size: 0 }] };
    const reserve = (input: typeof manifest) => fetch(root, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal((await reserve(manifest)).status, 200);
    assert.equal((await fetch(`${root}/${operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: '' })).status, 204);
    assert.equal((await fetch(`${root}/${operationId}/complete`, { method: 'POST', headers: { origin } })).status, 200);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    assert.equal((await reserve({ ...manifest, operationId: crypto.randomUUID() })).status, 200);
    for (const response of [await fetch(`${root}/${operationId}`), await reserve(manifest), await fetch(`${root}/${operationId}/complete`, { method: 'POST', headers: { origin } }), await fetch(`${root}/${operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: '' })]) {
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), { error: { code: 'file_operation_retired', message: 'File operation retired; start a new attempt explicitly.' } });
    }
    assert.equal((await fetch(`${root}/${crypto.randomUUID()}`)).status, 404);
  } finally { Date.now = realNow; await app.close(); await f.close(); }
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
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now, originalLimits = partner.sharedFileLimits;
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, root = `${origin}/api/chat/file-operations`;
  const reserve = (manifest: unknown) => fetch(root, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
  try {
    const sessionId = (await partner.snapshot()).sessionId;
    const make = (size: number) => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size }] });
    const retired = make(0); assert.equal((await reserve(retired)).status, 200);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    const active = make(2); assert.equal((await reserve(active)).status, 200);
    const verifyStatus = async () => {
      const existing = await fetch(`${root}/${active.operationId}`); assert.equal(existing.status, 200); assert.deepEqual((await existing.json() as { manifest: unknown }).manifest, active);
      assert.equal((await fetch(`${root}/${retired.operationId}`)).status, 410);
      assert.equal((await fetch(`${root}/${crypto.randomUUID()}`)).status, 404);
    };
    partner.sharedFileLimits = async () => false;
    await verifyStatus();
    assert.equal((await reserve(make(0))).status, 503);
    assert.equal((await reserve(retired)).status, 503);
    assert.equal((await fetch(`${root}/${retired.operationId}/complete`, { method: 'POST', headers: { origin } })).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: 'xx' })).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/complete`, { method: 'POST', headers: { origin } })).status, 503);
    partner.sharedFileLimits = async () => ({ maxFilesPerMessage: 6, maxFileBytes: 1, maxMessageFileBytes: 1 });
    await verifyStatus();
    assert.equal((await reserve(make(2))).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/files/f`, { method: 'PUT', headers: { origin, 'content-type': 'application/octet-stream' }, body: 'xx' })).status, 503);
    assert.equal((await fetch(`${root}/${active.operationId}/complete`, { method: 'POST', headers: { origin } })).status, 503);
  } finally { Date.now = realNow; partner.sharedFileLimits = originalLimits; await app.close(); await f.close(); }
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

test('retirement resumes after a directory sync failure and restart', async () => {
  const f = await fixture(); let partner = await f.createPartner(); const realNow = Date.now, originalOpen = fs.open;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { yield Buffer.from('a'); })(), owner, async () => true, () => true);
    await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const attachments = join(f.workspace, '.lamplit', 'attachments'), root = join(attachments, '.file-operations'); let injected = false;
    const oldDirectory = join(root, (await fs.readdir(root))[0]!);
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === root) { const sync = handle.sync.bind(handle); handle.sync = async () => { if (!injected) { injected = true; throw new Error('injected sync failure'); } await sync(); }; }
      return handle;
    };
    syncBuiltinESMExports(); Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    assert.equal(injected, true);
    await assert.rejects(partner.fileOperationStatus(operationId, owner, async () => true), /retired/);
    fs.open = originalOpen; syncBuiltinESMExports();
    await partner.close(); partner = await f.createPartner();
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationReserve(manifest, owner, async () => true, () => true), /retired/);
    await assert.rejects(partner.submitShared({ operationId, text: 'late', files: [] }), /identity|retired|different/i);
    await assert.rejects(fs.lstat(oldDirectory), { code: 'ENOENT' });
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); Date.now = realNow; await partner.close(); await f.close(); }
});

test('unknown directory entries keep retirement charged and remain untouched', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { yield Buffer.from('a'); })(), owner, async () => true, () => true);
    await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations'), dir = join(root, (await fs.readdir(root))[0]!);
    const keep = join(dir, 'unrelated'); await fs.writeFile(keep, 'keep');
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationStatus(operationId, owner, async () => true), /retired/);
    assert.equal(await fs.readFile(keep, 'utf8'), 'keep');
    assert.ok((await fs.readdir(dir)).some(name => name.startsWith('p0-')));
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('changed published bytes are retained and retirement keeps its quota', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { yield Buffer.from('a'); })(), owner, async () => true, () => true);
    await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations'), dir = join(root, (await fs.readdir(root))[0]!);
    const path = join(dir, (await fs.readdir(dir)).find(name => name.startsWith('p0-'))!); await fs.writeFile(path, 'z');
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    for (let i = 0; i < 15; i++) await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true), /quota/);
    await assert.rejects(partner.fileOperationStatus(operationId, owner, async () => true), /retired/);
    assert.equal(await fs.readFile(path, 'utf8'), 'z');
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('files outside an operation directory are never deleted by name alone', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size: 0 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    const path = join(f.workspace, '.lamplit', 'attachments', `.upload-${operationId}-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(path, 'unverified'); Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationStatus(operationId, owner, async () => true), /retired/);
    assert.equal(await fs.readFile(path, 'utf8'), 'unverified');
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('expiry removes only the inactive operation’s owned files and releases its reservation', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'a', name: 'a', mediaType: '', size: 1 }, { id: 'b', name: 'b', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'a', (async function* () { yield Buffer.from('a'); })(), owner, async () => true, () => true);
    const attachments = join(f.workspace, '.lamplit', 'attachments');
    const operationRoot = join(attachments, '.file-operations'), oldDirectory = join(operationRoot, (await fs.readdir(operationRoot))[0]!);
    assert.equal((await fs.readdir(oldDirectory)).filter(name => name.startsWith('p0-')).length, 1);
    const unrelated = join(attachments, 'unrelated.file'); await fs.writeFile(unrelated, 'keep');
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationStatus(operationId, owner, async () => true), /retired/);
    await assert.rejects(fs.lstat(oldDirectory), { code: 'ENOENT' });
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('unfinished reservation count is bounded without charging exact duplicates twice', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = () => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'a', name: 'a', mediaType: '', size: 0 }] });
    const initial = manifest();
    await partner.fileOperationReserve(initial, owner, async () => true, () => true);
    await partner.fileOperationReserve(initial, owner, async () => true, () => true);
    for (let i = 1; i < 16; i++) await partner.fileOperationReserve(manifest(), owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationReserve(manifest(), owner, async () => true, () => true), /quota/);
  } finally { await partner.close(); await f.close(); }
});

test('declared reservation bytes are capped across operations', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    for (let i = 0; i < 4; i++) await partner.fileOperationReserve({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'a', name: 'a', mediaType: '', size: 100_000_000 }, { id: 'b', name: 'b', mediaType: '', size: 100_000_000 }] }, owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationReserve({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'c', name: 'c', mediaType: '', size: 1 }] }, owner, async () => true, () => true), /quota/);
  } finally { await partner.close(); await f.close(); }
});

test('abandoned completed reservations release quota while failed and admitted files remain', async () => {
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
    const failed = results[1]!, admitted = results[2]!;
    await partner.finalizeSubmission({ sessionId, submission: { operationId: failed.operationId, text: 'failed', files: failed.files.map(item => item.ref), images: failed.images } });
    assert.equal((await partner.deleteFailed({ sessionId, operationId: failed.operationId })).deleted, true);
    await partner.submitShared({ operationId: admitted.operationId, text: 'admitted', files: admitted.files.map(item => item.ref), images: admitted.images });
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'new', mediaType: '', size: 0 }] }, owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationStatus(results[0]!.operationId, owner, async () => true), /retired/);
    assert.ok((await partner.fileOperationStatus(failed.operationId, owner, async () => true))?.result);
    assert.ok((await partner.fileOperationStatus(admitted.operationId, owner, async () => true))?.result);
    const attachments = join(f.workspace, '.lamplit', 'attachments');
    for (const protectedOp of [failed, admitted]) { const opened = await partner.openSharedFile(protectedOp.files[0]!.ref.attachmentId, owner); assert.ok(opened); await opened.handle.close(); }
    for (const item of results) assert.deepEqual((await partner.sharedMedia(item.images[0]!.attachmentId, 'original'))?.bytes, fixtureImage);
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('expired completed operations free a full count quota', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const make = () => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'empty', mediaType: '', size: 0 }] });
    for (let i = 0; i < 16; i++) {
      const manifest = make(); await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
      await partner.fileOperationReceive(manifest.operationId, 'f', (async function* () {})(), owner, async () => true, () => true);
      await partner.fileOperationComplete(manifest.operationId, owner, async () => true, () => true);
    }
    await assert.rejects(partner.fileOperationReserve(make(), owner, async () => true, () => true), /quota/);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve(make(), owner, async () => true, () => true);
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('expired idle uploads reclaim quota behind many successful retry sources', async () => {
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const data = Buffer.from('source'), sources: Array<{ operationId: string; ref: string; retryRef: string }> = [];
    for (let i = 0; i < 33; i++) {
      const operationId = crypto.randomUUID();
      const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'f', name: 'f', mediaType: '', bytes: data }]);
      assert.equal((await partner.finalizeSubmission({ sessionId, submission: { operationId, text: 'retry', files: staged.files.map(item => item.ref) } }))?.state, 'failed');
      const retry = await partner.retryFailed({ sessionId, operationId, attemptId: crypto.randomUUID() });
      assert.equal(retry.state, 'submitted');
      sources.push({ operationId, ref: staged.files[0]!.ref.attachmentId, retryRef: retry.retryFiles!.files[0]!.ref.attachmentId });
    }
    const failedId = crypto.randomUUID(), failed = await stageTestFiles(partner, sessionId, failedId, [{ id: 'f', name: 'f', mediaType: '', bytes: data }]);
    assert.equal((await partner.finalizeSubmission({ sessionId, submission: { operationId: failedId, text: 'failed', files: failed.files.map(item => item.ref) } }))?.state, 'failed');
    const make = () => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'empty', mediaType: '', size: 0 }] });
    const idle: string[] = [];
    for (let i = 0; i < 15; i++) {
      const operationId = crypto.randomUUID(); idle.push(operationId);
      await stageTestFiles(partner, sessionId, operationId, [{ id: 'f', name: 'empty', mediaType: '', bytes: Buffer.alloc(0) }]);
    }
    await assert.rejects(partner.fileOperationReserve(make(), owner, async () => true, () => true), /quota/);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve(make(), owner, async () => true, () => true);
    for (const operationId of idle) await assert.rejects(partner.fileOperationStatus(operationId, owner, async () => true), /retired/);
    assert.ok((await partner.fileOperationStatus(failedId, owner, async () => true))?.result);
    assert.deepEqual(await readTestFile(partner, failed.files[0]!.ref.attachmentId, owner), data);
    for (const source of sources) {
      assert.ok((await partner.fileOperationStatus(source.operationId, owner, async () => true))?.result);
      assert.deepEqual(await readTestFile(partner, source.ref, owner), data);
      assert.deepEqual(await readTestFile(partner, source.retryRef, owner), data);
    }
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('expired mixed image and file staging frees quota while retaining image bytes', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const imageInput = (id: string) => ({ sessionId, operationId: id, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png' as const, original: fixtureImage.toString('base64'), preview: Buffer.from([255, 216, 255, 217]).toString('base64'), model: Buffer.from([255, 216, 255, 217]).toString('base64') }] });
    const mixed = await partner.uploadImages(imageInput(operationId));
    const unrelated = await partner.uploadImages(imageInput(crypto.randomUUID()));
    const mixedId = mixed.images[0]!.ref.attachmentId, unrelatedId = unrelated.images[0]!.ref.attachmentId;
    const beforeMixed = await partner.sharedMedia(mixedId, 'original'), beforeOther = await partner.sharedMedia(unrelatedId, 'original');
    assert.deepEqual(beforeMixed?.bytes, fixtureImage); assert.deepEqual(beforeOther?.bytes, fixtureImage);
    const manifest = { sessionId, operationId, files: [{ id: 'f', name: 'file', mediaType: '', size: 1 }] };
    const make = () => ({ sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'empty', mediaType: '', size: 0 }] });
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'f', (async function* () { yield Buffer.from('x'); })(), owner, async () => true, () => true);
    const completed = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations'), oldDirectory = join(root, (await fs.readdir(root))[0]!);
    for (let i = 0; i < 15; i++) await partner.fileOperationReserve(make(), owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationReserve(make(), owner, async () => true, () => true), /quota/);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve(make(), owner, async () => true, () => true);
    await assert.rejects(partner.fileOperationStatus(operationId, owner, async () => true), /retired/);
    await assert.rejects(partner.uploadImages(imageInput(operationId)), /different content/);
    await assert.rejects(partner.submitShared({ operationId, text: 'late', files: completed.files.map(file => file.ref), images: mixed.images.map(image => image.ref) }));
    assert.deepEqual((await partner.sharedMedia(mixedId, 'original'))?.bytes, beforeMixed?.bytes);
    assert.deepEqual((await partner.sharedMedia(unrelatedId, 'original'))?.bytes, beforeOther?.bytes);
    await assert.rejects(fs.lstat(oldDirectory), { code: 'ENOENT' });
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('active uploads remain protected past the expiry cutoff', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    const pending = partner.fileOperationReceive(manifest.operationId, 'f', (async function* () { started(); await gate; yield Buffer.from('x'); })(), owner, async () => true, () => true);
    await entered; Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    assert.deepEqual((await partner.fileOperationStatus(manifest.operationId, owner, async () => true))?.uploaded, []);
    release(); await pending;
    assert.deepEqual((await partner.fileOperationStatus(manifest.operationId, owner, async () => true))?.uploaded, ['f']);
  } finally { release(); Date.now = realNow; await partner.close(); await f.close(); }
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

test('an explicit reservation retry protects its own expired operation', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 0 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    assert.deepEqual((await partner.fileOperationReserve(manifest, owner, async () => true, () => true)).uploaded, []);
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    assert.ok(await partner.fileOperationStatus(manifest.operationId, owner, async () => true));
  } finally { Date.now = realNow; await partner.close(); await f.close(); }
});

test('a staged download being opened protects the operation from retirement', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now, originalOpen = fs.open;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(manifest.operationId, 'f', (async function* () { yield Buffer.from('x'); })(), owner, async () => true, () => true);
    const result = await partner.fileOperationComplete(manifest.operationId, owner, async () => true, () => true);
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      if (/\/p0-[a-f0-9]{64}\.file$/u.test(String(args[0]))) { entered(); await gate; }
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    const download = partner.openSharedFile(result.files[0]!.ref.attachmentId, owner);
    await started; Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    assert.ok((await partner.fileOperationStatus(manifest.operationId, owner, async () => true))?.result);
    release(); const opened = await download; assert.ok(opened);
    try { assert.equal((await opened.handle.readFile()).toString(), 'x'); } finally { await opened.handle.close(); }
  } finally { release(); fs.open = originalOpen; syncBuiltinESMExports(); Date.now = realNow; await partner.close(); await f.close(); }
});

test('an active submission cannot be retired while its authorization waits', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const realNow = Date.now;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    const manifest = { sessionId, operationId: crypto.randomUUID(), files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] };
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    await partner.fileOperationReceive(manifest.operationId, 'f', (async function* () { yield Buffer.from('x'); })(), owner, async () => true, () => true);
    const result = await partner.fileOperationComplete(manifest.operationId, owner, async () => true, () => true);
    const submission = partner.submitShared({ operationId: manifest.operationId, text: 'send', files: result.files.map(file => file.ref) }, async () => { entered(); await gate; return true; });
    await started; Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    await partner.fileOperationReserve({ ...manifest, operationId: crypto.randomUUID() }, owner, async () => true, () => true);
    assert.ok((await partner.fileOperationStatus(manifest.operationId, owner, async () => true))?.result);
    release(); assert.equal((await submission).state, 'submitted');
  } finally { release(); Date.now = realNow; await partner.close(); await f.close(); }
});

test('raw upload applies backpressure at the 100,000,000/200,000,000-byte boundaries', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const originalOpen = fs.open; let writes = 0, pulled = 0, writing = false;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, operationId = crypto.randomUUID();
    const manifest = { sessionId, operationId, files: [{ id: 'large', name: 'large.bin', mediaType: '', size: 100_000_000 }, { id: 'large2', name: 'large2.bin', mediaType: '', size: 100_000_000 }] };
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
      const chunk = Buffer.alloc(64 * 1024, 0x51); let remaining = 100_000_000;
      while (remaining) { assert.equal(writing, false); assert.equal(pulled, writes); const size = Math.min(chunk.length, remaining); pulled++; remaining -= size; yield chunk.subarray(0, size); }
    }
    await partner.fileOperationReceive(operationId, 'large', source(), owner, async () => true, () => true);
    await partner.fileOperationReceive(operationId, 'large2', source(), owner, async () => true, () => true);
    assert.ok(writes > 1000);
    const completed = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
    assert.equal(completed.files[0]!.ref.size, 100_000_000);
    assert.equal(completed.files[1]!.ref.size, 100_000_000);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});
