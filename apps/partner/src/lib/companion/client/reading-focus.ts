/** Reading overlays return to controls, never to an editor that would reopen the keyboard. */
export function captureReadingFocus(document: Document): HTMLElement | undefined {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return undefined;
  if (active.matches('input, textarea, [contenteditable]')) {
    active.blur();
    return undefined;
  }
  return active;
}

/** A deliberate tap on timeline content ends editing; scroll and interactive controls retain their behavior. */
export function dismissComposerOnTimelineTap(node: HTMLElement, composer: () => HTMLTextAreaElement | undefined) {
  let press: { id: number; x: number; y: number } | undefined;
  let tapped = false;
  const eligible = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return target === node || Boolean(element?.closest &&
      !element.closest('a, button, input, textarea, select, [contenteditable], [role="button"]'));
  };
  const cancel = () => { press = undefined; tapped = false; };
  const down = (event: PointerEvent) => {
    cancel();
    if (event.isPrimary && event.button === 0 && eligible(event.target))
      press = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const move = (event: PointerEvent) => {
    if (press && (press.id !== event.pointerId || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8)) cancel();
  };
  const up = (event: PointerEvent) => {
    const started = press;
    cancel();
    tapped = Boolean(started && started.id === event.pointerId && Math.hypot(event.clientX - started.x, event.clientY - started.y) <= 8);
  };
  const click = (event: MouseEvent) => {
    const input = composer();
    if (tapped && eligible(event.target) && node.ownerDocument.activeElement === input) input?.blur();
    cancel();
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('click', click);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('scroll', cancel);
  return { destroy() {
    cancel();
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('click', click);
    node.removeEventListener('pointercancel', cancel);
    node.removeEventListener('scroll', cancel);
  } };
}
