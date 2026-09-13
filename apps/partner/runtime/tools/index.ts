import { z } from 'zod';
import type { v2 } from '@jaminzhou/codex-app-server-client/protocol';
import type { Store } from '../store.ts';
import { rollDice } from './dice-core.ts';
import { companionTools, type CompanionTool, type ToolContext } from './companion.ts';

export type DynamicToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  inputSchema: v2.DynamicToolFunctionSpec['inputSchema'];
};

export type DynamicToolSet = {
  definitions: DynamicToolDefinition[];
  call(name: string, input: unknown, context: ToolContext): Promise<{ success: boolean; contentItems: Array<{ type: 'inputText'; text: string }> }>;
};

const dice = z.object({
  count: z.number().int().min(1).max(100).optional(),
  sides: z.number().int().min(2).max(1_000_000),
  modifier: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  label: z.string().max(200).optional(),
}).strict();

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/** The only application-owned model tools. All coding/MCP/skill tools stay native. */
export function createTools(store: Store, operationId: (context: ToolContext) => string): DynamicToolSet {
  const tools: Record<string, CompanionTool> = {
    ...companionTools(store, operationId),
    roll_dice: {
      description: 'Roll dice with an optional modifier and label. Use the actual rolls and total as the source of truth.',
      inputSchema: z.toJSONSchema(dice) as v2.DynamicToolFunctionSpec['inputSchema'],
      handler(input, context) {
        context.signal.throwIfAborted();
        return rollDice(dice.parse(input));
      },
    },
  };
  const definitions = Object.entries(tools).map(([name, tool]) => ({
    type: 'function' as const,
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return {
    definitions,
    async call(name, input, context) {
      const tool = tools[name];
      if (!tool) return { success: false, contentItems: [{ type: 'inputText', text: `Unknown Partner tool: ${name}` }] };
      try {
        return { success: true, contentItems: [{ type: 'inputText', text: asText(await tool.handler(input, context)) }] };
      } catch (error) {
        return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  };
}
