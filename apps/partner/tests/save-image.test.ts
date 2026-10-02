import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capacitor } from '@capacitor/core';
import { saveImage, ImageSaveUnavailableError } from '../src/lib/companion/client/save-image.ts';

test('native shells without Media report unavailable before fetching an image', async (t) => {
  t.mock.method(Capacitor, 'isNativePlatform', () => true);
  const capability = t.mock.method(Capacitor, 'isPluginAvailable', () => false);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  await assert.rejects(saveImage('/fixture.png', 'fixture'), ImageSaveUnavailableError);
  assert.deepEqual(capability.mock.calls[0].arguments, ['Media']);
  assert.equal(fetch.mock.callCount(), 0);
});
