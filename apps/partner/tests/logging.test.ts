import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processError, processLog } from '../runtime/logging.ts';

test('process diagnostics are bounded and do not expose model or image payloads', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    processLog('fixture.failure', { prompt: 'private prompt', data: 'data:image/png;base64,QUJD', error: 'Bearer secret-token', safe: Array.from({ length: 16 }, () => 'x'.repeat(240)) });
    processError('fixture.error', new Error('provider rejected private prompt content'), { operationId: 'safe-id' });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 2);
  assert(!lines[0].includes('private prompt'));
  assert(!lines[0].includes('QUJD'));
  assert(!lines[0].includes('secret-token'));
  assert(Buffer.byteLength(lines[0], 'utf8') <= 2060);
  assert.match(lines[0], /truncated/);
  assert(!lines[1].includes('private prompt'));
  assert.match(lines[1], /REDACTED_ERROR/);
});
