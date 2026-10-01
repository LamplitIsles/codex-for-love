import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraErrorCode, MediaType } from '@capacitor/camera';
import { captureNativePhoto, dismissNativeKeyboardOnTimelineTap } from '../src/lib/companion/client/native-mobile.ts';

function fixture(available = true, reject = false) {
  let hides = 0, blurs = 0;
  const input = { blur() { blurs++; } } as HTMLTextAreaElement;
  const node = Object.assign(new EventTarget(), {
    ownerDocument: { activeElement: input },
    classList: { contains: () => false },
  }) as unknown as HTMLElement;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const action = dismissNativeKeyboardOnTimelineTap(node, () => input, {
    available: () => available,
    hide: async () => { hides++; if (reject) throw new Error('bridge-failed'); },
  }, {
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => { frames.delete(id); },
  });
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(0); } };
  const send = (type: string, extra: Record<string, unknown> = {}) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    Object.defineProperties(e, Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, { value }])));
    node.dispatchEvent(e); return e;
  };
  return { action, send, node, input, flush, counts: () => ({ hides, blurs }) };
}

test('native blank tap hides the keyboard without blurring, repeatedly', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    assert.equal(f.send('pointerdown').defaultPrevented, true);
    f.send('pointerup'); f.send('click'); f.flush();
  }
  await Promise.resolve();
  assert.deepEqual(f.counts(), { hides: 3, blurs: 0 });
  assert.equal(f.node.ownerDocument.activeElement, f.input);
  f.action.destroy();
  assert.equal(f.send('pointerdown').defaultPrevented, false);
  f.send('pointerup');
  assert.equal(f.counts().hides, 3);
});

test('scroll, drag, cancellation, unrelated content and mouse clicks do not dismiss the keyboard', () => {
  const f = fixture();
  for (const interruption of ['scroll', 'pointercancel', 'pointermove']) {
    f.send('pointerdown');
    f.send(interruption, { clientY: 60 }); f.send('pointerup'); f.send('click'); f.flush();
  }
  const text = { matches: () => false, closest: () => null };
  assert.equal(f.send('pointerdown', { target: text }).defaultPrevented, false);
  f.send('pointerup'); f.send('click', { target: text }); f.flush();
  assert.equal(f.send('pointerdown', { pointerType: 'mouse' }).defaultPrevented, false);
  f.send('pointerup'); f.send('click'); f.flush();
  assert.deepEqual(f.counts(), { hides: 0, blurs: 0 });
  f.action.destroy();
});

test('without a native plugin, normal focus behavior is untouched; bridge rejection permits blur', async () => {
  const browser = fixture(false);
  assert.equal(browser.send('pointerdown').defaultPrevented, false);
  browser.send('pointerup');
  assert.deepEqual(browser.counts(), { hides: 0, blurs: 0 });
  const native = fixture(true, true);
  native.send('pointerdown'); native.send('pointerup'); native.send('click'); native.flush();
  await Promise.resolve();
  assert.deepEqual(native.counts(), { hides: 1, blurs: 1 });
  native.action.destroy();
});

test('native camera result enters the common File path; cancellation is silent and other errors propagate', async () => {
  const file = await captureNativePhoto(async () => ({
    type: MediaType.Photo, saved: false, webPath: 'data:image/jpeg;base64,YWJj',
  }));
  assert.equal(file?.type, 'image/jpeg');
  assert.equal(await file?.text(), 'abc');
  assert.equal(await captureNativePhoto(async () => { throw { code: CameraErrorCode.TakePhotoCancelled }; }), undefined);
  await assert.rejects(captureNativePhoto(async () => { throw new Error('permission-denied'); }), /permission-denied/);
});


test('hide waits past click default handling and is canceled on unmount or focus change', () => {
  const f = fixture();
  f.send('pointerdown'); f.send('pointerup');
  assert.equal(f.counts().hides, 0);
  f.send('click');
  assert.equal(f.counts().hides, 0);
  f.flush();
  assert.equal(f.counts().hides, 1);
  f.send('pointerdown'); f.send('pointerup'); f.send('click');
  f.action.destroy(); f.flush();
  assert.equal(f.counts().hides, 1);
  const changed = fixture();
  changed.send('pointerdown'); changed.send('pointerup'); changed.send('click');
  Object.assign(changed.node.ownerDocument, { activeElement: null });
  changed.flush(); assert.equal(changed.counts().hides, 0);
  changed.action.destroy();
});

test('visual whitespace in row and stack containers dismisses', () => {
  const f = fixture();
  for (const css of ['companion-row', 'companion-message-stack']) {
    const target = { matches: (selector: string) => selector.includes(css), closest: () => null };
    assert.equal(f.send('pointerdown', { target }).defaultPrevented, true);
    f.send('pointerup', { target }); f.send('click', { target }); f.flush();
  }
  assert.equal(f.counts().hides, 2);
  f.action.destroy();
});


test('message text dismisses, but links and message buttons keep their own behavior', () => {
  const f = fixture();
  const text = { matches: () => false, closest: (selector: string) => selector === '.companion-text-bubble' ? {} : null };
  assert.equal(f.send('pointerdown', { target: text }).defaultPrevented, true);
  f.send('pointerup', { target: text }); f.send('click', { target: text }); f.flush();
  assert.equal(f.counts().hides, 1);
  for (const control of ['a', 'button']) {
    const target = { matches: () => false, closest: (selector: string) => selector !== '.companion-message-copy' && selector.split(', ').includes(control) ? {} : null };
    assert.equal(f.send('pointerdown', { target }).defaultPrevented, false);
    f.send('pointerup', { target }); f.send('click', { target }); f.flush();
  }
  assert.equal(f.counts().hides, 1);
  f.action.destroy();
});


test('copy icon taps hide after click while retaining composer focus', () => {
  const f = fixture();
  const icon = { matches: () => false, closest: (selector: string) => selector === '.companion-message-copy' ? {} : null };
  assert.equal(f.send('pointerdown', { target: icon }).defaultPrevented, true);
  f.send('pointerup', { target: icon }); f.send('click', { target: icon });
  assert.equal(f.counts().hides, 0);
  f.flush();
  assert.deepEqual(f.counts(), { hides: 1, blurs: 0 });
  f.action.destroy();
});
