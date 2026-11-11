import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { readTestFile, stageTestFiles } from './file-fixture.ts';
import { fixtureImage } from './panels-seed.ts';
import { DatabaseSync } from 'node:sqlite';
import { partnerPaths } from '../runtime/storage-paths.ts';

test('streamed files stay scoped, survive history and restart, and reach native in Human text', async () => {
  const f = await fixture(); await f.holdProvider(true); let partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID(), owner = { ownerId: 'owner', sessionId };
    const data = Buffer.from([0, 255, 10]);
    const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'file', name: '../untrusted', mediaType: '', bytes: data }]);
    const ref = staged.files[0]!.ref;
    assert.equal(await readTestFile(partner, ref.attachmentId, { ownerId: 'other', sessionId }), null);
    assert.equal(await readTestFile(partner, ref.attachmentId, { ownerId: 'owner', sessionId: 'other' }), null);
    await partner.submitNativeDelivery({ operationId, text: 'file', files: [ref] });
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    await eventually(async () => (await f.requests()).some(item => item.method === 'turn/start' && (item.params as { clientUserMessageId?: string }).clientUserMessageId === operationId));
    const request = (await f.requests()).find(item => item.method === 'turn/start' && (item.params as { clientUserMessageId?: string }).clientUserMessageId === operationId)!;
    const params = request.params as { input: Array<{ text: string }>; additionalContext: Record<string, unknown> };
    const prefix = 'file\n\nFiles (paths relative to workspace):\n';
    assert.ok(params.input[0]!.text.startsWith(prefix));
    const [metadata] = JSON.parse(params.input[0]!.text.slice(prefix.length)) as Array<{ path: string; name: string }>;
    assert.equal(metadata!.name, '../untrusted'); assert.ok(!Object.keys(params.additionalContext).some(key => key.startsWith('codex-for-love.file-')));
    assert.equal(isAbsolute(metadata!.path), false);
    assert.match(metadata!.path, /^\.lamplit\/attachments\/\.file-operations\/[a-f0-9]{32}\/p0-[a-f0-9]{64}\.file$/u);
    assert.deepEqual(await readFile(join(f.workspace, metadata!.path)), data);
    assert.deepEqual((await createCodexChatBackend(partner).read()).messages.find(message => message.operationId === operationId)?.files, [ref]);
    await partner.close(); partner = await f.createPartner();
    assert.deepEqual((await createCodexChatBackend(partner).read()).messages.find(message => message.operationId === operationId)?.files, [ref]);
    assert.deepEqual(await readTestFile(partner, ref.attachmentId, owner), data);
  } finally { await partner.close(); await f.close(); }
});

test('previous Human file history retains an original body that resembles the new footer', async () => {
  const f = await fixture(); await f.holdProvider(true); let partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'f', name: 'note.txt', mediaType: '', bytes: Buffer.from('original') }]);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations');
    const directory = join(root, (await readdir(root))[0]!);
    const file = join(directory, (await readdir(directory)).find(name => name.startsWith('p0-'))!);
    const original = `old text\n\nFiles (paths relative to workspace):\n${JSON.stringify([{ name: 'note.txt', path: relative(f.workspace, file) }])}`;
    await partner.submitNativeDelivery({ operationId, text: original, files: staged.files.map(value => value.ref) });
    await eventually(async () => await f.consumed(operationId));
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    try { db.prepare('DELETE FROM delivery_attempts WHERE operation_id=?').run(operationId); } finally { db.close(); }
    const statePath = f.appServer.env.FAKE_SERVER_STATE!;
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { turns: Array<{ items: Array<{ clientId?: string; content: Array<{ type: string; text?: string }> }> }> };
    const item = state.turns.flatMap(turn => turn.items).find(value => value.clientId === operationId)!;
    item.content[0]!.text = original;
    await writeFile(statePath, JSON.stringify(state));
    partner = await f.createPartner();
    const message = (await createCodexChatBackend(partner).read()).messages.find(value => value.operationId === operationId)!;
    assert.equal(message.text, original); assert.equal(message.files?.[0]?.name, 'note.txt');
  } finally { await partner.close(); await f.close(); }
});
