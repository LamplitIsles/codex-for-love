import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureReadingFocus, dismissComposerOnTimelineTap } from '../src/lib/companion/client/reading-focus.ts';

test('reading overlays release editors but preserve a keyboard navigation control', () => {
  for (const editor of [true, false]) {
    let blurs = 0;
    const active = { matches: () => editor, blur() { blurs++; } };
    const document = { activeElement: active, body: {} } as unknown as Document;
    assert.equal(captureReadingFocus(document), editor ? undefined : active);
    assert.equal(blurs, editor ? 1 : 0);
  }
});
function fixture() {
  let blurs = 0;
  const input = { blur() { blurs++; } } as HTMLTextAreaElement;
  const node = Object.assign(new EventTarget(), { ownerDocument: { activeElement: input } }) as unknown as HTMLElement;
  const action = dismissComposerOnTimelineTap(node, () => input);
  const send = (type: string, extra: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    Object.defineProperties(event, Object.fromEntries(Object.entries(extra).map(([key,value])=>[key,{value}])));
    node.dispatchEvent(event);
    return event;
  };
  return { send, action, blurs: () => blurs };
}
test('timeline tap releases editor without suppressing pointer behavior; unmount removes listeners', () => {
  const f = fixture();
  assert.equal(f.send('pointerdown').defaultPrevented, false);
  f.send('pointerup');f.send('click');assert.equal(f.blurs(),1);
  f.action.destroy();f.send('pointerdown');f.send('pointerup');f.send('click');assert.equal(f.blurs(),1);
});
test('scroll, drag, cancellation and interactive controls do not dismiss editing', () => {
  const f = fixture();
  for (const interruption of ['scroll', 'pointercancel', 'pointermove']) {
    f.send('pointerdown');f.send(interruption,{clientY:60});f.send('pointerup');f.send('click');
  }
  const button = { closest: () => ({}) };
  f.send('pointerdown',{target:button});f.send('pointerup',{target:button});f.send('click',{target:button});
  assert.equal(f.blurs(),0);f.action.destroy();
});
