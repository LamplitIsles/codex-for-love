import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleViewport, followTimelineResize } from '../src/lib/companion/client/viewport.ts';

function viewportFixture(available = true, overlay = false) {
  const attributes = new Set<string>();
  let focused = false;
  const properties = new Map<string, string>();
  const node = {
    setAttribute: (key: string) => attributes.add(key),
    removeAttribute: (key: string) => attributes.delete(key),
    contains: () => true,
    getBoundingClientRect: () => ({ left: 0, right: 390 }),
    querySelector: (selector: string) => ({ getBoundingClientRect: () => selector === '.companion-header' ? { bottom: 78 } : { left: 0, right: 390 } }),
    style: {
    setProperty: (key: string, value: string) => properties.set(key, value),
    removeProperty: (key: string) => properties.delete(key),
  } } as unknown as HTMLElement;
  class Events extends EventTarget {
    listeners = 0;
    override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
      this.listeners++; super.addEventListener(...args);
    }
    override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
      this.listeners--; super.removeEventListener(...args);
    }
  }
  const viewport = Object.assign(new Events(), { height: 844, offsetTop: 0, scale: 1 });
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const keyboard = Object.assign(new Events(), { overlaysContent: false, boundingRect: { x: 0, y: 0, width: 0, height: 0 } });
  const document = Object.defineProperty(new Events(), 'activeElement', { get: () => focused ? { matches: () => true } : null });
  const host = Object.assign(new Events(), {
    innerHeight: 844, innerWidth: 390, document,
    navigator: { virtualKeyboard: overlay ? keyboard : undefined },
    visualViewport: available ? viewport : null,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const action = visibleViewport(node, host as unknown as Window);
  return { properties, attributes, keyboard, document, viewport, frames, host, action, focus(value = true) { focused = value; document.dispatchEvent(new Event('focusin')); }, flush() {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
  } };
}

test('visible area shrink, pan and close use measured geometry without cumulative subtraction', () => {
  const f = viewportFixture();
  assert.equal(f.properties.get('--companion-visible-height'), '844px');
  f.viewport.height = 480;
  f.viewport.offsetTop = 32;
  f.viewport.dispatchEvent(new Event('resize'));
  f.viewport.dispatchEvent(new Event('scroll'));
  f.host.dispatchEvent(new Event('resize'));
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.properties.get('--companion-visible-height'), '480px');
  assert.equal(f.properties.get('--companion-visible-top'), '32px');
  f.host.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.get('--companion-visible-height'), '480px');
  f.viewport.height = 844; f.viewport.offsetTop = 0;
  f.viewport.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.get('--companion-visible-height'), '844px');
  assert.equal(f.properties.get('--companion-visible-top'), '0px');
  f.action.destroy();
});

test('zoom uses native layout and unzoom restores adaptation; missing API stays native', () => {
  const f = viewportFixture();
  f.viewport.scale = 2; f.viewport.height = 240;
  f.viewport.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.size, 0);
  f.viewport.scale = 1;
  f.viewport.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.get('--companion-visible-height'), '240px');
  f.action.destroy();
  const native = viewportFixture(false);
  native.host.dispatchEvent(new Event('resize')); native.flush();
  assert.equal(native.properties.get('--companion-bottom-safe-area'), 'max(0px, calc(var(--companion-system-safe-area) - 0px))');
  native.action.destroy();
});

test('unmount removes listeners, pending frames and local styles', () => {
  const f = viewportFixture();
  f.viewport.dispatchEvent(new Event('resize'));
  f.action.destroy();
  assert.equal(f.host.listeners, 0);
  assert.equal(f.viewport.listeners, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.properties.size, 0);
  f.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(f.frames.size, 0);
});

test('timeline resize follows latest for both geometry and content; readers retain scroll position', () => {
  let notify: () => void = () => {};
  const observed: unknown[] = [];
  let disconnected = false;
  class Observer {
    constructor(callback: () => void) { notify = callback; }
    observe(node: unknown) { observed.push(node); }
    disconnect() { disconnected = true; }
  }
  const timeline = { scrollTop: 400, scrollHeight: 1000, clientHeight: 600 };
  const content = {} as HTMLElement;
  let following = true;
  const action = followTimelineResize(content, timeline as HTMLElement, () => following, Observer as unknown as typeof ResizeObserver);
  assert.deepEqual(observed, [content, timeline]);
  timeline.clientHeight = 300; notify();
  assert.equal(timeline.scrollTop, 1000);
  following = false; timeline.scrollTop = 160;
  timeline.clientHeight = 200; notify();
  assert.equal(timeline.scrollTop, 160);
  timeline.scrollHeight += 200; notify();
  assert.equal(timeline.scrollTop, 160);
  timeline.clientHeight = 600; notify();
  assert.equal(timeline.scrollTop, 160);
  following = true; notify();
  assert.equal(timeline.scrollTop, 1200);
  action.destroy(); assert.equal(disconnected, true);
});

