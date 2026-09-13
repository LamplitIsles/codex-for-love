import { z } from 'zod';
import type { v2 } from '@jaminzhou/codex-app-server-client/protocol';
import type { Store } from '../store.ts';
import { MOODS, canonicalizeChangeReason, canonicalizeRelationshipUpdate, canonicalizeSignature } from '../../src/lib/companion/domain.ts';

export type ToolContext = { signal: AbortSignal; callId: string; turnId?: string };
export type CompanionTool = {
  description: string;
  inputSchema: v2.DynamicToolFunctionSpec['inputSchema'];
  handler: (input: unknown, context: ToolContext) => unknown | Promise<unknown>;
};

const reaction = z.object({
  mood: z.object({ value: z.enum(MOODS), note: z.string().optional(), reason: z.string() }).strict().optional(),
  affinity: z.object({ delta: z.number().int().min(-10).max(10), reason: z.string() }).strict().optional(),
}).strict();
const signature = z.object({ signature: z.string(), reason: z.string() }).strict();
const history = z.object({ limit: z.number().int().min(1).max(20).optional() }).strict();

function check(signal: AbortSignal): void {
  signal.throwIfAborted();
}

export function companionTools(store: Store, operationId: (context: ToolContext) => string): Record<string, CompanionTool> {
  return {
    companion_update_relationship: {
      description: 'Record a current mood or relationship reaction, or both, with concise factual reasons. Mood is a moment, not a constraint on your expression; affinity is not a goal to maximize. Net affinity movement per user turn is bounded to ±10.',
      inputSchema: z.toJSONSchema(reaction) as v2.DynamicToolFunctionSpec['inputSchema'],
      async handler(input, context) {
        check(context.signal);
        return store.updateRelationship(operationId(context), context.callId, canonicalizeRelationshipUpdate(reaction.parse(input)));
      },
    },
    companion_set_signature: {
      description: 'Set your own short profile signature when you want it to change. Maximum 80 Unicode code points, plain text, with a concise factual reason.',
      inputSchema: z.toJSONSchema(signature) as v2.DynamicToolFunctionSpec['inputSchema'],
      async handler(input, context) {
        check(context.signal);
        const args = signature.parse(input);
        return store.updateRelationship(operationId(context), context.callId, {
          signature: { value: canonicalizeSignature(args.signature), reason: canonicalizeChangeReason(args.reason) },
        });
      },
    },
    companion_read_history: {
      description: 'Read recent changes in your mood, affinity and signature. These state records are limited evidence, not the full shared history.',
      inputSchema: z.toJSONSchema(history) as v2.DynamicToolFunctionSpec['inputSchema'],
      async handler(input, context) {
        check(context.signal);
        return (await store.relationshipHistory()).slice(0, history.parse(input).limit ?? 10);
      },
    },
  };
}
