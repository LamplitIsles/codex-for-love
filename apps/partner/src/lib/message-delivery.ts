export type MessageDelivery =
  | 'sending'
  | 'pending'
  | 'queued'
  | 'acknowledged'
  | 'unresolved'
  | 'replaced';

export function outgoingDeliveryPresentation(delivery: MessageDelivery) {
  if (delivery === 'sending') return { pending: true, label: '正在发送…' };
  if (delivery === 'queued') return { pending: true, label: '排队中' };
  if (delivery === 'unresolved') return { pending: true, label: '尚未确认送达…' };
  return { pending: false, label: undefined };
}
