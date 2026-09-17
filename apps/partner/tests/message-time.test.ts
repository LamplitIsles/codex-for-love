import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMessageTime, isPlainTextMessage, messageTimeDateTime, messageTimePlacement, messageTimeFitsInline } from '../src/lib/companion/message-time.ts';

test('message time keeps a local HH:mm label and machine-readable datetime', () => {
  const value = new Date(2026, 8, 16, 7, 5, 3).getTime();
  assert.equal(formatMessageTime(value), '07:05');
  assert.equal(messageTimeDateTime(value), new Date(value).toISOString());
});

test('only one visual text line may share its timestamp', () => {
  assert.equal(isPlainTextMessage('A quiet ordinary message.'), true);
  assert.equal(isPlainTextMessage('x'.repeat(121)), true);
  assert.equal(isPlainTextMessage(''), false);
  assert.equal(isPlainTextMessage('A wrapped\nmessage.'), false);
  assert.equal(isPlainTextMessage('**Rich Markdown**'), false);
  assert.equal(messageTimeFitsInline(1, true), true);
  assert.equal(messageTimeFitsInline(2, true), false);
  assert.equal(messageTimeFitsInline(1, false), false);
});

test('a text message keeps its fallback time inside its trailing bubble', () => {
  assert.equal(messageTimePlacement(true, true, true), 'inline');
  assert.equal(messageTimePlacement(true, false, true), 'bubble-trailing');
  assert.equal(messageTimePlacement(true, false, false), 'stack-trailing');
  assert.equal(messageTimePlacement(false, false, true), 'none');
});
