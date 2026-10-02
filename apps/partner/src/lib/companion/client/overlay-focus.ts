import { captureReadingFocus } from './reading-focus.ts';

interface Overlay { el: HTMLElement }
const returnFocus = new WeakMap<HTMLElement, HTMLElement>();

// Component lifecycle and backdrop ownership stay entirely with Framework7.
export function overlayOpening(overlay?: Overlay): void {
  if (!overlay) return;
  const target = captureReadingFocus(overlay.el.ownerDocument);
  if (target) returnFocus.set(overlay.el, target);
}
export function overlayOpened(overlay?: Overlay): void {
  if (!overlay) return;
  overlay.el.querySelector<HTMLElement>('button, input, a[href], [tabindex="0"]')?.focus({ preventScroll: true });
}
export function overlayClosed(overlay?: Overlay): void {
  if (!overlay) return;
  const target = returnFocus.get(overlay.el);
  returnFocus.delete(overlay.el);
  if (target?.isConnected) target.focus({ preventScroll: true });
}
