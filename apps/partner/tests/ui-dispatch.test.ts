import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendUiResult, uiDispatchesFromTurn } from '../runtime/ui-dispatch.ts';

const validate = (value: unknown) => {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== '1.0') throw new Error('invalid');
  return value;
};
const bound = (value: unknown) => value;
const ui = { version: '1.0', createSurface: { surfaceId: 'test' } };
const item = (id: string, patch: Record<string, unknown> = {}) => ({ type: 'mcpToolCall', id, server: 'companion', tool: 'send_ui', status: 'completed', error: null, result: sendUiResult(ui, validate), ...patch });

test('write handler delegates to the supplied contract and fails closed on validation errors', () => {
  assert.deepEqual(JSON.parse(sendUiResult(ui, validate).content[0]!.text), { kind: 'ui', ui });
  assert.equal(sendUiResult({ version: 'v1.0' }, validate).isError, true);
  assert.equal(sendUiResult(ui, () => { throw new Error('contract unavailable'); }).isError, true);
});

test('projection accepts one successful designated result and excludes private tool data', () => {
  const valid = item('one', { arguments: { secret: 'private' }, result: { ...sendUiResult(ui, validate), structuredContent: { secret: 'private' } } });
  assert.deepEqual(uiDispatchesFromTurn({ items: [valid] }, bound), [{ itemId: 'one', ui }]);
  const invalid = [item('failed', { status: 'failed' }), item('working', { status: 'inProgress' }), item('other', { server: 'post' }), item('tool', { tool: 'send_voice' }), item('error', { error: { message: 'bad' } }), item('mcp-error', { result: { ...sendUiResult(ui, validate), isError: true } }), item('invalid-error', { result: { ...sendUiResult(ui, validate), isError: 'false' } }), item('duplicate'), item('duplicate'), item('text', { result: { content: [{ type: 'text', text: '{' }] } }), item('extra', { result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'ui', ui, private: 'secret' }) }] } }), item('multi', { result: { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] } })];
  assert.deepEqual(uiDispatchesFromTurn({ items: invalid }, bound), []);
});

test('projection delegates bounded copies, preserving independent item order and identity', () => {
  const calls: unknown[] = [];
  const result = uiDispatchesFromTurn({ items: [item('a'), item('b', { result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'ui', ui: null }) }] } })] }, value => { calls.push(value); return value === null ? {} : structuredClone(value); });
  assert.deepEqual(result, [{ itemId: 'a', ui }, { itemId: 'b', ui: {} }]);
  assert.deepEqual(calls, [ui, null]);
  assert.notEqual(result[0]!.ui, ui);
});

test('oversized successful result preserves only an invalid placeholder', () => {
  const huge = item('huge', { result: { content: [{ type: 'text', text: 'PRIVATE'.repeat(20000) }] } });
  assert.deepEqual(uiDispatchesFromTurn({ items: [huge] }, bound), [{ itemId: 'huge', ui: {} }]);
  assert.deepEqual(uiDispatchesFromTurn({ items: [huge, huge] }, bound), []);
  assert.deepEqual(uiDispatchesFromTurn({ items: [{ ...huge, status: 'failed' }, { ...huge, id: 'error', error: { message: 'failure' } }] }, bound), []);
});
