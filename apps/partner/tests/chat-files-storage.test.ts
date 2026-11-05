import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixture.ts';

const source = (bytes: Buffer) => (async function* () { yield bytes; })();

test('stream write and directory sync failures retain safe staging and allow a new attempt', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const originalOpen = fs.open;
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId }, bytes = Buffer.from('content');
    const manifest = { sessionId, operationId, files: [{ id: 'f', name: 'file', mediaType: '', size: bytes.length }] };
    const attachments = join(f.workspace, '.lamplit', 'attachments');
    await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
    const opRoot = join(attachments, '.file-operations'), opDir = join(opRoot, (await fs.readdir(opRoot))[0]!);
    let failWrite = true, failSync = false;
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (failWrite && String(args[0]).endsWith('/p0.tmp')) {
        failWrite = false; handle.write = (async () => { throw new Error('injected write failure'); }) as typeof handle.write;
      } else if (failSync && args[0] === opDir) {
        handle.sync = async () => { failSync = false; throw new Error('injected sync failure'); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(partner.fileOperationReceive(operationId, 'f', source(bytes), owner, async () => true, () => true), /injected write failure/);
    assert.deepEqual((await partner.fileOperationStatus(operationId, owner, async () => true))!.uploaded, []);
    assert.deepEqual(await fs.readdir(opDir), []);
    failSync = true;
    await assert.rejects(partner.fileOperationReceive(operationId, 'f', source(bytes), owner, async () => true, () => true), /injected sync failure/);
    assert.deepEqual((await partner.fileOperationStatus(operationId, owner, async () => true))!.uploaded, []);
    fs.open = originalOpen; syncBuiltinESMExports();
    const retryId = crypto.randomUUID();
    await partner.fileOperationReserve({ ...manifest, operationId: retryId }, owner, async () => true, () => true);
    await partner.fileOperationReceive(retryId, 'f', source(bytes), owner, async () => true, () => true);
    const result = await partner.fileOperationComplete(retryId, owner, async () => true, () => true);
    const opened = await partner.openSharedFile(result.files[0]!.ref.attachmentId, owner); assert.ok(opened);
    try { assert.deepEqual(await opened.handle.readFile(), bytes); } finally { await opened.handle.close(); }
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('a swapped temporary symlink is never admitted or used to overwrite an outside file', async () => {
  const f = await fixture(); const partner = await f.createPartner(); const originalLink = fs.link;
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId }, bytes = Buffer.from('content');
    const outside = join(f.directory, 'outside'); await fs.writeFile(outside, 'keep');
    await partner.fileOperationReserve({ sessionId, operationId, files: [{ id: 'f', name: 'file', mediaType: '', size: bytes.length }] }, owner, async () => true, () => true);
    fs.link = async (...args: Parameters<typeof fs.link>) => { await fs.unlink(args[0]); await fs.symlink(outside, args[0]); return originalLink(...args); };
    syncBuiltinESMExports();
    await assert.rejects(partner.fileOperationReceive(operationId, 'f', source(bytes), owner, async () => true, () => true), /Published file changed/);
    assert.deepEqual((await partner.fileOperationStatus(operationId, owner, async () => true))!.uploaded, []);
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  } finally { fs.link = originalLink; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

test('a symlink operation root cannot redirect uploads', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const attachments = join(f.workspace, '.lamplit', 'attachments');
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    const outside = join(f.directory, 'outside-directory'); await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, join(attachments, '.file-operations'));
    await assert.rejects(partner.fileOperationReserve({ sessionId, operationId, files: [{ id: 'f', name: 'f', mediaType: '', size: 1 }] }, owner, async () => true, () => true));
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await partner.close(); await f.close(); }
});
