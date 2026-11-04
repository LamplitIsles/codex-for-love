import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { stickerThumbnail, validateStickerImage } from '../runtime/sticker-image.ts';

test('thumbnails preserve alpha and first frame, stay static and respect dimensions', async () => {
  const transparent = await sharp(Buffer.from([255, 0, 0, 0, 0, 255, 0, 255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const thumb = await stickerThumbnail(transparent, 'image/png');
  const metadata = await sharp(thumb).metadata();
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 2); assert.equal(metadata.height, 1);
  assert.equal(metadata.pages ?? 1, 1); assert.ok(thumb.length <= 160_000);
  const rgba = await sharp(thumb).ensureAlpha().raw().toBuffer();
  assert.equal(rgba[3], 0); assert.equal(rgba[7], 255);

  const opaque = await sharp({ create: { width: 1000, height: 500, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  const resized = await stickerThumbnail(opaque, 'image/jpeg');
  const resizedMeta = await sharp(resized).metadata();
  assert.equal(resizedMeta.width, 512); assert.equal(resizedMeta.height, 256);
  assert.equal(resizedMeta.hasAlpha, false); assert.ok(resized.length <= 160_000);

  const gif = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const gifThumb = await stickerThumbnail(gif, 'image/gif');
  const gifMeta = await sharp(gifThumb, { animated: true }).metadata();
  assert.equal(gifMeta.format, 'webp'); assert.equal(gifMeta.pages ?? 1, 1); assert.equal(gifMeta.height, 1);
  const pixel = await sharp(gifThumb).raw().toBuffer();
  assert.ok(pixel[0]! > pixel[1]!, 'first frame is red');
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);

  const transparentGif = await sharp(Buffer.from([
    255, 0, 0, 0, 255, 0, 0, 255,
    0, 255, 0, 255, 0, 255, 0, 255,
  ]), { raw: { width: 2, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const firstFrame = await stickerThumbnail(transparentGif, 'image/gif');
  const firstPixels = await sharp(firstFrame).ensureAlpha().raw().toBuffer();
  assert.equal(firstPixels[3], 0); assert.equal(firstPixels[7], 255);
  assert.equal((await sharp(firstFrame, { animated: true }).metadata()).pages ?? 1, 1);
});

test('thumbnail encoder bounds noisy transparent images', async () => {
  const pixels = Buffer.alloc(512 * 512 * 4);
  let state = 1;
  for (let i = 0; i < pixels.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[i] = state >>> 24; }
  const png = await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
  const thumb = await stickerThumbnail(png, 'image/png');
  const meta = await sharp(thumb).metadata();
  assert.ok(thumb.length <= 160_000); assert.ok(meta.width! <= 512 && meta.height! <= 512);
  assert.equal(meta.hasAlpha, true);
});

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
