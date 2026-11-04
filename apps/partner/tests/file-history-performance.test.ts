import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

test('history checks only returned files, repeating integrity checks after changes and across clients', async () => {
  // Count actual reads in this test process; the fake app-server is a separate process.
  const originalOpen = fs.open;
  let reads = 0, bytes = 0;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('.file')) {
      const originalRead = handle.readFile;
      handle.readFile = (async (...readArgs: Parameters<typeof originalRead>) => {
        const result = await originalRead.apply(handle, readArgs);
        reads += 1; bytes += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
        return result;
      }) as typeof originalRead;
    }
    return handle;
  };
  syncBuiltinESMExports();
  const { fixture, eventually } = await import('./fixture.ts');
  const { createCodexChatBackend } = await import('../runtime/chat.ts');
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner();
  try {
    const backend = createCodexChatBackend(partner), sessionId = (await backend.read()).sessionId;
    const owner = { ownerId: 'owner', sessionId }, payloads: Array<{ id: string; bytes: Buffer; path: string }> = [];
    for (let index = 0; index < 35; index++) {
      const operationId = crypto.randomUUID(), data = Buffer.alloc(64_000, index);
      const uploaded = await partner.uploadFiles({ sessionId, operationId, files: [{ id: 'client', order: 0, name: `file-${index}`, mediaType: '', size: data.length, data: data.toString('base64') }] }, owner, async () => true);
      await backend.submit({ operationId, text: `message ${index}`, files: uploaded.files.map(file => file.ref) });
      payloads.push({ id: operationId, bytes: data, path: join(f.workspace, '.lamplit', 'attachments', `${createHash('sha256').update(data).digest('hex')}.file`) });
    }
    await eventually(async () => (await f.requests()).filter(request => request.method === 'turn/start' || request.method === 'turn/steer').length >= 35, 30000);
    const reset = () => { reads = 0; bytes = 0; };
    reset(); const view = await backend.read();
    assert.equal(view.messages.length, 30); assert.ok(view.before);
    assert.equal(reads, 30); assert.equal(bytes, 30 * 64_000);
    reset(); const refreshed = await backend.read();
    assert.deepEqual(refreshed.messages, view.messages); assert.equal(reads, 30); assert.equal(bytes, 30 * 64_000);
    reset(); const older = await backend.history(view.before!);
    assert.equal(older.messages.length, 5); assert.equal(reads, 5); assert.equal(bytes, 5 * 64_000);
    reset(); await Promise.all([backend.read(), backend.read()]);
    assert.equal(reads, 60); assert.equal(bytes, 60 * 64_000);
    // Same-size modification, removal and symlink substitution must be visible
    // on the next refresh; no previous successful check can authorize a file.
    const changed = payloads[34]!, missing = payloads[33]!, linked = payloads[32]!;
    await fs.writeFile(changed.path, Buffer.alloc(64_000, 99));
    await fs.unlink(missing.path);
    await fs.unlink(linked.path); await fs.symlink(changed.path, linked.path);
    reset(); const after = await backend.read();
    for (const item of [changed, missing, linked]) assert.equal(after.messages.find(message => message.operationId === item.id)?.files?.[0]?.availability, 'missing');
    assert.equal(reads, 28); assert.equal(bytes, 28 * 64_000);
    assert.equal(await partner.sharedFile(uploadedId(after, changed.id), owner), null);
  } finally {
    await partner.close(); await f.close();
    fs.open = originalOpen; syncBuiltinESMExports();
  }
});

function uploadedId(view: Awaited<ReturnType<ReturnType<typeof import('../runtime/chat.ts').createCodexChatBackend>['read']>>, operationId: string) {
  return view.messages.find(message => message.operationId === operationId)!.files![0]!.attachmentId;
}

test('a page validates multiple messages in order with at most six concurrent file reads', async () => {
  const originalOpen = fs.open;
  let measuring = false, active = 0, peak = 0, reads = 0;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('.file')) {
      const originalRead = handle.readFile;
      handle.readFile = (async (...readArgs: Parameters<typeof originalRead>) => {
        if (!measuring) return originalRead.apply(handle, readArgs);
        active++; peak = Math.max(peak, active);
        try {
          // Keep reads in flight long enough to observe overlap deterministically.
          await new Promise(resolve => setTimeout(resolve, 100));
          const result = await originalRead.apply(handle, readArgs);
          reads++;
          return result;
        } finally { active--; }
      }) as typeof originalRead;
    }
    return handle;
  };
  syncBuiltinESMExports();
  const { fixture, eventually } = await import('./fixture.ts');
  const { createCodexChatBackend } = await import('../runtime/chat.ts');
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner();
  try {
    const backend = createCodexChatBackend(partner), sessionId = (await backend.read()).sessionId;
    const owner = { ownerId: 'owner', sessionId }, operations: string[] = [];
    for (let index = 0; index < 4; index++) {
      const operationId = crypto.randomUUID(); operations.push(operationId);
      const files = Array.from({ length: 6 }, (_, order) => {
        const bytes = Buffer.alloc(32_000, index * 6 + order);
        return { id: `client-${order}`, order, name: `file-${index}-${order}`, mediaType: '', size: bytes.length, data: bytes.toString('base64') };
      });
      const uploaded = await partner.uploadFiles({ sessionId, operationId, files }, owner, async () => true);
      await backend.submit({ operationId, text: `message ${index}`, files: uploaded.files.map(file => file.ref) });
    }
    await eventually(async () => (await f.requests()).filter(request => request.method === 'turn/start' || request.method === 'turn/steer').length >= 4, 30000);
    measuring = true;
    const view = await backend.read();
    measuring = false;
    assert.equal(reads, 24);
    assert.ok(peak >= 2 && peak <= 6, `expected 2–6 simultaneous reads, observed ${peak}`);
    assert.deepEqual(view.messages.map(message => message.operationId), operations);
    for (const [index, message] of view.messages.entries()) assert.deepEqual(message.files?.map(file => file.name), Array.from({ length: 6 }, (_, order) => `file-${index}-${order}`));
  } finally {
    await partner.close(); await f.close();
    fs.open = originalOpen; syncBuiltinESMExports();
  }
});
