import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';
import { materializeFiles, readStoredFile } from '../runtime/files.ts';

const make = (sessionId: string, operationId: string, bytes: Buffer) => ({ sessionId, operationId, files: [{ id: 'client', order: 0, name: 'untrusted', mediaType: '', size: bytes.length, data: bytes.toString('base64') }] });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('partial write errors clean only owned temporary files and allow an identical retry', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const originalOpen = fs.open; let fail = true;
  try {
    const sessionId = (await partner.snapshot()).sessionId, bytes = Buffer.from('partial-write'), input = make(sessionId, crypto.randomUUID(), bytes);
    const attachments = join(f.workspace, '.lamplit', 'attachments'), target = join(attachments, `${digest(bytes)}.file`);
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (fail && typeof args[0] === 'string' && args[0].endsWith('.tmp')) {
        fail = false;
        handle.writeFile = (async () => { await handle.write(bytes.subarray(0, 2)); throw Object.assign(new Error('injected write failure'), { code: 'EIO' }); }) as typeof handle.writeFile;
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(partner.uploadFiles(input, { ownerId: 'owner', sessionId }, async () => true), /injected write failure/);
    await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
    assert.equal((await fs.readdir(attachments)).filter(name => name.endsWith('.tmp')).length, 0);
    const staged = await partner.uploadFiles(input, { ownerId: 'owner', sessionId }, async () => true);
    assert.deepEqual(await partner.sharedFile(staged.files[0]!.ref.attachmentId, { ownerId: 'owner', sessionId }), bytes);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('interrupted temporary write does not publish a partial canonical file or block retry', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, bytes = Buffer.from('interrupted-write'), input = make(sessionId, crypto.randomUUID(), bytes);
    const attachments = join(f.workspace, '.lamplit', 'attachments'); await fs.mkdir(attachments, { recursive: true });
    const script = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const [moduleUrl, inputJson, attachments] = process.argv.slice(1);
      const original = fs.open;
      fs.open = async (...args) => { const h = await original(...args); if (String(args[0]).endsWith('.tmp')) h.writeFile = async b => { await h.write(Buffer.from(b).subarray(0,2)); process.exit(87); }; return h; };
      syncBuiltinESMExports();
      const { materializeFiles } = await import(moduleUrl);
      await materializeFiles(JSON.parse(inputJson), 'owner', attachments);
    `;
    const child = promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, new URL('../runtime/files.ts', import.meta.url).href, JSON.stringify(input), attachments]);
    await assert.rejects(child, error => (error as NodeJS.ErrnoException & { code: number }).code === 87);
    await assert.rejects(fs.lstat(join(attachments, `${digest(bytes)}.file`)), { code: 'ENOENT' });
    const orphan = (await fs.readdir(attachments)).filter(name => name.endsWith('.tmp')); assert.equal(orphan.length, 1);
    const staged = await partner.uploadFiles(input, { ownerId: 'owner', sessionId }, async () => true);
    assert.deepEqual(await partner.sharedFile(staged.files[0]!.ref.attachmentId, { ownerId: 'owner', sessionId }), bytes);
    assert.ok((await fs.readdir(attachments)).includes(orphan[0]!), 'another process does not remove an unowned temporary file');
  } finally { await partner.close(); await f.close(); }
});

test('concurrent publication reuses valid bytes and never overwrites corrupt or symlinked paths', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, attachments = join(f.workspace, '.lamplit', 'attachments');
    const shared = Buffer.from('shared');
    const [a,b] = await Promise.all([materializeFiles(make(sessionId, crypto.randomUUID(), shared), 'owner', attachments), materializeFiles(make(sessionId, crypto.randomUUID(), shared), 'owner', attachments)]);
    assert.equal(a.files[0]!.path, b.files[0]!.path);
    assert.deepEqual(await readStoredFile(a.files[0]!, attachments), shared);
    const corrupted = Buffer.from('corrupted-target'), badPath = join(attachments, `${digest(corrupted)}.file`);
    await fs.writeFile(badPath, 'bad');
    const [fallbackA, fallbackB] = await Promise.all([materializeFiles(make(sessionId, crypto.randomUUID(), corrupted), 'owner', attachments), materializeFiles(make(sessionId, crypto.randomUUID(), corrupted), 'owner', attachments)]);
    assert.notEqual(fallbackA.files[0]!.path, badPath); assert.notEqual(fallbackB.files[0]!.path, badPath);
    assert.deepEqual(await readStoredFile(fallbackA.files[0]!, attachments), corrupted);
    assert.deepEqual(await readStoredFile(fallbackB.files[0]!, attachments), corrupted);
    assert.equal(await fs.readFile(badPath, 'utf8'), 'bad');
    const original = make(sessionId, crypto.randomUUID(), corrupted);
    original.files[0]!.name = '\ud800'.repeat(200);
    const staged = await partner.uploadFiles(original, owner, async () => true);
    assert.equal(await fs.readFile(badPath, 'utf8'), 'bad');
    assert.deepEqual(await partner.sharedFile(staged.files[0]!.ref.attachmentId, owner), corrupted);
    const originalSubmit = { operationId: original.operationId, text: 'retry alternate', files: staged.files.map(item => item.ref) };
    await partner.finalizeSubmission({ sessionId, submission: originalSubmit });
    const attemptId = crypto.randomUUID();
    const retry = await partner.retryFailed({ sessionId, operationId: original.operationId, attemptId });
    assert.equal(retry.state, 'submitted'); assert.equal(retry.retryFiles?.files[0]?.sourceAttachmentId, staged.files[0]!.ref.attachmentId);
    assert.deepEqual(await partner.sharedFile(retry.retryFiles!.files[0]!.ref.attachmentId, owner), corrupted);
    await eventually(async () => (await f.requests()).some(request => (request.method === 'turn/start' || request.method === 'turn/steer') && (request.params as { clientUserMessageId?: string }).clientUserMessageId === attemptId));
    const request = (await f.requests()).find(item => (item.method === 'turn/start' || item.method === 'turn/steer') && (item.params as { clientUserMessageId?: string }).clientUserMessageId === attemptId)!;
    const contexts = (request.params as { additionalContext: Record<string, { kind: string; value: string }> }).additionalContext;
    assert.deepEqual(Object.keys(contexts).filter(key => key.startsWith('codex-for-love.file-')), ['codex-for-love.file-0']);
    const entry = contexts['codex-for-love.file-0']!;
    assert.equal(entry.kind, 'untrusted'); assert.ok(Buffer.byteLength(entry.value) < 4000);
    // This actual alternate path and 200 escaped surrogates use the maximum
    // storage-name and per-character widths. Allow 15 extra digits for an
    // index up to MAX_SAFE_INTEGER and the remaining digits up to 8,000,000.
    const worstCaseBytes = Buffer.byteLength(entry.value) + 15 + String(8_000_000).length - String(corrupted.length).length;
    assert.equal(worstCaseBytes, 1441); assert.ok(worstCaseBytes < 4000);
    const fact = JSON.parse(entry.value) as { path: string; name: string; fileIndex: number; operationId: string; size: number };
    assert.match(fact.path, /^\.lamplit\/attachments\/[a-f0-9]{64}-[a-f0-9]{32}\.file$/u);
    assert.equal(fact.operationId, attemptId); assert.equal(fact.fileIndex, 0); assert.equal(fact.size, corrupted.length);
    assert.equal(fact.name, original.files[0]!.name);
    assert.deepEqual(await fs.readFile(join(f.workspace, fact.path)), corrupted);
    const linked = Buffer.from('symlink-target'), symlinkPath = join(attachments, `${digest(linked)}.file`), outside = join(f.directory, 'outside');
    await fs.writeFile(outside, 'outside-owned'); await fs.symlink(outside, symlinkPath);
    const result = await partner.uploadFiles(make(sessionId, crypto.randomUUID(), linked), owner, async () => true);
    assert.ok((await fs.lstat(symlinkPath)).isSymbolicLink()); assert.equal(await fs.readFile(outside, 'utf8'), 'outside-owned');
    assert.deepEqual(await partner.sharedFile(result.files[0]!.ref.attachmentId, owner), linked);
    assert.deepEqual(await fs.readFile(a.files[0]!.path), shared);
  } finally { await partner.close(); await f.close(); }
});

test('failure after publication preserves the complete shared file for an identical retry', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const originalLink = fs.link; let fail = true;
  try {
    const sessionId = (await partner.snapshot()).sessionId, bytes = Buffer.from('published-original'), input = make(sessionId, crypto.randomUUID(), bytes);
    const owner = { ownerId: 'owner', sessionId }, attachments = join(f.workspace, '.lamplit', 'attachments'), target = join(attachments, `${digest(bytes)}.file`);
    fs.link = async (...args: Parameters<typeof fs.link>) => {
      await originalLink(...args);
      if (fail) { fail = false; throw Object.assign(new Error('injected lost publication acknowledgement'), { code: 'EIO' }); }
    };
    syncBuiltinESMExports();
    await assert.rejects(partner.uploadFiles(input, owner, async () => true), /lost publication acknowledgement/);
    assert.deepEqual(await fs.readFile(target), bytes);
    const before = await fs.stat(target);
    const staged = await partner.uploadFiles(input, owner, async () => true);
    const after = await fs.stat(target);
    assert.equal(after.ino, before.ino, 'retry must not replace the already published original');
    assert.deepEqual(await partner.sharedFile(staged.files[0]!.ref.attachmentId, owner), bytes);
    assert.equal((await fs.readdir(attachments)).filter(name => name.endsWith('.tmp')).length, 0);
  } finally { fs.link = originalLink; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('cleanup leaves a replaced temporary symlink and its target untouched', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const originalOpen = fs.open; let replacement = '';
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, bytes = Buffer.from('isolated');
    const outside = join(f.directory, 'owned-outside'); await fs.writeFile(outside, 'keep');
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (typeof args[0] === 'string' && args[0].endsWith('.tmp')) {
        const tempPath = args[0]; replacement = tempPath;
        handle.writeFile = (async () => { await handle.write(bytes.subarray(0, 2)); await fs.unlink(tempPath); await fs.symlink(outside, tempPath); throw new Error('replaced temporary'); }) as typeof handle.writeFile;
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(partner.uploadFiles(make(sessionId, crypto.randomUUID(), bytes), owner, async () => true), /replaced temporary/);
    assert.ok((await fs.lstat(replacement)).isSymbolicLink());
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
    await assert.rejects(fs.lstat(join(f.workspace, '.lamplit', 'attachments', `${digest(bytes)}.file`)), { code: 'ENOENT' });
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('a temporary path swapped for a symlink during publication is rejected without following or removing it', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const originalLink = fs.link; let swapped = false, temporary = '';
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, bytes = Buffer.from('publication-swap');
    const input = make(sessionId, crypto.randomUUID(), bytes), attachments = join(f.workspace, '.lamplit', 'attachments');
    const outside = join(f.directory, 'outside-swap'); await fs.writeFile(outside, 'keep');
    fs.link = async (...args: Parameters<typeof fs.link>) => {
      if (!swapped) {
        swapped = true; temporary = String(args[0]);
        await fs.unlink(temporary); await fs.symlink(outside, temporary);
      }
      return originalLink(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(partner.uploadFiles(input, owner, async () => true), /Published file changed/);
    assert.ok((await fs.lstat(temporary)).isSymbolicLink());
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
    const target = join(attachments, `${digest(bytes)}.file`); assert.ok((await fs.lstat(target)).isSymbolicLink());
    fs.link = originalLink; syncBuiltinESMExports();
    const staged = await partner.uploadFiles(input, owner, async () => true);
    assert.deepEqual(await partner.sharedFile(staged.files[0]!.ref.attachmentId, owner), bytes);
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
    assert.ok((await fs.lstat(target)).isSymbolicLink());
  } finally { fs.link = originalLink; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('directory sync failure does not admit or replace a published original', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const originalOpen = fs.open;
  let fail = true;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId }, bytes = Buffer.from('sync-directory');
    const input = make(sessionId, crypto.randomUUID(), bytes), attachments = join(f.workspace, '.lamplit', 'attachments'), target = join(attachments, `${digest(bytes)}.file`);
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (fail && args[0] === attachments) { fail = false; handle.sync = async () => { throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' }); }; }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(partner.uploadFiles(input, owner, async () => true), /directory sync failure/);
    assert.equal(await partner.chatReceipt(input.operationId), null);
    assert.deepEqual(await fs.readFile(target), bytes);
    const before = await fs.stat(target);
    const result = await partner.uploadFiles(input, owner, async () => true);
    assert.equal((await fs.stat(target)).ino, before.ino);
    assert.deepEqual(await partner.sharedFile(result.files[0]!.ref.attachmentId, owner), bytes);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});
