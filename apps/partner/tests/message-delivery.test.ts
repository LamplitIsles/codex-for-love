import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outgoingDeliveryPresentation } from '../src/lib/message-delivery.ts';

test('outgoing presentation separates transport, queue and Partner response state', () => {
  assert.deepEqual(outgoingDeliveryPresentation('sending'), { pending: true, labelKey: 'delivery.sending' });
  assert.deepEqual(outgoingDeliveryPresentation('pending'), { pending: false, labelKey: undefined });
  assert.deepEqual(outgoingDeliveryPresentation('acknowledged'), { pending: false, labelKey: undefined });
  assert.deepEqual(outgoingDeliveryPresentation('queued'), { pending: true, labelKey: 'delivery.queued' });
  assert.deepEqual(outgoingDeliveryPresentation('unresolved'), { pending: true, labelKey: 'delivery.unresolved' });
});
