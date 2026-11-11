import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fixture, eventually } from './fixture.ts';
import { partnerPaths } from '../runtime/storage-paths.ts';
import { createWebServer } from './web-server.ts';
import { openChat } from '@lamplit/contracts/client';
import { fixtureImage } from './panels-seed.ts';
import { StickerCatalog, packStickerId } from '../runtime/sticker-catalog.ts';
import { imagePath } from '../runtime/images.ts';
import { stageTestFiles } from './file-fixture.ts';
import { createCodexChatBackend } from '../runtime/chat.ts';
import { Store } from '../runtime/store.ts';

test('legacy Human drafts remain stored but are not exposed as recovery or history', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  const accepted = { operationId: crypto.randomUUID(), text: 'existing conversation' };
  const oldId = crypto.randomUUID();
  try {
    await partner.submitNativeDelivery(accepted);
    await eventually(async () => (await partner.lookupNativeDelivery(accepted.operationId))?.state === 'submitted');
    await partner.close();
    const store = new Store(partnerPaths(f.workspace).database);
    try { await store.admit(oldId, 'old Human draft'); } finally { await store.close(); }
    partner = await f.createPartner();
    const snapshot = await partner.snapshot();
    assert.equal('draft' in snapshot, false);
    assert.equal(snapshot.messages.some(message => message.id === oldId), false);
    const view = await createCodexChatBackend(partner).read();
    assert.equal('recovery' in view, false);
    assert.equal(view.messages.some(message => message.id === oldId), false);
    assert.ok(view.messages.some(message => message.id === accepted.operationId));
    await partner.close();
    const reopened = new Store(partnerPaths(f.workspace).database);
    try { assert.equal((await reopened.inputPayload(oldId))?.input, 'old Human draft'); }
    finally { await reopened.close(); }
  } finally { await partner.close(); await f.close(); }
});

test('native Human file text is confirmed and projects the exact original and attachments', async () => {
  const f = await fixture(); await f.holdProvider(true); let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const original = '前文 😺\n\nFiles (paths relative to workspace):\n[{"name":"fake"}]\n末尾\n';
  const events: Array<{ receipt: { operationId: string; attempt: number; state: string } }> = [];
  const unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') events.push(event); });
  try {
    const staged = await stageTestFiles(partner, sessionId, operationId, [
      { id: 'a', name: '報告\n"一".txt', mediaType: 'text/plain', bytes: Buffer.from('one') },
      { id: 'b', name: '二.bin', mediaType: '', bytes: Buffer.from('two') },
    ]);
    const input = { operationId, text: original, files: staged.files.map(file => file.ref) };
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    assert.ok(events.some(event => event.receipt.operationId === operationId && event.receipt.attempt === 1 && event.receipt.state === 'submitted'));
    const call = (await f.requests()).find(r => r.method === 'turn/start')!;
    const params = call.params as { clientUserMessageId: string; input: Array<{ type: string; text?: string }>; additionalContext?: Record<string, unknown> };
    assert.equal(params.clientUserMessageId, operationId);
    const payload = params.input[0]!.text!;
    assert.ok(payload.startsWith(`${original}\n\nFiles (paths relative to workspace):\n`));
    const entries = JSON.parse(payload.slice(original.length + '\n\nFiles (paths relative to workspace):\n'.length)) as Array<{ name: string; path: string }>;
    assert.deepEqual(entries.map(entry => entry.name), ['報告\n"一".txt', '二.bin']);
    assert.ok(entries.every(entry => /^\.lamplit\/attachments\/\.file-operations\/[a-f0-9]{32}\/p[01]-[a-f0-9]{64}\.file$/u.test(entry.path)));
    assert.ok(!Object.keys(params.additionalContext ?? {}).some(key => key.startsWith('codex-for-love.file-')));
    const view = await createCodexChatBackend(partner).read();
    const message = view.messages.find(item => item.operationId === operationId)!;
    assert.equal(message.text, original); assert.deepEqual(message.files, input.files);
    await partner.close(); await rm(join(f.workspace, entries[0]!.path)); partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(operationId))?.state, 'submitted');
    const reopened = (await createCodexChatBackend(partner).read()).messages.find(item => item.operationId === operationId)!;
    assert.equal(reopened.text, original); assert.equal(reopened.files?.[0]?.availability, 'missing');
    assert.equal(reopened.files?.[1]?.availability, 'available');
  } finally { unsubscribe(); await partner.close(); await f.close(); }
});

test('file-only Human input and an identical repeated file suffix preserve the exact body', async () => {
  const f = await fixture(); let partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId;
  try {
    const id = crypto.randomUUID(), staged = await stageTestFiles(partner, sessionId, id, [{ id: 'f', name: '空.txt', mediaType: '', bytes: Buffer.from('x') }]);
    await partner.submitNativeDelivery({ operationId: id, text: '', files: staged.files.map(file => file.ref) });
    await eventually(async () => (await partner.lookupNativeDelivery(id))?.state === 'submitted');
    let message = (await createCodexChatBackend(partner).read()).messages.find(value => value.operationId === id)!;
    assert.equal(message.text, ''); assert.equal(message.files?.[0]?.name, '空.txt');
    await f.holdProvider(false);
    await eventually(async () => !(await partner.snapshot()).typing);

    const second = crypto.randomUUID(), next = await stageTestFiles(partner, sessionId, second, [{ id: 'g', name: '重复.txt', mediaType: '', bytes: Buffer.from('y') }]);
    const root = join(f.workspace, '.lamplit', 'attachments', '.file-operations');
    const directories = await readdir(root);
    const files = (await Promise.all(directories.map(async dir => (await readdir(join(root, dir))).map(file => join(root, dir, file))))).flat();
    const path = files.find(file => file.includes('a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa'))!;
    const suffix = `\n\nFiles (paths relative to workspace):\n${JSON.stringify([{ name: '重复.txt', path: relative(f.workspace, path) }])}`;
    const text = `原文 😺\r\n${suffix}${suffix}`;
    await partner.submitNativeDelivery({ operationId: second, text, files: next.files.map(file => file.ref) });
    await eventually(async () => (await partner.lookupNativeDelivery(second))?.state === 'submitted');
    message = (await createCodexChatBackend(partner).read()).messages.find(value => value.operationId === second)!;
    assert.equal(message.text, text);
    await partner.close(); partner = await f.createPartner();
    assert.equal((await createCodexChatBackend(partner).read()).messages.find(value => value.operationId === second)?.text, text);
  } finally { await partner.close(); await f.close(); }
});

