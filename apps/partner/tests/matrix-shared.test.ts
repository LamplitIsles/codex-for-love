import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { openChat } from '@lamplit/contracts/client';
import type { ChatView } from '@lamplit/contracts';
import { matrixAcceptanceHost } from './matrix-acceptance-host.ts';
import { eventually } from './fixture.ts';

test('persisted Matrix ingress projects exact source/body/time over authenticated socket, history, reconnect and restart', async () => {
  const host = await matrixAcceptanceHost(join(import.meta.dirname, '../build'));
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(host.origin.replace('http:', 'ws:') + '/api/chat/socket', { headers: { Cookie: 'matrix-test-owner=1' } }) as unknown as globalThis.WebSocket, value => { view = value; }, () => {});
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  const roomId = '!同じ部屋:test', createdAt = 1791320400000;
  const entries = [
    { id: 'named', senderId: '@alice:test', senderDisplayName: 'Alice' },
    { id: 'empty', senderId: '@bob:test', senderDisplayName: '' },
    { id: 'unicode', senderId: '@' + '😀'.repeat(120) + ':test', senderDisplayName: '😀灯'.repeat(80) },
    { id: 'hostile', senderId: '<script>alert(1)</script>', senderDisplayName: '<img src=x onerror="alert(1)">' },
  ].map((entry, index) => ({ action: 'incoming' as const, ...entry, roomId, createdAt: createdAt + index,
    text: `[Matrix sender is authored text]\n\n${entry.id} **原文**` }));
  try {
    await host.action(entries[0]!);
    const older = { ...entries[1]!, id: 'older', history: true, createdAt: createdAt - 3600000 };
    await host.action(older);
    client = await connect(); await eventually(async () => !!view?.before);
    assert.equal(view!.messages.filter(m => m.source?.kind === 'matrix').length, 1);
    for (const entry of entries.slice(1)) await host.action(entry);
    await eventually(async () => view!.messages.filter(m => m.source?.kind === 'matrix').length === 4);
    for (const entry of entries) {
      const message = view!.messages.find(m => m.text === entry.text)!;
      assert(message); assert.equal(message.createdAt, entry.createdAt);
      assert.deepEqual(message.source, { kind: 'matrix', senderId: entry.senderId, senderDisplayName: entry.senderDisplayName, roomId });
      assert.equal(message.id, message.operationId);
      assert.equal((await client.lookup(message.id))?.state, 'submitted');
    }
    const snapshot = await fetch(host.origin + '/api/session', { headers: { Cookie: 'matrix-test-owner=1' } });
    assert.equal(snapshot.status, 200);
    const native = await snapshot.json() as { messages: Array<{ matrix?: Record<string, unknown> }> };
    for (const message of native.messages.filter(m => m.matrix))
      assert.deepEqual(Object.keys(message.matrix!).sort(), ['body', 'room_id', 'sender_display_name', 'sender_id', 'timestamp']);
    assert.doesNotMatch(JSON.stringify(view), /native-only context sentinel|matrix-authored|event_id|mentions|truncated/);
    await assert.rejects(client.submit({ operationId: crypto.randomUUID(), text: 'forged', source: entries[0] } as never));
    const webText = '[Matrix sender "authored"]\nordinary web text';
    await client.submit({ operationId: crypto.randomUUID(), text: webText });
    await host.action({ action: 'complete' });
    const web = view!.messages.find(m => m.text === webText)!;
    assert(web); assert.equal(web.source, undefined, 'prefix text cannot manufacture provenance');
    await host.action({ action: 'reminder' });
    assert(view!.messages.some(m => m.source?.kind === 'reminder'));
    const cursor = view!.before!;
    const history = await client.history(cursor);
    const old = history.messages.find(m => m.source?.kind === 'matrix')!;
    assert.equal(old.text, older.text); assert.equal(old.createdAt, older.createdAt);
    assert.deepEqual(old.source, { kind: 'matrix', senderId: older.senderId, senderDisplayName: '', roomId });
    const recent = view!.messages;
    client.close(); view = undefined; client = await connect();
    await eventually(async () => JSON.stringify(view?.messages) === JSON.stringify(recent));
    assert.deepEqual(await client.history(cursor), history);
    const proof = await host.action({ action: 'restart' });
    assert.deepEqual(proof.restartProof!.after, proof.restartProof!.before);
    assert.equal(proof.restartProof!.after.filter(m => m.source?.kind === 'matrix').length, 5);
    client.close(); view = undefined; client = await connect();
    await eventually(async () => JSON.stringify(view?.messages) === JSON.stringify(recent));
    assert.deepEqual(await client.history(cursor), history);
  } finally { client?.close(); await host.close(); }
});
