import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StickerThumbnailCache } from '../runtime/sticker-thumbnail-cache.ts';

test('same-version requests share one generation and cached bytes cannot be modified by callers', async () => {
  const cache = new StickerThumbnailCache(2, 8, 2);
  let calls = 0, release!: (bytes: Buffer) => void;
  const generate = () => { calls++; return new Promise<Buffer>(resolve => { release = resolve; }); };
  const first = cache.get('a', generate), second = cache.get('a', generate);
  await Promise.resolve(); assert.equal(calls, 1);
  release(Buffer.from('abcd'));
  const [a, b] = await Promise.all([first, second]);
  a[0] = 0;
  assert.equal(b.toString(), 'abcd');
  assert.equal((await cache.get('a', generate)).toString(), 'abcd');
  assert.equal(calls, 1);
});

test('cache evicts by byte and entry limits, bounds work and retries failed generation', async () => {
  const cache = new StickerThumbnailCache(2, 5, 1);
  let calls = 0;
  const value = (text: string) => async () => { calls++; return Buffer.from(text); };
  await cache.get('a', value('aa')); await cache.get('b', value('bb'));
  await cache.get('a', value('unexpected')); // a becomes most recently used
  await cache.get('c', value('cc')); // byte limit evicts b
  await cache.get('b', value('b')); assert.equal(calls, 4);
  await cache.get('d', value('d')); // entry limit also evicts
  await cache.get('a', value('a')); assert.equal(calls, 6);
  let release!: (bytes: Buffer) => void;
  const pending = cache.get('pending', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(cache.get('other', value('x')), /busy/u);
  release(Buffer.from('x')); await pending;
  await assert.rejects(cache.get('failed', async () => { throw new Error('decode'); }), /decode/u);
  assert.equal((await cache.get('failed', value('ok'))).toString(), 'ok');
});

test('clearing while generation is pending prevents it repopulating the cache', async () => {
  const cache = new StickerThumbnailCache();
  let release!: (bytes: Buffer) => void, calls = 0;
  const pending = cache.get('a', () => new Promise(resolve => { calls++; release = resolve; }));
  await Promise.resolve(); cache.clear(); release(Buffer.from('old')); await pending;
  assert.equal((await cache.get('a', async () => { calls++; return Buffer.from('new'); })).toString(), 'new');
  assert.equal(calls, 2);
});
