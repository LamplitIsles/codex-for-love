// Built-UI acceptance with injected geometry, never real OS keyboard evidence.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { cp, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture, eventually } from './fixture.ts';
import { createWebServer } from '../runtime/server.ts';

const f = await fixture();
const session = `cfl-mobile-${process.pid}`;
let app;
const browser = async (...args) => {
  const value = JSON.parse((await execute('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8' })).stdout);
  assert.equal(value.success, true, JSON.stringify(value));
  return value.data;
};
const evaluate = async code => (await browser('eval', '--base64', Buffer.from(code).toString('base64'))).result;
const monotonic = (previous, current, opening) => {
  for (const [index,bottom] of [current.input.bottom,...current.controls].entries()) {
    const before=[previous.input.bottom,...previous.controls][index];
    assert.ok(opening ? bottom<=before : bottom>=before, `control ${index} reversed: ${before} -> ${bottom}`);
  }
};
const settle = async () => await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))))');
try {
  await cp(new URL('../build/', import.meta.url), join(f.directory, 'assets'), { recursive: true });
  const partner = await f.createPartner();
  for (let i = 0; i < 12; i++) {
    await partner.submit(crypto.randomUUID(), `Fixture round ${i}: ${'A mobile conversation for reading and following. '.repeat(8)}`);
    await eventually(async () => (await partner.snapshot()).results?.length === i + 1);
  }
  app = createWebServer(partner, join(f.directory, 'assets'));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const init = join(f.directory, 'browser-init.js');
  await writeFile(init, `
    const keyboard = Object.assign(new EventTarget(), { overlaysContent:false, boundingRect:{x:0,y:0,width:0,height:0} });
    Object.defineProperty(navigator, 'virtualKeyboard', { value:location.search ? undefined : keyboard });
    window.fixtureKeyboard = keyboard;
    {
      window.fixtureViewport = Object.assign(new EventTarget(), {height:innerHeight,offsetTop:0,scale:1});
      Object.defineProperty(window, 'visualViewport', {value:window.fixtureViewport});
    }
  `);
  await browser('--init-script', init, 'open', url);
  await browser('set', 'viewport', '390', '844');
  await browser('reload');
  await browser('wait', '.companion-textarea');
  // Copy a test-owned message through the real UI, without touching the OS clipboard.
  await evaluate(`(() => {
    window.fixtureCopies=[];
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{
      writeText:async text=>window.fixtureCopies.push(text)
    }});
  })()`);
  await browser('click', '.companion-message-copy'); await settle();
  const copied = await evaluate(`({text:fixtureCopies[0],label:document.querySelector('.companion-copy-toast').textContent.trim(),rect:(()=>{const r=document.querySelector('.companion-message-copy').getBoundingClientRect();return {width:r.width,height:r.height}})()})`);
  assert.match(copied.text, /^fixture reply /);
  assert.equal(await evaluate(`document.querySelectorAll('.companion-row.outgoing .companion-message-copy').length`), 0);
  assert.ok(await evaluate(`document.querySelectorAll('.companion-row.incoming .companion-message-copy').length`) > 0);
  assert.equal(copied.label, 'Copied');
  assert.equal(await evaluate(`document.querySelector('.companion-copy-toast').getBoundingClientRect().bottom < document.querySelector('.companion-composer').getBoundingClientRect().top`), true);
  assert.equal(await evaluate(`document.querySelector('.companion-message-copy').textContent.trim()`), '');
  assert.ok(copied.rect.width >= 44 && copied.rect.height >= 44);
  await evaluate(`navigator.clipboard.writeText=async()=>{throw new Error('denied')}`);
  await browser('click', '.companion-message-copy'); await settle();
  assert.equal(await evaluate(`document.querySelector('.companion-copy-toast').textContent.trim()`), 'Copy failed. Try again.');
  await evaluate(`new Promise(resolve=>setTimeout(resolve,2100))`);
  assert.equal(await evaluate(`document.querySelector('.companion-copy-toast')===null`), true);
  await evaluate(`(() => {const timeline=document.querySelector('.companion-timeline');timeline.scrollTop=timeline.scrollHeight;timeline.dispatchEvent(new Event('scroll'));})()`); await settle();
  // Inject browser env equivalents into CSSOM: a JS keyboard mock cannot set
  // the actual browser/OS environment variables. This is explicitly synthetic.
  await evaluate(`(() => {
    function rewrite(rules) { for(const rule of rules) {
      if(rule.style) for(const key of [...rule.style]) {
        const value = rule.style.getPropertyValue(key);
        if(value.includes('env(keyboard-inset-height')) rule.style.setProperty(key, value.replaceAll('env(keyboard-inset-height,0px)', 'var(--fixture-keyboard-height,0px)'));
      }
      if(rule.cssRules) rewrite(rule.cssRules);
    }}
    for(const sheet of document.styleSheets) rewrite(sheet.cssRules);
    const root = document.querySelector('#dsh-companion');
    root.style.setProperty('--companion-system-safe-area','40px');
    window.fixtureSet = (height, y = innerHeight-height, x = 0, width = innerWidth, notify = true) => {
      root.style.setProperty('--fixture-keyboard-height', height+'px');
      fixtureKeyboard.boundingRect = {x,y,width,height};
      if(notify) fixtureKeyboard.dispatchEvent(new Event('geometrychange'));
    };
    window.fixtureMeasure = () => {
      const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
      const timeline=document.querySelector('.companion-timeline');
      const probe=document.createElement('span'); probe.style.cssText='position:absolute;visibility:hidden;padding-bottom:var(--companion-bottom-safe-area)'; root.append(probe);
      const safe=parseFloat(getComputedStyle(probe).paddingBottom); probe.remove();
      return {header:rect('.companion-header'), composer:rect('.companion-composer'), input:rect('.companion-textarea'), controls:[...document.querySelectorAll('.companion-compose-row button')].map(button=>button.getBoundingClientRect().bottom), timeline:rect('.companion-timeline'), safe, padding:parseFloat(getComputedStyle(document.querySelector('.companion-composer')).paddingBottom), gap:timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop, scroll:timeline.scrollTop};
    };
  })()`);
  await evaluate('document.querySelector(".companion-textarea").focus()'); await settle();
  const closed = await evaluate('fixtureMeasure()'); assert.equal(closed.safe, 40);
  assert.equal(closed.padding, 40); assert.equal(closed.header.top, 0);
  let previous = closed, previousHeight = 0;
  for (const height of [0, 1, 4, 12, 24, 40, 80, 160, 240, 364, 240, 160, 80, 40, 24, 12, 4, 1, 0]) {
    // Before geometrychange, CSS alone must already move composer + safe area.
    await evaluate(`fixtureSet(${height}, innerHeight-${height}, 0, innerWidth, false)`); await settle();
    const measure = await evaluate('fixtureMeasure()');
    assert.equal(measure.composer.bottom, 844-height);
    assert.equal(measure.header.top, 0);
    assert.equal(measure.safe, Math.max(0, 40-height));
    assert.equal(measure.padding, Math.max(14, 40-height));
    assert.ok(measure.timeline.height > 0); assert.ok(Math.abs(measure.gap) < 2);
    await evaluate("fixtureKeyboard.dispatchEvent(new Event('geometrychange'))"); await settle();
    assert.deepEqual(await evaluate('fixtureMeasure()'), measure);
    monotonic(previous, measure, height >= previousHeight);
    console.log('CSS-INSET', height, JSON.stringify({input:measure.input.bottom,controls:measure.controls,safe:measure.safe,padding:measure.padding}));
    previous = measure; previousHeight = height;
  }
  await evaluate(`document.querySelector('.companion-timeline').scrollTop=160; document.querySelector('.companion-timeline').dispatchEvent(new Event('scroll'))`); await settle();
  for(const height of [160,364,0]) {
    await evaluate(`fixtureSet(${height})`); await settle();
    assert.equal(await evaluate('fixtureMeasure().scroll'),160);
  }
  await partner.submit(crypto.randomUUID(), 'Fixture incoming while reading');
  await eventually(async () => (await partner.snapshot()).results?.length === 13);
  await settle(); assert.equal(await evaluate('fixtureMeasure().scroll'),160);
  const latest = await evaluate(`(() => { const b=document.querySelector('.companion-return-latest'); return b ? {width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height} : null; })()`);
  assert.ok(latest && latest.width >= 44 && latest.height >= 44);
  await browser('click', '.companion-return-latest'); await settle(); assert.ok(Math.abs(await evaluate('fixtureMeasure().gap')) < 2);
  await evaluate('fixtureSet(200,400,60,250)'); await settle();
  assert.equal(await evaluate('fixtureMeasure().composer.bottom'),400);
  await evaluate('fixtureSet(200,400,400,250)'); await settle();
  assert.equal(await evaluate('fixtureMeasure().composer.bottom'),844);
  await evaluate('fixtureSet(0)'); await settle();
  previous = await evaluate('fixtureMeasure()'); previousHeight = 0;
  for (const height of [1,4,12,24,40,80,40,24,12,4,1,0]) {
    await evaluate(`fixtureSet(${height},innerHeight-${height},0,innerWidth,false); fixtureKeyboard.boundingRect.height=${height/2}; fixtureKeyboard.dispatchEvent(new Event('geometrychange'))`); await settle();
    const measure=await evaluate('fixtureMeasure()');
    assert.equal(measure.composer.bottom,844-height); assert.equal(measure.safe,Math.max(0,40-height));
    monotonic(previous,measure,height>=previousHeight); previous=measure; previousHeight=height;
  }
  await evaluate('fixtureViewport.scale=2; fixtureViewport.height=240; fixtureViewport.dispatchEvent(new Event("resize"))'); await settle();
  assert.equal(await evaluate('fixtureMeasure().composer.bottom'),844);
  assert.equal(await evaluate('fixtureMeasure().safe'),40);
  await evaluate('fixtureViewport.scale=1; fixtureViewport.height=844; fixtureViewport.dispatchEvent(new Event("resize"))'); await settle();
  console.log('Closed and continuous geometry:', JSON.stringify(closed));
  // Native input capture preference, long press routing, cancellation and File intake.
  const before = (await partner.snapshot()).messages.length;
  assert.deepEqual(await evaluate(`(() => {
    const capture=document.querySelector('#companion-image-capture'), library=document.querySelector('#companion-image-library');
    window.captureClicks=0; window.libraryClicks=0;
    capture.click=()=>captureClicks++; library.click=()=>libraryClicks++;
    return [capture.getAttribute('capture'), capture.multiple, library.multiple];
  })()`), ['environment', false, true]);
  await evaluate(`document.querySelector('.companion-attach').dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,pointerType:'touch',bubbles:true}))`);
  await new Promise(resolve => setTimeout(resolve, 650));
  await evaluate(`const b=document.querySelector('.companion-attach'); b.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,pointerType:'touch',bubbles:true})); b.click(); document.querySelector('#companion-image-capture').dispatchEvent(new Event('cancel'));`);
  assert.deepEqual(await evaluate('[captureClicks,libraryClicks,document.querySelectorAll(".companion-image-draft").length]'), [1,0,0]);
  assert.equal((await partner.snapshot()).messages.length, before);
  await evaluate('document.querySelector(".companion-attach").click()');
  assert.equal(await evaluate('libraryClicks'),1);
  await evaluate(`const input=document.querySelector('#companion-image-capture'); const transfer=new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'camera.png',{type:'image/png'})); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));`);
  await settle();
  assert.equal(await evaluate('document.querySelectorAll(".companion-image-draft").length'),1);
  await evaluate('document.querySelector("#companion-image-capture").dispatchEvent(new Event("cancel"))');
  assert.equal(await evaluate('document.querySelectorAll(".companion-image-draft").length'),1);
  assert.equal((await partner.snapshot()).messages.length,before);
  if(process.argv[2]) await browser('screenshot', process.argv[2]);
  for(const [width,height] of [[320,700],[1280,900]]) {
    await browser('set','viewport',String(width),String(height)); await settle();
    const m=await evaluate('fixtureMeasure()'); assert.equal(m.header.top,0); assert.equal(m.composer.bottom,height); assert.ok(m.timeline.height>0);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    if(width===1280) {
      previous=m; previousHeight=0;
      for(const inset of [0,1,4,12,24,40,80,40,24,12,4,1,0]) {
        await evaluate(`fixtureSet(${inset})`); await settle();
        const measure=await evaluate('fixtureMeasure()');
        assert.equal(measure.composer.bottom,height-inset); assert.equal(measure.padding,Math.max(24,40-inset));
        monotonic(previous,measure,inset>=previousHeight); previous=measure; previousHeight=inset;
      }
    }
  }
  await browser('screenshot', join(f.directory,'mobile.png'));
  await browser('set','viewport','390','844'); await browser('open',url+'/?native'); await browser('wait','.companion-textarea');
  await evaluate(`document.querySelector('#dsh-companion').style.setProperty('--companion-system-safe-area','40px'); document.querySelector('.companion-textarea').focus();`); await settle();
  previous = undefined; previousHeight = 0;
  for(const covered of [0,1,4,12,24,40,80,364,80,40,24,12,4,1,0]) {
    await evaluate(`fixtureViewport.height=${844-covered}; fixtureViewport.dispatchEvent(new Event('resize'))`); await settle();
    const measure=await evaluate(`({composer:{bottom:document.querySelector('.companion-composer').getBoundingClientRect().bottom},input:{bottom:document.querySelector('.companion-textarea').getBoundingClientRect().bottom},controls:[...document.querySelectorAll('.companion-compose-row button')].map(button=>button.getBoundingClientRect().bottom),padding:parseFloat(getComputedStyle(document.querySelector('.companion-composer')).paddingBottom)})`);
    assert.equal(measure.composer.bottom,844-covered); assert.equal(measure.padding,Math.max(14,40-covered));
    if(previous) monotonic(previous,measure,covered>=previousHeight);
    console.log('NATIVE-INSET',covered,JSON.stringify(measure)); previous=measure; previousHeight=covered;
  }
  console.log('PASS: built UI 390×844 / 320×700 / desktop, CSS env equivalents before geometry notification, floating/out-of-chat, focused close, native fallback, follow/read/return, capture/cancel/File preview. Synthetic geometry only; OS animation/install/permissions unverified.');
} finally {
  try { await browser('close'); } finally { await app?.close(); await f.close(); }
}