test('file and image steer remains unknown through tampered history and restart, then confirms exact history', async () => {
  const f = await fixture(); await f.holdProvider(true); let partner = await f.createPartner();
  const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
  const controlPath = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (value: object) => { await writeFile(`${controlPath}.next`, JSON.stringify({ hold: true, ...value })); await rename(`${controlPath}.next`, controlPath); };
  try {
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    const staged = await stageTestFiles(partner, sessionId, operationId, [
      { id: 'a', name: 'first.txt', mediaType: 'text/plain', bytes: Buffer.from('a') },
      { id: 'b', name: 'second.txt', mediaType: 'text/plain', bytes: Buffer.from('b') },
    ]);
    const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
    const images = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'pic', order: 0, name: 'pic.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    const input = { operationId, text: '实时 steer\ntext', files: staged.files.map(file => file.ref), images: images.images.map(image => image.ref) };
    await control({ hiddenHistoryClientIds: [operationId] });
    assert.equal(await partner.submitNativeDelivery(input), null);
    await eventually(async () => (await f.requests()).some(request => request.method === 'turn/steer'));
    const request = (await f.requests()).find(value => value.method === 'turn/steer')!;
    const actual = (request.params as { input: Array<{ type: string; text?: string; path?: string }> }).input;
    assert.equal(actual.length, 2); assert.equal(actual[1]!.type, 'localImage');
    const text = actual[0]!.text!;
    const prefix = `${input.text}\n\nFiles (paths relative to workspace):\n`;
    const entries = JSON.parse(text.slice(prefix.length)) as Array<{ name: string; path: string }>;
    const damaged = [
      [{ type: 'text', text: input.text }, actual[1]!],
      [{ type: 'text', text: text.replace('first.txt', 'wrong.txt') }, actual[1]!],
      [{ type: 'text', text: text.replace('/p0-', '/p1-') }, actual[1]!],
      [{ type: 'text', text: prefix + JSON.stringify([...entries].reverse()) }, actual[1]!],
      [{ type: 'text', text: prefix + JSON.stringify(entries.slice(0, 1)) }, actual[1]!],
      [actual[0]!, { type: 'localImage', path: '/wrong' }],
      [actual[0]!, actual[1]!, { type: 'text', text: 'extra' }],
    ];
    for (const content of damaged) {
      await control({ historyContentOverrides: { [operationId]: content } });
      assert.equal(await partner.lookupNativeDelivery(operationId), null);
    }
    await assert.rejects(partner.lookupNativeDelivery(operationId, async () => false), /Unauthorized/);
    await control({ hiddenHistoryClientIds: [operationId] });
    await partner.close(); partner = await f.createPartner();
    assert.equal(await partner.submitNativeDelivery(input), null);
    assert.equal((await f.requests()).filter(value => value.method === 'turn/steer').length, 1);
    await control({});
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    const message = (await createCodexChatBackend(partner).read()).messages.find(value => value.operationId === operationId)!;
    assert.equal(message.text, input.text); assert.deepEqual(message.files, input.files); assert.equal(message.images?.length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('legacy native history confirms and projects a file-only Human message', async () => {
  const f = await fixture(); f.appServer.env.FAKE_HISTORY_MODE = 'legacy'; let partner = await f.createPartner();
  try {
    const sessionId = (await partner.snapshot()).sessionId, operationId = crypto.randomUUID();
    const staged = await stageTestFiles(partner, sessionId, operationId, [{ id: 'file', name: 'legacy.txt', mediaType: 'text/plain', bytes: Buffer.from('legacy') }]);
    await partner.submitNativeDelivery({ operationId, text: '', files: staged.files.map(file => file.ref) });
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    assert.ok((await f.requests()).some(request => request.method === 'thread/read'));
    await partner.close(); partner = await f.createPartner();
    const message = (await createCodexChatBackend(partner).read()).messages.find(value => value.operationId === operationId)!;
    assert.equal(message.text, ''); assert.equal(message.files?.[0]?.name, 'legacy.txt');
  } finally { await partner.close(); await f.close(); }
});

async function stageDeliveryFile(partner: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['createPartner']>>, sessionId: string, operationId: string) {
  const owner = { ownerId: 'owner', sessionId };
  const manifest = { sessionId, operationId, files: [{ id: 'file', name: 'note.txt', mediaType: 'text/plain', size: 4 }] };
  await partner.fileOperationReserve(manifest, owner, async () => true, () => true);
  await partner.fileOperationReceive(operationId, 'file', (async function* () { yield Buffer.from('test'); })(), owner, async () => true, () => true);
  const completed = await partner.fileOperationComplete(operationId, owner, async () => true, () => true);
  return { operationId, text: 'file retry', files: completed.files.map(file => file.ref) };
}

test('completed file can be explicitly retried once after failure and restart', async () => {
  const f = await fixture(); f.appServer.env.FAKE_NO_ACTIVE_STEER_COUNT = '1'; await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  try {
    const input = await stageDeliveryFile(partner, sessionId, operationId);
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'failed');
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(operationId))?.attempt, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    await assert.rejects(partner.submitNativeDelivery({ ...input, text: 'changed' }), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    await assert.rejects(partner.submitNativeDelivery(input, async () => true, () => false), /Unauthorized/);
    let commits = 0;
    await assert.rejects(partner.submitNativeDelivery(input, async () => true, () => ++commits < 2), /Unauthorized/);
    assert.equal((await partner.lookupNativeDelivery(operationId))?.state, 'failed');
    assert.equal((await partner.lookupNativeDelivery(operationId))?.attempt, 1);
    await Promise.all([partner.submitNativeDelivery(input), partner.submitNativeDelivery(input)]);
    await eventually(async () => await f.consumed(operationId));
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 2);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    const call = (await f.requests()).filter(r => r.method === 'turn/start')[1]!;
    const params = call.params as { clientUserMessageId: string; input: Array<{ text?: string }>; additionalContext: Record<string, unknown> };
    assert.equal(params.clientUserMessageId, operationId);
    assert.ok(params.input[0]?.text?.includes('\n\nFiles (paths relative to workspace):\n'));
    assert.ok(!Object.keys(params.additionalContext).some(key => key.startsWith('codex-for-love.file-')));
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.submitNativeDelivery(input))?.state, 'submitted');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 2);
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database, { readOnly: true });
    try { assert.deepEqual({ ...db.prepare('SELECT attempt,state FROM delivery_attempts WHERE operation_id=?').get(operationId) }, { attempt: 2, state: 'accepted' }); } finally { db.close(); }
  } finally { await partner.close(); await f.close(); }
});

