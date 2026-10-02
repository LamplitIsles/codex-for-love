import { captureReadingFocus } from './reading-focus.ts';

interface Overlay { el: HTMLElement }
const modalCleanup = new WeakMap<HTMLElement, () => void>();
const activeModals: HTMLElement[] = [];
const focusable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(
  'button, input, textarea, select, a[href], [tabindex]',
)].filter(node => node.tabIndex >= 0 && !node.matches(':disabled, [aria-disabled="true"]') && node.getClientRects().length);
const returnFocus = new WeakMap<HTMLElement, HTMLElement>();

// Component lifecycle and backdrop ownership stay entirely with Framework7.
export function overlayOpening(overlay?: Overlay): void {
  if (!overlay) return;
  const target = captureReadingFocus(overlay.el.ownerDocument);
  if (target) returnFocus.set(overlay.el, target);
}
export function overlayOpened(overlay?: Overlay): void {
  if (!overlay) return;
  const root = overlay.el;
  if (root.getAttribute('aria-modal') === 'true' && !modalCleanup.has(root)) {
    activeModals.push(root);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || activeModals.at(-1) !== root) return;
      // An Actions/PhotoBrowser dialog above this overlay owns its own keyboard navigation.
      const nested = (event.target as Element).closest('[aria-modal="true"]');
      if (nested && nested !== root) return;
      const targets = focusable(root);
      const index = targets.indexOf(root.ownerDocument.activeElement as HTMLElement);
      if (!targets.length || index < 0 || (event.shiftKey ? index === 0 : index === targets.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? targets.at(-1) : targets[0])?.focus({ preventScroll: true });
      }
    };
    root.ownerDocument.addEventListener('keydown', keydown, true);
    modalCleanup.set(root, () => {
      root.ownerDocument.removeEventListener('keydown', keydown, true);
      activeModals.splice(activeModals.indexOf(root), 1);
    });
  }
  focusable(root)[0]?.focus({ preventScroll: true });
}
export function overlayDestroyed(overlay?: Overlay): void {
  if (!overlay) return;
  modalCleanup.get(overlay.el)?.();
  modalCleanup.delete(overlay.el);
  returnFocus.delete(overlay.el);
}
export function overlayClosed(overlay?: Overlay): void {
  if (!overlay) return;
  const target = returnFocus.get(overlay.el);
  overlayDestroyed(overlay);
  if (target?.isConnected) target.focus({ preventScroll: true });
}
