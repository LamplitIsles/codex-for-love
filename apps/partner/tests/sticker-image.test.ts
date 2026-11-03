import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { validateStickerImage } from '../runtime/sticker-image.ts';

test('animated sticker keeps original bytes and emits static representative JPEGs', async () => {
  const pixels = Buffer.from([255,0,0,255, 0,255,0,255]);
  const gif = await sharp(pixels, { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const image = await validateStickerImage(gif, 'image/gif');
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
  assert.equal(image.frames, 2);
  assert.deepEqual(image.original, gif);
  assert.equal((await sharp(image.preview, { animated: true }).metadata()).pages ?? 1, 1);
  assert.equal((await sharp(image.model, { animated: true }).metadata()).pages ?? 1, 1);
  assert.equal((await sharp(image.model).metadata()).format, 'jpeg');
  assert.notDeepEqual(image.model, image.original);
  await assert.rejects(validateStickerImage(gif, 'image/png'));
  await assert.rejects(validateStickerImage(Buffer.from('GIF89a'), 'image/gif'));
});

test('sticker image intake rejects oversized dimensions, frames and bytes', async () => {
  const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(validateStickerImage(wide, 'image/png'));
  const pixels = Buffer.alloc(101 * 4);
  for (let i = 0; i < 101; i++) { pixels[i * 4] = i % 2 ? 255 : 0; pixels[i * 4 + 1] = i % 2 ? 0 : 255; pixels[i * 4 + 3] = 255; }
  const animation = await sharp(pixels, { raw: { width: 1, height: 101, channels: 4, pageHeight: 1 } }).gif({ delay: Array(101).fill(100), loop: 0 }).toBuffer();
  assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 101);
  await assert.rejects(validateStickerImage(animation, 'image/gif'));
  await assert.rejects(validateStickerImage(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png'));
});
