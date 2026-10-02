import { f7 } from "framework7-svelte";

/** Framework7 owns touch holds; pointer events adapt mouse holds to the same menu. */
export function longPress(node: HTMLElement, options: { run(node: HTMLElement): void }) {
  // Framework7 9.2 leaves the first hold pending when a stationary second finger lands.
  // Guard that gap without duplicating its timer or movement recognition.
  let multiTouch = false;
  const start = (event: TouchEvent) => { if (event.touches.length > 1) multiTouch = true; };
  const end = (event: TouchEvent) => { if (!event.touches.length) multiTouch = false; };
  const hold = () => { if (!multiTouch) options.run(node); };
  const context = (event: MouseEvent) => {
    event.preventDefault();
    if (event.button === 2) options.run(node);
  };
  let mouse: { id: number; x: number; y: number; fired: boolean } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const clearMouse = () => {
    clearTimeout(timer); clearTimeout(releaseTimer); mouse = undefined;
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", release, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("click", click, true);
    window.removeEventListener("blur", clearMouse);
  };
  const move = (event: PointerEvent) => {
    if (mouse && event.pointerId === mouse.id && !mouse.fired && Math.hypot(event.clientX - mouse.x, event.clientY - mouse.y) > 10) clearMouse();
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId !== mouse?.id) return;
    clearTimeout(timer);
    // The release click follows pointerup. Keep capture until that click has passed.
    if (mouse.fired) releaseTimer = setTimeout(clearMouse, 0);
    else clearMouse();
  };
  const cancel = (event: PointerEvent) => { if (event.pointerId === mouse?.id) clearMouse(); };
  const scroll = () => { if (!mouse?.fired) clearMouse(); };
  const click = (event: MouseEvent) => {
    if (mouse?.fired) { event.preventDefault(); event.stopImmediatePropagation(); clearMouse(); }
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    clearMouse();
    mouse = { id: event.pointerId, x: event.clientX, y: event.clientY, fired: false };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("click", click, true);
    window.addEventListener("blur", clearMouse);
    timer = setTimeout(() => {
      if (!mouse) return;
      mouse.fired = true;
      options.run(node);
    }, f7.params.touch?.tapHoldDelay ?? 450);
  };
  node.addEventListener("pointerdown", down);
  const select = (event: Event) => event.preventDefault();
  document.addEventListener("touchstart", start, { capture: true, passive: true });
  document.addEventListener("touchend", end, { capture: true, passive: true });
  document.addEventListener("touchcancel", end, { capture: true, passive: true });
  node.addEventListener("taphold", hold);
  node.addEventListener("contextmenu", context);
  node.addEventListener("selectstart", select);
  return {
    update(next: typeof options) { options = next; },
    destroy() {
      clearMouse();
      node.removeEventListener("pointerdown", down);
      document.removeEventListener("touchstart", start, true);
      document.removeEventListener("touchend", end, true);
      document.removeEventListener("touchcancel", end, true);
      node.removeEventListener("taphold", hold);
      node.removeEventListener("contextmenu", context);
      node.removeEventListener("selectstart", select);
    },
  };
}
