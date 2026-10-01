import { Capacitor } from '@capacitor/core';
import { Camera, CameraErrorCode } from '@capacitor/camera';
import { Keyboard } from '@capacitor/keyboard';
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

/** Keep focus while asking the native keyboard to hide. Message text is included; interactive controls are untouched. */
export function dismissNativeKeyboardOnTimelineTap(
  node: HTMLElement,
  composer: () => HTMLTextAreaElement | undefined,
  keyboard = {
    available: () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Keyboard'),
    hide: () => Keyboard.hide(),
  },
  host: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> = node.ownerDocument.defaultView!,
): { destroy(): void } {
  if (!keyboard.available()) return { destroy() {} };
  let press: { id: number; x: number; y: number } | undefined;
  let tapped = false;
  let frame = 0;
  let disposed = false;
  const eligible = (target: EventTarget | null) => {
    if (target === node) return true;
    const element = target as HTMLElement | null;
    if (!element?.matches) return false;
    if (element.closest('.companion-message-copy')) return true;
    if (element.closest('a, button, input, textarea, select, [contenteditable], [role="button"]')) return false;
    return element.matches('.companion-timeline-content, .companion-row, .companion-message-stack') ||
      Boolean(element.closest('.companion-text-bubble'));
  };
  const cancel = () => {
    press = undefined;
    tapped = false;
    if (frame) host.cancelAnimationFrame(frame);
    frame = 0;
  };
  const down = (event: PointerEvent) => {
    cancel();
    const input = composer();
    if (!event.isPrimary || event.pointerType !== 'touch' || event.button !== 0 ||
        !input || node.ownerDocument.activeElement !== input) return;
    if (!eligible(event.target)) return;
    // Prevent the default focus transfer before blur occurs. Touch panning
    // remains native; movement/scroll/cancellation discard this tap.
    event.preventDefault();
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const move = (event: PointerEvent) => {
    if (press && (event.pointerId !== press.id ||
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8)) cancel();
  };
  const up = (event: PointerEvent) => {
    const started = press;
    cancel();
    tapped = Boolean(started && started.id === event.pointerId &&
      Math.hypot(event.clientX - started.x, event.clientY - started.y) <= 8 &&
      node.ownerDocument.activeElement === composer());
  };
  const click = (event: MouseEvent) => {
    const input = composer();
    if (!tapped || !eligible(event.target) || !input ||
        node.ownerDocument.activeElement !== input) { cancel(); return; }
    tapped = false;
    // Android WebView can request SHOW_SOFT_INPUT after dispatching the tap.
    // Let that default handling finish before the native hide request.
    frame = host.requestAnimationFrame(() => {
      frame = 0;
      if (disposed || node.ownerDocument.activeElement !== input) return;
      void keyboard.hide().catch(() => {
        if (!disposed && node.ownerDocument.activeElement === input) input.blur();
      });
    });
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('click', click);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('scroll', cancel);
  return {
    destroy() {
      disposed = true;
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('click', click);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('scroll', cancel);
    },
  };
}