test('overlay geometry owns avoidance, restores safe area while focused, and releases global state', () => {
  const f = viewportFixture(true, true);
  assert.equal(f.keyboard.overlaysContent, true);
  f.focus(); f.flush();
  assert.equal(f.properties.has('--companion-bottom-safe-area'), false);
  for (const height of [1, 4, 12, 24, 40, 100, 364, 100, 40, 24, 12, 4, 1, 0]) {
    f.keyboard.boundingRect = { x: 0, y: 844 - height, width: 390, height: height / 2 };
    f.viewport.height = 480; f.viewport.offsetTop = 32;
    f.keyboard.dispatchEvent(new Event('geometrychange'));
    assert.equal(f.frames.size, 1); f.flush();
    assert.equal(f.properties.get('--companion-keyboard-space'), height ? `${height}px` : undefined);
    assert.equal(f.properties.has('--companion-visible-height'), false);
    assert.equal(f.properties.has('--companion-visible-top'), false);
    assert.equal(f.properties.has('--companion-bottom-safe-area'), false);
  }
  f.keyboard.boundingRect = { x: 60, y: 400, width: 250, height: 200 };
  f.keyboard.dispatchEvent(new Event('geometrychange')); f.flush();
  assert.equal(f.properties.get('--companion-keyboard-space'), '444px');
  f.keyboard.boundingRect.x = 400;
  f.keyboard.dispatchEvent(new Event('geometrychange')); f.flush();
  assert.equal(f.properties.get('--companion-keyboard-space'), '0px');
  assert.equal(f.properties.has('--companion-bottom-safe-area'), false);
  f.keyboard.dispatchEvent(new Event('geometrychange')); f.action.destroy();
  assert.equal(f.keyboard.overlaysContent, false);
  assert.equal(f.keyboard.listeners + f.document.listeners + f.host.listeners + f.viewport.listeners, 0);
  assert.equal(f.frames.size + f.properties.size + f.attributes.size, 0);
});

test('CSS owns closed and docked geometry without JS height or safe-area overrides', () => {
  const f = viewportFixture(true, true);
  assert.equal(f.attributes.has('data-keyboard-overlay'), true);
  assert.equal(f.properties.size, 0);
  f.keyboard.boundingRect = { x: 0, y: 480, width: 390, height: 364 };
  f.keyboard.dispatchEvent(new Event('geometrychange')); f.flush();
  assert.equal(f.properties.size, 0);
  f.viewport.scale = 2; f.viewport.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.attributes.size, 0); assert.equal(f.properties.size, 0);
  f.action.destroy();
});

test('fallback uses measured resize once; focus alone, focused close and zoom retain system safe area', () => {
  const f = viewportFixture();
  f.focus(); f.flush();
  assert.equal(f.properties.get('--companion-bottom-safe-area'), 'max(0px, calc(var(--companion-system-safe-area) - 0px))');
  f.host.innerHeight = 480; f.viewport.height = 480;
  f.host.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.get('--companion-visible-height'), '480px');
  assert.equal(f.properties.get('--companion-bottom-safe-area'), 'max(0px, calc(var(--companion-system-safe-area) - 364px))');
  f.host.innerHeight = 844; f.viewport.height = 844;
  f.host.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.get('--companion-bottom-safe-area'), 'max(0px, calc(var(--companion-system-safe-area) - 0px))');
  f.viewport.height = 480; f.viewport.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.get('--companion-bottom-safe-area'), 'max(0px, calc(var(--companion-system-safe-area) - 364px))');
  f.viewport.scale = 2; f.viewport.dispatchEvent(new Event('resize')); f.flush();
  assert.equal(f.properties.size, 0);
  f.action.destroy();
});

test('native and visual resize reduce safe area by covered distance without double avoidance', () => {
  for (const mode of ['visual', 'native', 'layout']) {
    const f = viewportFixture(mode !== 'layout'); f.focus(); f.flush();
    for (const covered of [0, 1, 4, 12, 24, 40, 80, 40, 24, 12, 4, 1, 0]) {
      f.viewport.height = 844 - covered;
      if (mode !== 'visual') f.host.innerHeight = f.viewport.height;
      f.host.dispatchEvent(new Event('resize')); f.flush();
      assert.equal(f.properties.get('--companion-visible-height'), mode === 'layout' ? undefined : `${844 - covered}px`);
      assert.equal(f.properties.get('--companion-bottom-safe-area'), `max(0px, calc(var(--companion-system-safe-area) - ${covered}px))`);
    }
    f.action.destroy();
  }
});