for (const damage of ['missing', 'changed', 'missing binding'] as const) test(`file retry reports ${damage} as a new failed attempt before dispatch`, async () => {
  const f = await fixture(); f.appServer.env.FAKE_NO_ACTIVE_STEER_COUNT = '1'; await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  try {
    const input = await stageDeliveryFile(partner, sessionId, operationId);
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'failed');
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    let row: { id: string; operation_id: string; owner_id: string; session_id: string; position: number; name: string; media_type: string; size: number; path: string };
    try {
      row = db.prepare('SELECT * FROM input_files WHERE operation_id=?').get(operationId) as typeof row;
      if (damage === 'missing') await rm(row.path);
      else if (damage === 'changed') await writeFile(row.path, 'FAIL');
      else db.prepare('DELETE FROM input_files WHERE operation_id=?').run(operationId);
    } finally { db.close(); }
    partner = await f.createPartner();
    const events: Array<{ receipt: { operationId: string; state: string; attempt: number } }> = [];
    const unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') events.push(event); });
    const failure = await partner.submitNativeDelivery(input);
    assert.equal(failure?.state, 'failed'); assert.equal(failure?.attempt, 2);
    assert.equal((await partner.lookupNativeDelivery(operationId))?.attempt, 2);
    assert.ok(events.some(event => event.receipt.operationId === operationId && event.receipt.attempt === 2 && event.receipt.state === 'failed'));
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    unsubscribe(); await partner.close();
    if (damage === 'missing binding') {
      const repair = new DatabaseSync(partnerPaths(f.workspace).database);
      try { repair.prepare('INSERT INTO input_files(id,operation_id,owner_id,session_id,position,name,media_type,size,path) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.operation_id,row.owner_id,row.session_id,row.position,row.name,row.media_type,row.size,row.path); } finally { repair.close(); }
    } else await writeFile(row.path, 'test', { mode: 0o600 });
    partner = await f.createPartner();
    await Promise.all([partner.submitNativeDelivery(input), partner.submitNativeDelivery(input)]);
    await eventually(async () => await f.consumed(operationId));
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 2);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.attempt === 3 && (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
  } finally { await partner.close(); await f.close(); }
});

for (const kind of ['file', 'image'] as const) test(`first ${kind} preparation failure is durable and explicitly retryable after restart`, async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  try {
    const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
    const input = kind === 'file' ? await stageDeliveryFile(partner, sessionId, operationId) : {
      operationId, text: 'image preparation', images: (await partner.uploadImages({ sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] })).images.map(image => image.ref),
    };
    const wrong = kind === 'file' && 'files' in input ? { ...input, files: input.files!.map(file => ({ ...file, attachmentId: '0'.repeat(64) })) } : { ...input, images: 'images' in input ? input.images!.map(image => ({ ...image, attachmentId: '0'.repeat(64) })) : [] };
    await assert.rejects(partner.submitNativeDelivery(wrong), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database, { readOnly: true });
    let path: string;
    try { const row = db.prepare(`SELECT payload FROM ${kind === 'file' ? 'staged_files' : 'staged_images'} WHERE operation_id=?`).get(operationId) as { payload: string }; const staged = JSON.parse(row.payload); path = (kind === 'file' ? staged.files : staged.images)[0].path; } finally { db.close(); }
    const original = await readFile(path); await writeFile(path, 'broken');
    partner = await f.createPartner();
    const events: Array<{ receipt: { attempt: number; state: string } }> = [];
    const unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') events.push(event); });
    const [failed] = await Promise.all([partner.submitNativeDelivery(input), partner.submitNativeDelivery(input)]);
    assert.equal(failed?.state, 'failed'); assert.equal(failed?.attempt, 1);
    assert.equal(events.filter(event => event.receipt.attempt === 1 && event.receipt.state === 'failed').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start' || r.method === 'turn/steer').length, 0);
    unsubscribe(); await partner.close(); await writeFile(path, original);
    partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(operationId))?.attempt, 1);
    await Promise.all([partner.submitNativeDelivery(input), partner.submitNativeDelivery(input)]);
    await eventually(async () => await f.consumed(operationId));
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.attempt === 2 && (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
  } finally { await partner.close(); await f.close(); }
});

for (const revoke of ['guard', 'commit'] as const) test(`preparation failure with revoked ${revoke} stays unknown and is not replayed`, async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  try {
    const staged = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'photo', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    const input = { operationId, text: 'revoked preparation', images: staged.images.map(image => image.ref) };
    const path = imagePath(f.workspace, { id: staged.images[0]!.ref.attachmentId, media_type: 'image/png' });
    const original = await readFile(path); await writeFile(path, 'broken');
    const events: unknown[] = []; const unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') events.push(event); });
    let authorized = true, commits = 0;
    await assert.rejects(partner.submitNativeDelivery(input, async () => authorized, () => {
      commits += 1;
      if (revoke === 'guard' && commits === 1) authorized = false;
      return revoke !== 'commit' || commits < 2;
    }), /Unauthorized/);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    assert.equal(events.length, 0);
    unsubscribe(); await partner.close(); await writeFile(path, original); partner = await f.createPartner();
    assert.equal(await partner.submitNativeDelivery(input), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start' || r.method === 'turn/steer').length, 0);
  } finally { await partner.close(); await f.close(); }
});

