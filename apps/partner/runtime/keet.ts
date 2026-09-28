import { z } from 'zod';

const safeInteger = z.number().int().refine(Number.isSafeInteger);
const id = z.object({ deviceId: z.string().min(1).refine(value => Boolean(value.trim()) && Array.from(value).length <= 512), seq: safeInteger.nonnegative() }).strict();
const label = z.string().min(1).refine(value => Array.from(value).length <= 512 && value === value.trim() && !/[\r\n\u2028\u2029]/u.test(value));
const destination = z.object({ groupName: label, kind: z.enum(['group', 'broadcast', 'dm']) }).strict();
export const keetEvent = z.object({
  type: z.literal('message'), eventId: z.uuid(), sequence: safeInteger.positive(), messageId: id,
  timestamp: safeInteger, destination, senderLabel: label,
  text: z.string().min(1).refine(value => Boolean(value.trim()) && Array.from(value).length <= 16_000),
  replyTo: id.optional(), trigger: z.enum(['mention', 'label', 'reply', 'dm']).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.destination.kind === 'dm') !== (value.trigger === 'dm') || (value.destination.kind === 'broadcast' && value.trigger))
    ctx.addIssue({ code: 'custom', message: 'Invalid destination trigger' });
});
export type KeetEventBody = z.infer<typeof keetEvent>;
