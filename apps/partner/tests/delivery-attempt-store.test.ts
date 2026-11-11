import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Store } from '../runtime/store.ts';

test('delivery attempts persist their identity without storing a recoverable draft', async () => {
  const store = new Store(':memory:');
  const input = { operationId: 'message', text: 'private draft' };
  try {
    await store.admit(input.operationId, input.text, [], { sessionId: 'session', input }, undefined, undefined, undefined, true);
    assert.deepEqual(await store.deliveryAttempt('message', 'session'), { attempt: 1, state: 'unknown' });
    assert.deepEqual(await store.pendingMessages(), []);
    await assert.rejects(store.deliveryAttempt('message', 'other-session'), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    assert.equal(await store.transitionDeliveryAttempt('message', 'session', 1, 'retry'), undefined);
    assert.deepEqual(await store.transitionDeliveryAttempt('message', 'session', 1, 'failed'), { attempt: 1, state: 'failed' });
    await assert.rejects(store.transitionDeliveryAttempt('message', 'session', 1, 'retry', () => { throw new Error('revoked'); }), /revoked/);
    assert.deepEqual(await store.deliveryAttempt('message', 'session'), { attempt: 1, state: 'failed' });
    assert.deepEqual(await store.transitionDeliveryAttempt('message', 'session', 1, 'retry'), { attempt: 2, state: 'unknown' });
    assert.equal(await store.transitionDeliveryAttempt('message', 'session', 1, 'failed'), undefined);
    assert.deepEqual(await store.transitionDeliveryAttempt('message', 'session', 2, 'accepted'), { attempt: 2, state: 'accepted' });
    assert.equal(await store.transitionDeliveryAttempt('message', 'session', 2, 'failed'), undefined);
    assert.equal(await store.transitionDeliveryAttempt('message', 'session', 2, 'retry'), undefined);
  } finally {
    await store.close();
  }
});

test('existing shared identities are not silently assigned delivery attempts', async () => {
  const store = new Store(':memory:');
  const input = { operationId: 'old', text: 'existing' };
  try {
    await store.admit(input.operationId, input.text, [], { sessionId: 'session', input });
    await store.admit(input.operationId, input.text, [], { sessionId: 'session', input }, undefined, undefined, undefined, true);
    assert.equal(await store.deliveryAttempt('old', 'session'), undefined);
  } finally {
    await store.close();
  }
});

test('identity can be reserved before preparation without authorizing a replay', async () => {
  const store = new Store(':memory:');
  const input = { operationId: 'new', text: 'local preparation may fail' };
  try {
    await assert.rejects(store.reserveNativeDelivery(input, 'session', 'owner', undefined, () => { throw new Error('revoked'); }), /revoked/);
    assert.equal(await store.deliveryAttempt('new', 'session'), undefined);
    assert.deepEqual(await store.reserveNativeDelivery(input, 'session', 'owner'), { created: true, delivery: { attempt: 1, state: 'unknown' } });
    assert.deepEqual(await store.reserveNativeDelivery(input, 'session', 'owner'), { created: false, delivery: { attempt: 1, state: 'unknown' } });
    await assert.rejects(store.reserveNativeDelivery({ ...input, text: 'changed' }, 'session', 'owner'), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    await assert.rejects(store.reserveNativeDelivery(input, 'other-session', 'owner'), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    assert.deepEqual(await store.transitionDeliveryAttempt('new', 'session', 1, 'failed'), { attempt: 1, state: 'failed' });
    assert.deepEqual(await store.transitionDeliveryAttempt('new', 'session', 1, 'retry'), { attempt: 2, state: 'unknown' });
    await store.admit(input.operationId, input.text, [], { sessionId: 'session', input }, undefined, undefined, undefined, true);
    assert.deepEqual(await store.deliveryAttempt('new', 'session'), { attempt: 2, state: 'unknown' });
    assert.deepEqual(await store.pendingMessages(), []);
  } finally { await store.close(); }
});

test('early reservation requires matching staged ownership and fences later attachment staging', async () => {
  const store = new Store(':memory:');
  const ref = { attachmentId: 'file', name: 'fixture.txt', mediaType: 'text/plain', size: 4, availability: 'available' as const };
  const file = { id: 'file', operation_id: 'with-file', owner_id: 'owner', session_id: 'session', position: 0, name: 'fixture.txt', media_type: 'text/plain', size: 4, path: '/fixture.txt' };
  const input = { operationId: 'with-file', text: 'text', files: [ref] };
  try {
    await store.stageFiles('with-file', 'owner', 'session', 'fingerprint', { files: [file], refs: [ref] });
    await assert.rejects(store.reserveNativeDelivery(input, 'session', 'other-owner'), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    assert.equal(await store.deliveryAttempt('with-file', 'session'), undefined);
    assert.equal((await store.reserveNativeDelivery(input, 'session', 'owner'))?.created, true);
    const plain = { operationId: 'text-only', text: 'text' };
    await store.reserveNativeDelivery(plain, 'session', 'owner');
    await assert.rejects(store.stageFiles('text-only', 'owner', 'session', 'fingerprint', { files: [], refs: [] }), { code: 'MESSAGE_IDENTITY_CONFLICT' });
    await assert.rejects(store.stageImages('text-only', 'session', 'fingerprint', { images: [], refs: [], variants: [] }), { code: 'MESSAGE_IDENTITY_CONFLICT' });
  } finally { await store.close(); }
});
