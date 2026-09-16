import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMessageTime, isPlainTextMessage, messageTimeDateTime } from '../src/lib/companion/message-time.ts';

test('message time keeps a local HH:mm label and machine-readable datetime', () => {
  const value = new Date(2026, 8, 16, 7, 5, 3).getTime();
  assert.equal(formatMessageTime(value), '07:05');
  assert.equal(messageTimeDateTime(value), new Date(value).toISOString());
});

test('plain text is eligible for measured final-line timestamp placement regardless of length', () => {
  assert.equal(isPlainTextMessage('A quiet ordinary message.'), true);
  assert.equal(isPlainTextMessage('x'.repeat(121)), true);
  assert.equal(isPlainTextMessage(''), false);
  assert.equal(isPlainTextMessage('A wrapped\nmessage.'), false);
  assert.equal(isPlainTextMessage('**Rich Markdown**'), false);
});