test('staged file scope conflict during retry is never reported as a preparation failure', async () => {
  const f = await fixture(); f.appServer.env.FAKE_NO_ACTIVE_STEER_COUNT = '1'; await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  try {
    const input = await stageDeliveryFile(partner, sessionId, operationId);
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'failed');
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    try {
      const row = db.prepare('SELECT payload FROM staged_files WHERE operation_id=?').get(operationId) as { payload: string };
      const staged = JSON.parse(row.payload); staged.files[0].owner_id = 'other-owner';
      db.prepare('UPDATE staged_files SET payload=? WHERE operation_id=?').run(JSON.stringify(staged), operationId);
    } finally { db.close(); }
    partner = await f.createPartner();
    const events: unknown[] = []; const unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') events.push(event); });
    await assert.rejects(partner.submitNativeDelivery(input), /do not belong/i);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    assert.equal(events.length, 0);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    unsubscribe();
  } finally { await partner.close(); await f.close(); }
});

test('durable failure permits one explicit retry after restart and emits attempt results', async () => {
  const f = await fixture(); f.appServer.env.FAKE_NO_ACTIVE_STEER_COUNT = '1'; await f.holdProvider(true);
  let partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'durable retry' };
  const results: Array<{ receipt: { operationId: string; attempt: number; state: string; messageId: string | null; turnId: string | null; error: string | null } }> = [];
  let unsubscribe = () => {};
  try {
    unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') results.push(event); });
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => results.some(event => event.receipt.operationId === input.operationId && event.receipt.state === 'failed'));
    const failed = results.find(event => event.receipt.operationId === input.operationId && event.receipt.state === 'failed');
    assert.deepEqual(failed?.receipt, { operationId: input.operationId, attempt: 1, state: 'failed', messageId: null, turnId: null, error: null });
    unsubscribe(); await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(input.operationId))?.state, 'failed');
    assert.equal((await partner.lookupNativeDelivery(input.operationId))?.attempt, 1);
    unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') results.push(event); });
    await Promise.all([partner.submitNativeDelivery(input), partner.submitNativeDelivery(input)]);
    await eventually(async () => results.some(event => event.receipt.operationId === input.operationId && event.receipt.state === 'submitted' && event.receipt.attempt === 2));
    const accepted = results.find(event => event.receipt.operationId === input.operationId && event.receipt.state === 'submitted')!;
    assert.equal(accepted.receipt.messageId, input.operationId);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 2);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    unsubscribe(); await partner.close(); partner = await f.createPartner();
    const restored = await partner.lookupNativeDelivery(input.operationId);
    assert.equal(restored?.state, 'submitted'); assert.equal(restored?.attempt, 2);
  } finally { unsubscribe(); await partner.close(); await f.close(); }
});

test('legacy shared identity without attempt remains unknown and is never redispatched', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'legacy shared' };
  try {
    const sessionId = (await partner.snapshot()).sessionId;
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    try { db.prepare('INSERT INTO shared_submissions(operation_id,session_id,fingerprint) VALUES(?,?,?)').run(input.operationId, sessionId, createHash('sha256').update(JSON.stringify(input)).digest('hex')); }
    finally { db.close(); }
    partner = await f.createPartner();
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    assert.equal(await partner.submitNativeDelivery(input), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 0);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 0);
  } finally { await partner.close(); await f.close(); }
});

test('result event follows positive history, not a native notification alone', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'positive history event' };
  const results: Array<{ receipt: { operationId: string; attempt: number; state: string } }> = [];
  const unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') results.push(event); });
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  try {
    await writeFile(path, JSON.stringify({ hold: true, hiddenHistoryClientIds: [input.operationId] }));
    await partner.submitNativeDelivery(input);
    await eventually(async () => await f.consumed(input.operationId));
    await partner.snapshot();
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    assert.equal(results.length, 0);
    await f.holdProvider(false);
    await eventually(async () => results.some(event => event.receipt.operationId === input.operationId && event.receipt.state === 'submitted' && event.receipt.attempt === 1));
    assert.equal(results.filter(event => event.receipt.operationId === input.operationId).length, 1);
  } finally { unsubscribe(); await partner.close(); await f.close(); }
});

test('authorization revoked at accepted commit rolls back without a result event', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'accepted guard' };
  const results: unknown[] = [];
  let unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') results.push(event); });
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  try {
    await writeFile(path, JSON.stringify({ hold: true, hiddenHistoryClientIds: [input.operationId] }));
    await partner.submitNativeDelivery(input);
    await eventually(async () => await f.consumed(input.operationId));
    await eventually(async () => (await f.requests()).some(r => r.method === 'thread/items/list'));
    await partner.snapshot();
    await new Promise(resolve => setTimeout(resolve, 50));
    await writeFile(path, JSON.stringify({ hold: true }));
    await assert.rejects(partner.lookupNativeDelivery(input.operationId, async () => true, () => false), /Unauthorized/);
    assert.equal(results.length, 0);
    unsubscribe(); await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database, { readOnly: true });
    try {
      const row = db.prepare('SELECT attempt,state FROM delivery_attempts WHERE operation_id=?').get(input.operationId);
      assert.deepEqual({ ...row }, { attempt: 1, state: 'unknown' });
    } finally { db.close(); }
    partner = await f.createPartner();
    unsubscribe = partner.subscribeChat(event => { if (event.type === 'delivery') results.push(event); });
    const receipt = await partner.lookupNativeDelivery(input.operationId);
    assert.equal(receipt?.state, 'submitted'); assert.equal(receipt?.attempt, 1);
    assert.equal(results.length, 1);
  } finally { unsubscribe(); await partner.close(); await f.close(); }
});

test('image delivery is confirmed only by its matching native history item', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  try {
    const staged = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'one', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    const input = { operationId, text: 'picture', images: staged.images.map(image => image.ref) };
    await partner.submitNativeDelivery(input);
    await eventually(async () => await f.consumed(operationId));
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted', 2000);
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(operationId))?.state, 'submitted');
  } finally { await partner.close(); await f.close(); }
});

