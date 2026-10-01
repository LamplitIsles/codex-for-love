/** Companion-local visible area. Native content resize remains the baseline. */
export function visibleViewport(node: HTMLElement, host: Window = window): { destroy(): void } {
  const viewport = host.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    // Pinch zoom must retain normal browser panning, rather than shrink the UI.
    if (!viewport || viewport.scale !== 1) {
      node.style.removeProperty('--companion-visible-height');
      node.style.removeProperty('--companion-visible-top');
      return;
    }
    // This is the visible height itself, not a keyboard height subtraction.
    node.style.setProperty('--companion-visible-height', `${viewport.height}px`);
    node.style.setProperty('--companion-visible-top', `${viewport.offsetTop}px`);
  };
  const schedule = () => {
    if (!frame) frame = host.requestAnimationFrame(update);
  };
  update();
  host.addEventListener('resize', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  return {
    destroy() {
      host.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      if (frame) host.cancelAnimationFrame(frame);
      node.style.removeProperty('--companion-visible-height');
      node.style.removeProperty('--companion-visible-top');
    },
  };
}

/** Observe both content growth and the viewport shrinking around the composer. */
export function followTimelineResize(
  content: HTMLElement,
  timeline: HTMLElement,
  following: () => boolean,
  Observer: typeof ResizeObserver = ResizeObserver,
): { destroy(): void } {
  const observer = new Observer(() => {
    if (following()) timeline.scrollTop = timeline.scrollHeight;
    // When reading, leave scrollTop/browser anchoring alone. No layout change
    // is interpreted as an instruction to return to the latest message.
  });
  observer.observe(content);
  observer.observe(timeline);
  return { destroy: () => observer.disconnect() };
}
