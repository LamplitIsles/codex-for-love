import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { pageConversationImages, type ConversationImage } from '../runtime/conversation-images.ts';

const image = (name: string, created: number, origin: ConversationImage['origin']): ConversationImage => {
  const id = createHash('sha256').update(name).digest('hex');
  return { id, filename: `${name}.png`, path: `/test-owned/${name}.png`, mediaType: 'image/png', created, origin, available: true };
};

test('conversation image pages have stable newest-first opaque cursors across every included origin', () => {
  const images = [image('owner', 10, 'owner'), image('partner', 30, 'partner'), image('historical', 20, 'historical')];
  const first = pageConversationImages(images, 2);
  assert.deepEqual(first.images.map((value) => value.filename), ['partner.png', 'historical.png']);
  assert.ok(first.nextCursor); assert.match(first.nextCursor!, /^[A-Za-z0-9_-]{54}$/u); assert.doesNotMatch(first.nextCursor!, /partner|historical|30/);
  const next = pageConversationImages(images, 2, first.nextCursor);
  assert.deepEqual(next.images.map((value) => value.filename), ['owner.png']);
  assert.equal(next.nextCursor, undefined);
  assert.throws(() => pageConversationImages(images, 2, 'a'.repeat(53)), /Invalid conversation image cursor/);
  assert.throws(() => pageConversationImages(images, 2, '!'.repeat(54)), /Invalid conversation image cursor/);
  const unsafeTimestamp = Buffer.alloc(40); unsafeTimestamp.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  assert.throws(() => pageConversationImages(images, 2, unsafeTimestamp.toString('base64url')), /Invalid conversation image cursor/);
});

test('conversation image page omission defaults to five items', () => {
  const images = Array.from({ length: 6 }, (_, index) => image(`image-${index}`, 60 - index, 'partner'));
  const page = pageConversationImages(images);
  assert.equal(page.images.length, 5);
  assert.ok(page.nextCursor);
});
