import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleViewport, followTimelineResize } from '../src/lib/companion/client/viewport.ts';

function viewportFixture(available = true) {
  const properties = new Map<string, string>();
  const node = { style: {
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
  const host = Object.assign(new Events(), {
    visualViewport: available ? viewport : null,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const action = visibleViewport(node, host as unknown as Window);
  return { properties, viewport, frames, host, action, flush() {
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
  assert.equal(native.properties.size, 0);
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
