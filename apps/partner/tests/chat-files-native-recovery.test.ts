import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';

function upload(sessionId: string, operationId: string, bytes: Buffer) {
  return { sessionId, operationId, files: [{ id: 'client', order: 0, name: 'original', mediaType: '', size: bytes.length, data: bytes.toString('base64') }] };
}
function attempts(requests: Record<string, unknown>[], id: string) {
  return requests.filter(request => (request.method === 'turn/start' || request.method === 'turn/steer') && (request.params as { clientUserMessageId?: string }).clientUserMessageId === id);
}

for (const mode of ['start', 'steer'] as const) test(`known local ${mode} file failure is recoverable and never dispatched`, async () => {
  const f = await fixture(); await f.holdProvider(true); let partner = await f.createPartner();
  const originalOpen = fs.open; let target = '', enabled = false, checks = 0;
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    if (mode === 'steer') { const first = crypto.randomUUID(); await partner.submitShared({ operationId: first, text: 'active' }); await eventually(async () => f.consumed(first)); }
    const operationId = crypto.randomUUID(), bytes = Buffer.from(`local-${mode}`);
    const staged = await partner.uploadFiles(upload(sessionId, operationId, bytes), owner, async () => true);
    target = join(f.workspace, '.lamplit', 'attachments', `${createHash('sha256').update(bytes).digest('hex')}.file`);
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      if (enabled && args[0] === target && ++checks === 2) {
        enabled = false;
        if (mode === 'start') await fs.unlink(target);
        else await fs.writeFile(target, Buffer.alloc(bytes.length, 7));
      }
      return originalOpen(...args);
    };
    syncBuiltinESMExports(); enabled = true;
    const submission = { operationId, text: mode === 'start' ? '' : 'original message', files: staged.files.map(item => item.ref) };
    assert.equal((await partner.submitShared(submission)).state, 'submitted');
    await eventually(async () => !!(await partner.chatReceipt(operationId))?.error);
    assert.equal(checks, 2);
    assert.equal(attempts(await f.requests(), operationId).length, 0);
    const receipt = await partner.chatReceipt(operationId); assert.equal(receipt?.state, 'submitted'); assert.match(receipt?.error ?? '', /File unavailable before native submission/);
    const recovery = (await partner.sharedRecovery()).find(item => item.operationId === operationId)!;
    assert.equal(recovery.replacementEligible, true); assert.equal(recovery.files?.[0]?.availability, 'missing');
    assert.equal((await partner.submitShared(submission)).state, 'submitted'); assert.equal(attempts(await f.requests(), operationId).length, 0);
    await partner.close(); partner = await f.createPartner();
    assert.ok((await partner.chatReceipt(operationId))?.error);
    assert.equal((await partner.sharedRecovery()).find(item => item.operationId === operationId)?.files?.[0]?.availability, 'missing');
    const replacementId = crypto.randomUUID(), replacementBytes = Buffer.from('reselected');
    const next = await partner.uploadFiles(upload(sessionId, replacementId, replacementBytes), owner, async () => true);
    const replaced = await createCodexChatBackend(partner).submit({ operationId: replacementId, text: 'reselected', files: next.files.map(item => item.ref), replacementSourceIds: [operationId] });
    assert.equal(replaced.state, 'submitted');
    assert.equal((await partner.sharedRecovery()).some(item => item.operationId === operationId), false);
    assert.equal(attempts(await f.requests(), operationId).length, 0);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await partner.close(); await f.close(); }
});

for (const mode of ['start', 'steer'] as const) test(`dispatched ${mode} RPC uncertainty remains unresolved without replay`, async () => {
  const f = await fixture(); f.appServer.env.FAKE_IMAGES_FIXTURE = 'true'; await f.holdProvider(true); let partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, owner = { ownerId: 'owner', sessionId };
    if (mode === 'steer') { const first = crypto.randomUUID(); await partner.submitShared({ operationId: first, text: 'active' }); await eventually(async () => f.consumed(first)); }
    await fs.writeFile(f.appServer.env.FAKE_SERVER_CONTROL!, JSON.stringify({ hold: true, mode: 'uncertain' }));
    const operationId = crypto.randomUUID(), staged = await partner.uploadFiles(upload(sessionId, operationId, Buffer.from('bytes')), owner, async () => true);
    const submission = { operationId, text: 'uncertain', files: staged.files.map(item => item.ref) };
    assert.equal((await partner.submitShared(submission)).state, 'submitted');
    await eventually(async () => (await partner.snapshot({}, false)).messages.some(message => message.id === operationId && message.delivery === 'unresolved'));
    assert.equal(attempts(await f.requests(), operationId).length, 1);
    assert.equal((await partner.chatReceipt(operationId))?.error, null);
    assert.equal((await partner.sharedRecovery()).some(item => item.operationId === operationId), false);
    assert.equal((await partner.submitShared(submission)).state, 'submitted');
    assert.equal(attempts(await f.requests(), operationId).length, 1);
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.sharedRecovery()).some(item => item.operationId === operationId), false);
    assert.equal((await partner.chatReceipt(operationId))?.error, null);
    assert.equal(attempts(await f.requests(), operationId).length, 1);
  } finally { await partner.close(); await f.close(); }
});
