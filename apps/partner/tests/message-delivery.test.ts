import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outgoingDeliveryPresentation } from '../src/lib/message-delivery.ts';

test('outgoing presentation separates transport, queue and Partner response state', () => {
  assert.deepEqual(outgoingDeliveryPresentation('sending'), { pending: true, label: '正在发送…' });
  assert.deepEqual(outgoingDeliveryPresentation('pending'), { pending: false, label: undefined });
  assert.deepEqual(outgoingDeliveryPresentation('acknowledged'), { pending: false, label: undefined });
  assert.deepEqual(outgoingDeliveryPresentation('queued'), { pending: true, label: '排队中' });
  assert.deepEqual(outgoingDeliveryPresentation('unresolved'), { pending: true, label: '尚未确认送达…' });
});
