import { z } from 'zod';

const safeInteger = z.number().int().refine(Number.isSafeInteger);
const id = z.object({ deviceId: z.string().min(1).refine(value => Boolean(value.trim()) && Array.from(value).length <= 512), seq: safeInteger.nonnegative() }).strict();
const label = z.string().min(1).refine(value => Array.from(value).length <= 512 && value === value.trim() && !/[\r\n\u2028\u2029]/u.test(value));
const destination = z.object({ groupName: label, kind: z.enum(['group', 'broadcast', 'dm']) }).strict();
const rgiEmoji = new RegExp('^\\p{RGI_Emoji}$', 'v');
const keetShortcode = /^:(?:[a-z0-9][a-z0-9_+-]*|[+-][0-9]+):$/;
const reactionEmoji = z.string().min(1).refine(value => Array.from(value).length <= 66 && Buffer.byteLength(value, 'utf8') <= 258 && value === value.trim() && (rgiEmoji.test(value) || keetShortcode.test(value)));
const reactionContext = z.object({
  targetMessageId: id.refine(value => Array.from(value.deviceId).length <= 128),
  targetText: z.string().min(1).refine(value => Boolean(value.trim()) && Array.from(value).length <= 48),
  emoji: reactionEmoji,
  externalCount: safeInteger.positive().max(100_000),
}).strict();
const image = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), name: label.optional(), ref: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/) }).strict(),
  z.object({ status: z.literal('unavailable'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), name: label.optional() }).strict(),
]);
export const keetEvent = z.object({
  type: z.literal('message'), eventId: z.uuid(), sequence: safeInteger.positive(), messageId: id,
  timestamp: safeInteger, destination, senderLabel: label,
  text: z.string().refine(value => Array.from(value).length <= 16_000),
  images: z.array(image).min(1).max(16).optional(),
  replyTo: id.optional(), trigger: z.enum(['mention', 'label', 'reply', 'dm']).optional(),
  reactionContext: z.array(reactionContext).min(1).max(16).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.text.trim() && !value.images?.length) ctx.addIssue({ code: 'custom', message: 'Message needs text or images' });
  if ((value.destination.kind === 'dm') !== (value.trigger === 'dm') || (value.destination.kind === 'broadcast' && value.trigger))
    ctx.addIssue({ code: 'custom', message: 'Invalid destination trigger' });
  if (value.reactionContext && (!value.trigger || value.destination.kind === 'broadcast'))
    ctx.addIssue({ code: 'custom', message: 'Reaction context requires a Group or DM trigger' });
});
export type KeetEventBody = z.infer<typeof keetEvent>;
