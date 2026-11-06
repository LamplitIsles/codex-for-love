import * as contracts from '@lamplit/contracts';

// These are transport limits, not an alternative A2UI protocol validator.
// The authoritative validator and payload bounding come from the selected App.
const MAX_RESULT_BYTES = 128 * 1024;
type Validator = (value: unknown) => unknown;
type UiDispatch = { itemId: string; ui: unknown };

function sharedFunction(name: 'validateA2UISurface' | 'boundA2UIPayload'): Validator {
  const value = (contracts as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error('Published A2UI contracts are unavailable');
  return value as Validator;
}

/** The MCP handler persists only a surface accepted by the shared contract. */
export function sendUiResult(ui: unknown, validate?: Validator) {
  try {
    const surface = (validate ?? sharedFunction('validateA2UISurface'))(ui);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'ui', ui: surface }) }] };
  } catch {
    return { content: [{ type: 'text' as const, text: 'Invalid A2UI surface' }], isError: true as const };
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read only the explicitly designated successful result, never arbitrary tool payloads. */
export function uiDispatchesFromTurn(
  turn: { items?: readonly Record<string, unknown>[] } | undefined,
  bound?: Validator,
): UiDispatch[] {
  const items = turn?.items ?? [];
  const counts = new Map<string, number>();
  for (const item of items) if (typeof item.id === 'string' && item.id) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const dispatches: UiDispatch[] = [];
  for (const item of items) {
    if (item.type !== 'mcpToolCall' || item.server !== 'companion' || item.tool !== 'send_ui'
      || item.status !== 'completed' || item.error != null || typeof item.id !== 'string' || !item.id || counts.get(item.id) !== 1) continue;
    const result = object(item.result);
    if (!result || (result.isError !== undefined && result.isError !== false) || !Array.isArray(result.content) || result.content.length !== 1) continue;
    const content = object(result.content[0]);
    if (!content || content.type !== 'text' || typeof content.text !== 'string') continue;
    if (Buffer.byteLength(content.text, 'utf8') > MAX_RESULT_BYTES) {
      // Do not parse or expose oversized result data. Preserve this completed
      // tool item's position as a small invalid surface when UI is available.
      try { (bound ?? sharedFunction('boundA2UIPayload')); dispatches.push({ itemId: item.id, ui: {} }); } catch {}
      continue;
    }
    let envelope: Record<string, unknown> | undefined;
    try { envelope = object(JSON.parse(content.text)); } catch { continue; }
    if (!envelope || envelope.kind !== 'ui' || !Object.hasOwn(envelope, 'ui')
      || Object.keys(envelope).some(key => key !== 'kind' && key !== 'ui')) continue;
    // Old pinned contracts have no UI payload boundary. Hide the item until
    // the matching published contracts are installed, leaving chat usable.
    try { dispatches.push({ itemId: item.id, ui: (bound ?? sharedFunction('boundA2UIPayload'))(envelope.ui) }); } catch { continue; }
  }
  return dispatches;
}
