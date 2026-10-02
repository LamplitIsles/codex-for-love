import { Capacitor } from '@capacitor/core';
import { Camera, CameraErrorCode } from '@capacitor/camera';
import { imageFileFromCapturedMedia } from './image-drafts.ts';

export function hasNativeCamera(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Camera');
}

export async function captureNativePhoto(
  takePhoto = () => Camera.takePhoto({ saveToGallery: false, includeMetadata: true }),
): Promise<File | undefined> {
  try {
    return await imageFileFromCapturedMedia(await takePhoto());
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error &&
        error.code === CameraErrorCode.TakePhotoCancelled) return undefined;
    throw error;
  }
}
