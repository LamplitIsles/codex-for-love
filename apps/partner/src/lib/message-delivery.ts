export type MessageDelivery =
  | 'sending'
  | 'pending'
  | 'queued'
  | 'acknowledged'
  | 'unresolved'
  | 'replaced';

export function outgoingDeliveryPresentation(delivery: MessageDelivery) {
  if (delivery === 'sending') return { pending: true, labelKey: 'delivery.sending' as const };
  if (delivery === 'queued') return { pending: true, labelKey: 'delivery.queued' as const };
  if (delivery === 'unresolved') return { pending: true, labelKey: 'delivery.unresolved' as const };
  return { pending: false, labelKey: undefined };
}