test('image history requires exact order, paths and complete content', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (content: object[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, historyContentOverrides: { [operationId]: content } }));
    await rename(`${path}.next`, path);
  };
  try {
    const images = ['one', 'two'].map((id, order) => ({ id, order, name: `${id}.png`, mediaType: 'image/png' as const, original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }));
    await assert.rejects(partner.uploadImages({ sessionId: 'other-session', operationId, images }), /session/i);
    const staged = await partner.uploadImages({ sessionId, operationId, images });
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, hiddenHistoryClientIds: [operationId] }));
    await rename(`${path}.next`, path);
    await partner.submitNativeDelivery({ operationId, text: 'two pictures', images: staged.images.map(image => image.ref) });
    await eventually(async () => await f.consumed(operationId));
    const call = (await f.requests()).find(r => r.method === 'turn/start')!;
    const actual = (call.params as { input: Array<{ type: string; path?: string; text?: string }> }).input;
    assert.equal(actual.length, 3);
    await control([actual[0]!, actual[2]!, actual[1]!]);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await control([actual[0]!, { type: 'localImage', path: '/incorrect' }, actual[2]!]);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await control([actual[0]!, actual[2]!]);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await control([actual[0]!, actual[1]!, actual[2]!, { type: 'text', text: 'unexpected' }]);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await control(actual);
    assert.equal((await partner.lookupNativeDelivery(operationId))?.state, 'submitted');
  } finally { await partner.close(); await f.close(); }
});

test('image lookup cannot use another session staging', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  try {
    const staged = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'one', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(path, JSON.stringify({ hold: true, hiddenHistoryClientIds: [operationId] }));
    await partner.submitNativeDelivery({ operationId, text: 'scope', images: staged.images.map(image => image.ref) });
    await eventually(async () => await f.consumed(operationId));
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    try { db.prepare('UPDATE staged_images SET session_id=? WHERE operation_id=?').run('other-session', operationId); } finally { db.close(); }
    partner = await f.createPartner();
    await writeFile(path, JSON.stringify({ hold: true }));
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
  } finally { await partner.close(); await f.close(); }
});

test('native image history with a missing path cannot confirm delivery', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  try {
    const staged = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'one', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    await writeFile(path, JSON.stringify({ hold: true, hiddenHistoryClientIds: [operationId] }));
    await partner.submitNativeDelivery({ operationId, text: 'photo', images: staged.images.map(image => image.ref) });
    await eventually(async () => await f.consumed(operationId));
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, historyContentOverrides: { [operationId]: [{ type: 'text', text: 'photo', text_elements: [] }, { type: 'localImage' }] } }));
    await rename(`${path}.next`, path);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
  } finally { await partner.close(); await f.close(); }
});

test('unknown image delivery remains unknown after restart and never replays', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (hidden: boolean) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, hiddenHistoryClientIds: hidden ? [operationId] : [] }));
    await rename(`${path}.next`, path);
  };
  try {
    const staged = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'one', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    const input = { operationId, text: '', images: staged.images.map(image => image.ref) };
    await control(true);
    assert.equal(await partner.submitNativeDelivery(input), null);
    await eventually(async () => await f.consumed(operationId));
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await partner.close(); partner = await f.createPartner();
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    assert.equal(await partner.submitNativeDelivery(input), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    await control(false);
    assert.equal((await partner.lookupNativeDelivery(operationId))?.state, 'submitted');
  } finally { await partner.close(); await f.close(); }
});

test('explicit image retry after definite failure dispatches once', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1'; await f.holdProvider(true);
  const partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods })); await rename(`${path}.next`, path);
  };
  try {
    const staged = await partner.uploadImages({ sessionId, operationId, images: [{ id: 'one', order: 0, name: 'photo.png', mediaType: 'image/png', original: fixtureImage.toString('base64'), preview: jpeg, model: jpeg }] });
    const input = { operationId, text: 'image retry', images: staged.images.map(image => image.ref) };
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'failed');
    await control(['turn/steer']);
    await Promise.all([partner.submitNativeDelivery(input), partner.submitNativeDelivery(input)]);
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/steer').length === 2, 2000);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await partner.submitNativeDelivery(input);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 2);
    await control([]);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'submitted');
  } finally { await control([]); await partner.close(); await f.close(); }
});

test('sticker retry and history require its exact model frame', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1'; await f.holdProvider(true);
  const catalog = await StickerCatalog.open(f.workspace);
  await catalog.importPack({ id: 'cats', name: 'cats', description: '', stickers: [{ id: 'one', file: 'one.png', name: 'cat', tags: [] }] }, new Map([['one.png', { bytes: fixtureImage, mediaType: 'image/png' }]]));
  const sticker = (await catalog.get(packStickerId('cats', 'one')))!;
  let partner = await f.createPartner();
  const operationId = crypto.randomUUID(), sessionId = (await partner.snapshot()).sessionId;
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (value: object) => { await writeFile(`${path}.next`, JSON.stringify({ hold: true, ...value })); await rename(`${path}.next`, path); };
  try {
    const staged = await partner.stickerBackend(async () => true, () => true).stage({ sessionId, operationId, sticker: { id: sticker.id, version: sticker.version } }, async () => true);
    const input = { operationId, text: '', images: [staged.image] };
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(operationId))?.state === 'failed');
    await control({ holdMethods: ['turn/steer'], hiddenHistoryClientIds: [operationId] });
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/steer').length === 2);
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await partner.submitNativeDelivery(input);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 2);
    await control({ hiddenHistoryClientIds: [operationId] });
    await eventually(async () => await f.consumed(operationId));
    const calls = (await f.requests()).filter(r => r.method === 'turn/steer');
    const actual = (calls[1]!.params as { input: Array<{ type: string; path?: string }> }).input;
    assert.equal(actual.length, 1); assert.match(actual[0]!.path!, /\.model\.jpg$/u);
    await control({ historyContentOverrides: { [operationId]: [{ type: 'localImage', path: imagePath(f.workspace, { id: staged.image.attachmentId, media_type: 'image/png' }) }] } });
    assert.equal(await partner.lookupNativeDelivery(operationId), null);
    await control({ historyContentOverrides: { [operationId]: actual } });
    assert.equal((await partner.lookupNativeDelivery(operationId))?.state, 'submitted');
    await partner.close(); partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(operationId))?.state, 'submitted');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 2);
  } finally { await control({}); await partner.close(); catalog.close(); await f.close(); }
});

test('explicit concurrent retry after definite failure dispatches exactly once', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1'; await f.holdProvider(true);
  const partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const input = { operationId: crypto.randomUUID(), text: 'try again' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods }));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'failed');
    await assert.rejects(partner.submitNativeDelivery({ ...input, text: 'changed' }), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    await assert.rejects(partner.submitNativeDelivery(input, async () => true, () => false), /Unauthorized/);
    assert.equal((await partner.lookupNativeDelivery(input.operationId))?.state, 'failed');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    await control(['turn/steer']);
    await Promise.all([partner.submitNativeDelivery(input), partner.submitNativeDelivery(input)]);
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/steer').length === 2, 2000);
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    await partner.submitNativeDelivery(input);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 2);
    await control([]);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'submitted');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 2);
  } finally { await control([]); await partner.close(); await f.close(); }
});

