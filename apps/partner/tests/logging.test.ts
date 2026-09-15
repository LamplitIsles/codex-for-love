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
    const internal = Object.assign(new Error('Missing acknowledged input segment metadata'), { code: 'EINTERNAL' });
    processError('fixture.internal', internal);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 3);
  assert(!lines[0].includes('private prompt'));
  assert(!lines[0].includes('QUJD'));
  assert(!lines[0].includes('secret-token'));
  assert(Buffer.byteLength(lines[0], 'utf8') <= 2060);
  assert.match(lines[0], /truncated/);
  assert(!lines[1].includes('private prompt'));
  assert.match(lines[1], /REDACTED_ERROR/);
  assert.match(lines[2], /Missing acknowledged input segment metadata/);
  assert.match(lines[2], /EINTERNAL/);
  assert.match(lines[2], /Error/);
});

test('projection diagnostics retain stable safe categories', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    processError('event.failed', Object.assign(new Error('private message body'), { code: 'MESSAGE_IDENTITY_CONFLICT' }), {
      method: 'item/completed', failureCode: 'message_identity_conflict', recoverable: true,
    });
    processError('event.failed', Object.assign(new Error('disk unavailable'), { code: 'SQLITE_IOERR' }), {
      method: 'turn/completed', failureCode: 'store_write_failed', recoverable: false,
    });
  } finally {
    console.error = original;
  }
  assert.match(lines[0] ?? '', /message_identity_conflict/);
  assert.match(lines[0] ?? '', /item\/completed/);
  assert.match(lines[0] ?? '', /MESSAGE_IDENTITY_CONFLICT/);
  assert.doesNotMatch(lines[0] ?? '', /private message body/);
  assert.match(lines[1] ?? '', /store_write_failed/);
  assert.match(lines[1] ?? '', /SQLITE_IOERR/);
});
