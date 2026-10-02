import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraErrorCode, MediaType } from '@capacitor/camera';
import { captureNativePhoto } from '../src/lib/companion/client/native-mobile.ts';

test('native camera result enters the common File path; cancellation is silent and other errors propagate', async () => {
  const file = await captureNativePhoto(async () => ({
    type: MediaType.Photo, saved: false, webPath: 'data:image/jpeg;base64,YWJj',
  }));
  assert.equal(file?.type, 'image/jpeg');
  assert.equal(await file?.text(), 'abc');
  assert.equal(await captureNativePhoto(async () => { throw { code: CameraErrorCode.TakePhotoCancelled }; }), undefined);
  await assert.rejects(captureNativePhoto(async () => { throw new Error('permission-denied'); }), /permission-denied/);
});