test('a delayed lookup from an older attempt cannot publish a newer result', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1'; await f.holdProvider(true);
  const partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const input = { operationId: crypto.randomUUID(), text: 'new attempt' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods }));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await control(['turn/steer']);
    assert.equal(await partner.submitNativeDelivery(input), null);
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/steer').length === 1);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const oldLookup = partner.lookupNativeDelivery(input.operationId, async () => { entered(); await barrier; return true; });
    await started;
    await control([]);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'failed');
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/steer').length === 2);
    release();
    assert.equal(await oldLookup, null);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'submitted');
  } finally { await control([]); await partner.close(); await f.close(); }
});

test('unknown retry is not dispatched again after restart', async () => {
  const f = await fixture();
  f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1';
  f.appServer.env.FAKE_DROP_RESPONSE_METHOD = 'turn/steer';
  f.appServer.requestTimeoutMs = 300;
  await f.holdProvider(true);
  let partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const input = { operationId: crypto.randomUUID(), text: 'unknown retry' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async () => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, hiddenHistoryClientIds: [input.operationId] }));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await control();
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'failed');
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await f.requests()).filter(r => r.method === 'turn/steer').length === 2);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    await partner.close();
    partner = await f.createPartner();
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    assert.equal(await partner.submitNativeDelivery(input), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 2);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('a process crash after an unknown retry does not cause replay', async () => {
  const f = await fixture();
  f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1';
  f.appServer.env.FAKE_DROP_RESPONSE_METHOD = 'turn/steer';
  f.appServer.requestTimeoutMs = 300;
  const input = { operationId: crypto.randomUUID(), text: 'crashed unknown retry' };
  await writeFile(f.appServer.env.FAKE_SERVER_CONTROL!, JSON.stringify({ hold: true, hiddenHistoryClientIds: [input.operationId] }));
  const script = `
    import { createPartner } from ${JSON.stringify(new URL('../runtime/partner.ts', import.meta.url).href)};
    import { eventually } from ${JSON.stringify(new URL('./fixture.ts', import.meta.url).href)};
    const { config, appServer, input } = JSON.parse(process.env.CFL_CRASH_TEST);
    const partner = await createPartner(config, {}, { appServer });
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'failed');
    await partner.submitNativeDelivery(input);
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await partner.lookupNativeDelivery(input.operationId) !== null) throw Error('expected unknown');
    process.send('ready');
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, CFL_CRASH_TEST: JSON.stringify({ config: f.config, appServer: f.appServer, input }) },
  });
  let stderr = '';
  child.stderr!.on('data', data => { stderr += String(data); });
  const exit = once(child, 'exit');
  let groupAlive = true;
  try {
    const ready = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(15_000) }), exit.then(() => { throw new Error(`crash fixture exited: ${stderr}`); })]);
    assert.equal(ready[0], 'ready');
    child.kill('SIGKILL');
    await exit;
    process.kill(-child.pid!, 'SIGTERM');
    await eventually(async () => (await readFile(f.appServer.env.FAKE_SERVER_LIFECYCLE!, 'utf8')).startsWith('exited:'));
    groupAlive = false;
    const db = new DatabaseSync(partnerPaths(f.workspace).database, { readOnly: true });
    try {
      const row = db.prepare('SELECT attempt,state FROM delivery_attempts WHERE operation_id=?').get(input.operationId);
      assert.deepEqual({ ...row }, { attempt: 2, state: 'unknown' });
    } finally { db.close(); }
    const partner = await f.createPartner();
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    assert.equal(await partner.submitNativeDelivery(input), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 2);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
  } finally {
    if (groupAlive) try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already stopped */ }
    await f.close();
  }
});

test('real Partner steers immediately and requires matching durable history', async () => {
  const f = await fixture();
  await f.holdProvider(true);
  let partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'first message' };
  const second = { operationId: crypto.randomUUID(), text: 'second message' };
  const control = async (value: object) => {
    const path = f.appServer.env.FAKE_SERVER_CONTROL!;
    await writeFile(`${path}.next`, JSON.stringify(value));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await control({ hold: true, hiddenHistoryClientIds: [second.operationId] });
    assert.equal(await partner.submitNativeDelivery(second), null);
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/steer' && (r.params as { clientUserMessageId?: string }).clientUserMessageId === second.operationId));
    assert.equal(await partner.lookupNativeDelivery(second.operationId), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    await control({ hold: true, historyContentOverrides: { [second.operationId]: [{ type: 'text', text: 'different' }] } });
    assert.equal(await partner.lookupNativeDelivery(second.operationId), null);
    await control({ hold: true, historyContentOverrides: { [second.operationId]: [{ type: 'text', text: second.text }, { type: 'image', url: 'fixture' }] } });
    assert.equal(await partner.lookupNativeDelivery(second.operationId), null);
    await control({ hold: true });
    assert.equal((await partner.lookupNativeDelivery(second.operationId))?.state, 'submitted');
    await partner.submitNativeDelivery(second);
    await assert.rejects(partner.submitNativeDelivery({ ...second, text: 'different' }), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    await partner.close();
    partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(second.operationId))?.state, 'submitted');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('an unknown admitted input is not replayed after restart', async () => {
  const f = await fixture(); await f.holdProvider(true);
  let partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const second = { operationId: crypto.randomUUID(), text: 'uncertain steer' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (hidden: boolean) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, hiddenHistoryClientIds: hidden ? [second.operationId] : [] }));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await control(true);
    assert.equal(await partner.submitNativeDelivery(second), null);
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/steer'));
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    try {
      assert.equal(db.prepare('SELECT input FROM pending_inputs WHERE message_id=?').get(second.operationId), undefined);
      assert.deepEqual({ ...db.prepare('SELECT attempt,state FROM delivery_attempts WHERE operation_id=?').get(second.operationId) }, { attempt: 1, state: 'unknown' });
      assert.ok(db.prepare('SELECT fingerprint FROM shared_submissions WHERE operation_id=?').get(second.operationId));
    } finally { db.close(); }
    partner = await f.createPartner();
    assert.equal(await partner.lookupNativeDelivery(second.operationId), null);
    assert.equal(await partner.submitNativeDelivery(second), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    await control(false);
    assert.equal((await partner.lookupNativeDelivery(second.operationId))?.state, 'submitted');
  } finally { await partner.close(); await f.close(); }
});

test('commit authorization failure rolls back admission and never dispatches', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'revoked at commit' };
  try {
    await assert.rejects(partner.submitNativeDelivery(input, async () => true, () => false), /Unauthorized/);
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start' || r.method === 'turn/steer').length, 0);
  } finally { await partner.close(); await f.close(); }
});

test('submit returns unknown without waiting for a held history read', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const input = { operationId: crypto.randomUUID(), text: 'history delayed' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods }));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await control(['turn/steer', 'thread/items/list']);
    const result = await Promise.race([
      partner.submitNativeDelivery(input),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500)),
    ]);
    assert.equal(result, null);
  } finally { await control([]); await partner.close(); await f.close(); }
});

test('published socket pushes a failure receipt even when the view is unchanged', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1'; await f.holdProvider(true);
  const partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const input = { operationId: crypto.randomUUID(), text: 'failure only' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods }));
    await rename(`${path}.next`, path);
  };
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: unknown;
  let updates = 0;
  const receipts: Array<{ operationId: string; attempt: number; state: string }> = [];
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), next => { view = next; updates++; }, () => {}, receipt => receipts.push(receipt));
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => !!view && (await partner.snapshot()).typing);
    await control(['turn/steer']);
    await assert.rejects(client.submit(input));
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/steer'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = JSON.stringify(view), beforeUpdates = updates;
    await control([]);
    await eventually(async () => receipts.some(receipt => receipt.operationId === input.operationId && receipt.attempt === 1 && receipt.state === 'failed'));
    assert.equal((await client.lookup(input.operationId))?.state, 'failed');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(JSON.stringify(view), before);
    assert.equal(updates, beforeUpdates);
    await client.submit(input).catch(() => {});
    await eventually(async () => receipts.some(receipt => receipt.operationId === input.operationId && receipt.attempt === 2 && receipt.state === 'submitted'));
    assert.equal((await client.lookup(input.operationId))?.attempt, 2);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/steer').length, 2);
  } finally {
    client.close();
    await control([]);
    await app.close();
    await partner.close(); await f.close();
  }
});

test('published socket does not deliver an asynchronous receipt after owner revocation', async () => {
  const f = await fixture(); f.appServer.env.FAKE_STEER_MISMATCH_COUNT = '1'; await f.holdProvider(true);
  const partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'revoke while pending' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods }));
    await rename(`${path}.next`, path);
  };
  let allowed = true, offline = false;
  const app = createWebServer(partner, join(f.directory, 'assets'), { authorize: async () => allowed });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const receipts: string[] = [];
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), () => {}, () => { offline = true; }, receipt => receipts.push(receipt.operationId));
  try {
    await partner.submitNativeDelivery({ operationId: crypto.randomUUID(), text: 'active' });
    await eventually(async () => (await partner.snapshot()).typing);
    await control(['turn/steer']);
    await assert.rejects(client.submit(input));
    await eventually(async () => (await f.requests()).some(request => request.method === 'turn/steer'));
    allowed = false;
    await control([]);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'failed');
    await eventually(async () => offline);
    assert.equal(receipts.includes(input.operationId), false);
  } finally {
    client.close(); await control([]); await app.close(); await partner.close(); await f.close();
  }
});

test('published socket steers a file and projects its original text and attachment', async () => {
  const f = await fixture(); await f.holdProvider(true); const partner = await f.createPartner();
  const app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let view: import('@lamplit/contracts').ChatView | undefined;
  const receipts: Array<{ operationId: string; attempt: number; state: string }> = [];
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/chat/socket`), value => { view = value; }, () => {}, receipt => receipts.push(receipt));
  try {
    await client.submit({ operationId: crypto.randomUUID(), text: 'active' }).catch(() => {});
    await eventually(async () => !!view?.activeTurnId);
    const operationId = crypto.randomUUID(), text = '文件 😺\n\nFiles (paths relative to workspace):\nnot a footer';
    const staged = await stageTestFiles(partner, view!.sessionId, operationId, [{ id: 'f', name: '文件.txt', mediaType: '', bytes: Buffer.from('fixture') }]);
    await client.submit({ operationId, text, files: staged.files.map(file => file.ref) }).catch(() => {});
    await eventually(async () => receipts.some(receipt => receipt.operationId === operationId && receipt.attempt === 1 && receipt.state === 'submitted'));
    await eventually(async () => view?.messages.some(message => message.operationId === operationId) === true);
    const message = view!.messages.find(value => value.operationId === operationId)!;
    assert.equal(message.text, text);
    assert.deepEqual(message.files, staged.files.map(file => file.ref));
    assert.equal((await client.lookup(operationId))?.attempt, 1);
    assert.equal((await f.requests()).filter(request => request.method === 'turn/steer').length, 1);
  } finally { client.close(); await app.close(); await partner.close(); await f.close(); }
});

test('lost steer response stays unknown without replay until history confirms it', async () => {
  const f = await fixture();
  f.appServer.env.FAKE_DROP_RESPONSE_METHOD = 'turn/steer';
  f.appServer.requestTimeoutMs = 300;
  await f.holdProvider(true);
  const partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const second = { operationId: crypto.randomUUID(), text: 'response lost' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (hidden: boolean) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, hiddenHistoryClientIds: hidden ? [second.operationId] : [] }));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await control(true);
    assert.equal(await partner.submitNativeDelivery(second), null);
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/steer'));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await partner.lookupNativeDelivery(second.operationId), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    await control(false);
    assert.equal((await partner.lookupNativeDelivery(second.operationId))?.state, 'submitted');
  } finally { await partner.close(); await f.close(); }
});

test('new human input held before compact start fails without entering a merged replay', async () => {
  const f = await fixture(); await f.holdCompaction(true, true);
  const partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'during compaction' };
  try {
    await partner.compact();
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'failed');
    await f.holdCompaction(false);
    await eventually(async () => (await partner.snapshot()).lifecycle.latest?.status === 'complete');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start' || r.method === 'turn/steer').length, 0);
  } finally { await f.holdCompaction(false); await partner.close(); await f.close(); }
});

test('legacy history uses thread/read for a positive matching item', async () => {
  const f = await fixture(); f.appServer.env.FAKE_HISTORY_MODE = 'legacy';
  const partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'legacy source' };
  try {
    await partner.submitNativeDelivery(input);
    await eventually(async () => (await partner.lookupNativeDelivery(input.operationId))?.state === 'submitted');
    assert.ok((await f.requests()).some(r => r.method === 'thread/read'));
  } finally { await partner.close(); await f.close(); }
});

test('definite native rejection remains failed after restart without automatic fallback', async () => {
  const f = await fixture(); f.appServer.env.FAKE_NO_ACTIVE_STEER_COUNT = '1';
  await f.holdProvider(true);
  let partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active' };
  const second = { operationId: crypto.randomUUID(), text: 'rejected steer' };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await partner.submitNativeDelivery(second);
    await eventually(async () => (await partner.lookupNativeDelivery(second.operationId))?.state === 'failed');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    await partner.close();
    const db = new DatabaseSync(partnerPaths(f.workspace).database);
    try {
      assert.equal(db.prepare('SELECT input FROM pending_inputs WHERE message_id=?').get(second.operationId), undefined);
      assert.deepEqual({ ...db.prepare('SELECT attempt,state FROM delivery_attempts WHERE operation_id=?').get(second.operationId) }, { attempt: 1, state: 'failed' });
      assert.ok(db.prepare('SELECT fingerprint FROM shared_submissions WHERE operation_id=?').get(second.operationId));
    } finally { db.close(); }
    partner = await f.createPartner();
    assert.equal((await partner.lookupNativeDelivery(second.operationId))?.state, 'failed');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
  } finally { await partner.close(); await f.close(); }
});

test('stop while steer is in flight remains unknown until the late explicit rejection', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const first = { operationId: crypto.randomUUID(), text: 'active turn' };
  const second = { operationId: crypto.randomUUID(), text: 'held steer' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods }));
    await rename(`${path}.next`, path);
  };
  try {
    await partner.submitNativeDelivery(first);
    await eventually(async () => (await partner.snapshot()).typing);
    await control(['turn/steer']);
    await Promise.all([partner.submitNativeDelivery(second), partner.submitNativeDelivery(second)]);
    await eventually(async () => (await f.requests()).some(r => r.method === 'turn/steer'));
    await partner.cancel((await partner.snapshot()).cancellable[0]!);
    assert.equal(await partner.lookupNativeDelivery(second.operationId), null);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
    await control([]);
    await eventually(async () => (await partner.lookupNativeDelivery(second.operationId))?.state === 'failed');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/steer').length, 1);
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
  } finally { await control([]); await partner.close(); await f.close(); }
});

test('delivery lookup checks authorization again after reading identity', async () => {
  const f = await fixture(); const partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'authorization' };
  try {
    await partner.submitNativeDelivery(input);
    let allowed = true;
    const authorize = async () => { const result = allowed; queueMicrotask(() => { allowed = false; }); return result; };
    await assert.rejects(partner.lookupNativeDelivery(input.operationId, authorize), /Unauthorized/);
  } finally { await partner.close(); await f.close(); }
});

test('delivery lookup checks authorization after delayed history', async () => {
  const f = await fixture(); await f.holdProvider(true);
  const partner = await f.createPartner();
  const input = { operationId: crypto.randomUUID(), text: 'authorization after history' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[]) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods, hiddenHistoryClientIds: [input.operationId] }));
    await rename(`${path}.next`, path);
  };
  try {
    await control([]);
    await partner.submitNativeDelivery(input);
    await eventually(() => f.consumed(input.operationId));
    await control(['thread/items/list']);
    const count = (await f.requests()).filter(r => r.method === 'thread/items/list').length;
    let allowed = true;
    const pending = partner.lookupNativeDelivery(input.operationId, async () => allowed);
    await eventually(async () => (await f.requests()).filter(r => r.method === 'thread/items/list').length > count);
    allowed = false;
    await control([]);
    await assert.rejects(pending, /Unauthorized/);
  } finally { await control([]); await partner.close(); await f.close(); }
});

for (const [history, method, fault] of [
  ['paginated error', 'thread/items/list', 'historyItemsError'],
  ['paginated incomplete page', 'thread/items/list', 'historyItemsEmptyPage'],
  ['paginated repeated cursor', 'thread/items/list', 'historyItemsRepeatedCursor'],
  ['legacy wrong thread', 'thread/read', 'historyReadWrongThread'],
] as const) for (const revoked of [false, true]) test(`delivery lookup ${history} ${revoked ? 'rejects revoked authorization' : 'remains unknown while authorized'}`, async () => {
  const f = await fixture();
  if (method === 'thread/read') f.appServer.env.FAKE_HISTORY_MODE = 'legacy';
  const input = { operationId: crypto.randomUUID(), text: 'history failure authorization' };
  const path = f.appServer.env.FAKE_SERVER_CONTROL!;
  const control = async (holdMethods: string[], failed = false) => {
    await writeFile(`${path}.next`, JSON.stringify({ hold: true, holdMethods, hiddenHistoryClientIds: [input.operationId], ...(failed ? { [fault]: true } : {}) }));
    await rename(`${path}.next`, path);
  };
  await control([]);
  const partner = await f.createPartner();
  try {
    await partner.submitNativeDelivery(input);
    await eventually(() => f.consumed(input.operationId));
    assert.equal(await partner.lookupNativeDelivery(input.operationId), null);
    await control([method]);
    const count = (await f.requests()).filter(request => request.method === method).length;
    let allowed = true;
    const pending = partner.lookupNativeDelivery(input.operationId, async () => allowed);
    await eventually(async () => (await f.requests()).filter(request => request.method === method).length > count);
    allowed = !revoked;
    const result = revoked ? assert.rejects(pending, /Unauthorized/) : assert.doesNotReject(async () => assert.equal(await pending, null));
    await control([], true);
    await result;
  } finally { await control([]); await partner.close(); await f.close(); }
});
