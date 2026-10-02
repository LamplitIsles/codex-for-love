// Built-UI acceptance with test-owned services and trusted CDP touch input.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
import { once } from "node:events";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fixture, eventually } from "./fixture.ts";
import { createWebServer } from "../runtime/server.ts";
const f = await fixture();
const session = `cfl-framework7-${process.pid}`;
let app;
let ws;
try {
  const partner = await f.createPartner();
  await partner.submit(crypto.randomUUID(), "Framework7 acceptance fixture");
  await eventually(async () => (await partner.snapshot()).results.length > 0);
  await cp(
    process.env.CFL_TEST_BUILD_DIR ?? new URL("../build/", import.meta.url),
    join(f.directory, "assets"),
    { recursive: true },
  );
  app = createWebServer(partner, join(f.directory, "assets"));
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${app.server.address().port}`;
  await execute("agent-browser", ["--session", session, "open", url]);
  await execute("agent-browser", [
    "--session",
    session,
    "set",
    "viewport",
    "390",
    "844",
  ]);
  await execute("agent-browser", [
    "--session",
    session,
    "wait",
    ".incoming .companion-text-bubble",
  ]);
  ws = new WebSocket(
    (
      await execute("agent-browser", ["--session", session, "get", "cdp-url"], {
        encoding: "utf8",
      })
    ).stdout.trim(),
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let n = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const r = JSON.parse(e.data),
      p = pending.get(r.id);
    if (p) {
      pending.delete(r.id);
      r.error ? p.reject(r.error) : p.resolve(r.result);
    }
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      pending.set(id, { resolve, reject });
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const { targetInfos } = await call("Target.getTargets");
  const target = targetInfos.find(
    (x) => x.type === "page" && x.url.startsWith(url),
  );
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const js = async (expression) => {
    const r = await call(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const touch = (type, points) =>
    call("Input.dispatchTouchEvent", { type, touchPoints: points }, sessionId);
  const p = (x, y, id = 0) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 });
  const tap = async (selector, corner = false) => {
    const r = await js(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
    await touch("touchStart", [p(r.x + (corner ? 12 : r.width / 2), r.y + (corner ? r.height - 12 : r.height / 2))]);
    await wait(40);
    await touch("touchEnd", []);
    await wait(300);
  };
  const mouse = (type, x, y, buttons = 0) => call("Input.dispatchMouseEvent", {
    type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons, clickCount: 1,
  }, sessionId);
  const mouseRect = await js('document.querySelector(".incoming .companion-text-bubble").getBoundingClientRect().toJSON()');
  const mx = mouseRect.x + 25, my = mouseRect.y + 15;
  await mouse("mousePressed", mx, my, 1);
  await wait(550);
  await mouse("mouseReleased", mx, my);
  await wait(300);
  assert.equal(await js('!!document.querySelector(".companion-action-menu.modal-in")'), true, "mouse hold opens official Actions and survives release");
  await js('document.querySelector(".companion-action-menu li:last-child .list-button").click()');
  await wait(400);
  await mouse("mousePressed", mx, my, 1);
  await wait(100);
  await mouse("mouseReleased", mx, my);
  await wait(550);
  assert.equal(await js('!!document.querySelector(".companion-action-menu.modal-in")'), false, "short mouse press cancels hold");
  await mouse("mousePressed", mx, my, 1);
  await mouse("mouseMoved", mx + 25, my, 1);
  await wait(550);
  await mouse("mouseReleased", mx + 25, my);
  assert.equal(await js('!!document.querySelector(".companion-action-menu.modal-in")'), false, "drag cancels mouse hold");
  await call(
    "Emulation.setTouchEmulationEnabled",
    { enabled: true, maxTouchPoints: 5 },
    sessionId,
  );
  await call("Page.reload", {}, sessionId);
  await execute("agent-browser", ["--session", session, "wait", ".incoming .companion-text-bubble"]);
  await wait(300);
  const rect = await js(
    'document.querySelector(".incoming .companion-text-bubble").getBoundingClientRect().toJSON()',
  );
  const x = rect.x + 25,
    y = rect.y + 15;
  await js('document.querySelector("textarea").focus()');
  await touch("touchStart", [p(x, y)]);
  await wait(550);
  await touch("touchEnd", []);
  await wait(300);
  assert.equal(
    await js('!!document.querySelector(".companion-action-menu.modal-in")'),
    true,
  );
  const sheet = await js(`(()=>{const e=document.querySelector('.companion-action-menu');return{rect:e.getBoundingClientRect().toJSON(),buttons:[...e.querySelectorAll('.list-button')].map(b=>b.textContent.trim()),clone:!!document.querySelector('.companion-action-target')}})()`);
  assert.ok(sheet.rect.width < 390 && sheet.rect.bottom < 844, JSON.stringify(sheet));
  assert.equal(await js('document.querySelector(".companion-action-menu").classList.contains("popover-from-actions")'), true);
  assert.ok(sheet.rect.top < rect.bottom + 100, "menu stays near its message");
  assert.deepEqual(sheet.buttons,['Copy message','Cancel']);
  assert.equal(sheet.clone,false);
  assert.equal(await js("getSelection().toString()"), "", "custom press must not select message text");
  await tap(".companion-action-menu li:last-child .list-button");
  await wait(400);
  assert.equal(
    await js('!!document.querySelector(".companion-action-menu.modal-in")'),
    false,
  );
  assert.equal(await js('document.activeElement===document.querySelector("textarea")'),false,"touch menu close must not restore editor focus");
  await touch("touchStart", [p(x, y)]);
  await touch("touchMove", [p(x, y - 30)]);
  await wait(550);
  await touch("touchEnd", []);
  assert.equal(
    await js('!!document.querySelector(".companion-action-menu.modal-in")'),
    false,
  );
  await touch("touchStart", [p(x, y)]);
  await wait(100);
  await touch("touchStart", [p(x, y), p(x + 60, y, 1)]);
  await wait(550);
  await touch("touchEnd", []);
  assert.equal(
    await js('!!document.querySelector(".companion-action-menu.modal-in")'),
    false,
  );
  await js(
    `(async()=>{const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=800;const c=canvas.getContext('2d');c.fillStyle='#468a9c';c.fillRect(0,0,1200,800);c.fillStyle='#f0c95b';c.fillRect(100,100,400,400);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'fixture.png',{type:'image/png'}));const input=document.querySelector('#companion-image-library');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(200);
  await js('document.querySelector("textarea").focus()');
  await wait(300);
  await tap(".companion-image-draft-preview", true);
  await wait(450);
  assert.equal(await js("location.hash"), "#!/image/");
  const imageRect = await js(
    'document.querySelector(".photo-browser-popup .swiper-slide-active img").getBoundingClientRect().toJSON()',
  );
  assert.ok(imageRect.width >= 370);
  const cy = imageRect.y + imageRect.height / 2;
  await mouse("mousePressed", imageRect.x + imageRect.width / 2, cy, 1);
  await wait(550);
  await mouse("mouseReleased", imageRect.x + imageRect.width / 2, cy);
  await wait(300);
  assert.equal(await js('!!document.querySelector(".companion-action-menu.modal-in")'), true, "mouse hold on enlarged image opens save menu");
  assert.equal(await js('!!document.querySelector(".photo-browser-popup.modal-in")'), true, "hold release keeps image preview open");
  await js('document.querySelector(".companion-action-menu li:last-child .list-button").click()');
  await wait(400);
  assert.equal(await js('!!document.querySelector(".companion-action-menu.modal-in")'), false, "image menu cancels before pinch");
  await touch("touchStart", [p(150, cy), p(240, cy, 1)]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [p(150 - i * 7, cy), p(240 + i * 7, cy, 1)]);
    await wait(25);
  }
  await touch("touchEnd", []);
  await wait(300);
  const scale = await js(
    'document.querySelector(".photo-browser-swiper-container").swiper.zoom.scale',
  );
  assert.ok(scale > 2);
  await touch("touchStart", [p(180, cy)]);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [p(180 + i * 10, cy)]);
    await wait(20);
  }
  await touch("touchEnd", []);
  await wait(200);
  assert.equal(
    await js('!!document.querySelector(".photo-browser-popup.modal-in")'),
    true,
  );
  await js(
    'document.querySelector(".photo-browser-swiper-container").swiper.zoom.out()',
  );
  await wait(400);
  await touch("touchStart", [p(195, cy)]);
  await wait(550);
  await touch("touchEnd", []);
  await wait(200);
  assert.equal(
    await js(
      'document.querySelector(".companion-action-menu .list-button").textContent',
    ),
    "Save image",
  );
  await js(
    'HTMLAnchorElement.prototype.click=function(){window.fixtureDownload={name:this.download,url:this.href}}',
  );
  await wait(450);
  await tap(".companion-action-menu .list-button");
  await wait(300);
  assert.equal(await js("window.fixtureDownload.name"), "fixture.png");
  assert.equal(
    await js(
      "(async()=>{const blob=await (await fetch(fixtureDownload.url)).blob();const bitmap=await createImageBitmap(blob);return bitmap.width===1200&&bitmap.height===800})()",
    ),
    true,
  );
  await touch("touchStart", [p(195, cy)]);
  await wait(550);
  await touch("touchEnd", []);
  await wait(200);
  await touch("touchStart", [p(195, 110)]);
  await touch("touchEnd", []);
  await wait(450);
  assert.equal(
    await js('!!document.querySelector(".companion-action-menu")'),
    false,
  );
  assert.equal(
    await js('!!document.querySelector(".photo-browser-popup.modal-in")'),
    true,
  );
  await touch("touchStart", [p(195, 110)]);
  await touch("touchEnd", []);
  await wait(450);
  assert.equal(
    await js('!!document.querySelector(".photo-browser-popup.modal-in")'),
    false,
  );
  assert.equal(await js('document.activeElement===document.querySelector("textarea")'),false,"image close must not restore editor focus");
  await js(
    `(()=>{const original=window.fetch;window.galleryPages=0;window.fetch=async(input,...rest)=>{if(String(input).startsWith('/api/conversation-images')){galleryPages++;return new Response(JSON.stringify({images:Array.from({length:galleryPages===1?180:12},(_,i)=>({id:'gallery-'+galleryPages+'-'+i,filename:'fixture.png',created:Date.now()-i*86400000,origin:'human',available:true,url:fixtureDownload.url})),...(galleryPages===1?{nextCursor:'page-2'}:{})}),{headers:{'content-type':'application/json'}})}return original(input,...rest)}})()`,
  );
  await tap('.companion-history-toggle');
  await wait(400);
  assert.equal(await js('!!document.querySelector(".companion-history-drawer.panel-in")'), true);
  await tap('#companion-images-tab');
  await wait(400);
  const tiles = await js(
    'document.querySelectorAll(".companion-gallery-tile").length',
  );
  assert.ok(
    tiles > 0 && tiles < 180,
    JSON.stringify(
      await js(
        '({tiles:document.querySelectorAll(".companion-gallery-tile").length,pages:galleryPages,height:document.querySelector(".companion-gallery-viewport")?.clientHeight})',
      ),
    ),
  );
  await js(
    '(()=>{const node=document.querySelector(".companion-gallery-viewport");node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event("scroll"))})()',
  );
  await wait(450);
  assert.equal(await js("galleryPages"), 2);
  const tabsBounds = await js(`(()=>{const el=document.querySelector('.companion-diary-tabs');const drawer=document.querySelector('.companion-history-drawer');return {tabs:el.getBoundingClientRect().toJSON(),drawer:drawer.getBoundingClientRect().toJSON(),overflow:[...el.querySelectorAll('.button')].some(b=>b.scrollWidth>b.clientWidth)}})()`);
  assert.ok(tabsBounds.tabs.right <= tabsBounds.drawer.right && !tabsBounds.overflow, JSON.stringify(tabsBounds));
  await tap('.companion-history-controls button');
  await wait(450);
  assert.equal(await js('getComputedStyle(document.querySelector(".companion-history-drawer")).display'), "none");
  await tap('.companion-preferences-trigger');
  await wait(400);
  const preferencesBounds = await js(`(()=>{const el=document.querySelector('.companion-preferences-panel');const rect=el.getBoundingClientRect();return {left:rect.left,right:rect.right,width:el.clientWidth,scroll:el.scrollWidth,viewport:innerWidth}})()`);
  assert.ok(preferencesBounds.left >= 0 && preferencesBounds.right <= preferencesBounds.viewport, JSON.stringify(preferencesBounds));
  assert.ok(preferencesBounds.scroll <= preferencesBounds.width, 'preferences content must wrap within popover');
  await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, sessionId);
  await wait(400);
  await tap('.companion-search-trigger');
  await wait(400);
  assert.equal(await js('!!document.querySelector(".companion-search-dialog.modal-in")'),true);
  const searchLayout = await js(`(()=>{const input=document.querySelector('.companion-search-form input');const button=document.querySelector('.companion-search-submit');return {input:input.getBoundingClientRect().width,button:button.getBoundingClientRect().width}})()`);
  assert.ok(searchLayout.input >= 160 && searchLayout.button <= 100, JSON.stringify(searchLayout));
  await js(`(()=>{const input=document.querySelector('.companion-search-form input');input.value='unmatched fixture query';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await js('document.querySelector(".companion-search-form input").value'), 'unmatched fixture query');
  await tap('.companion-search-back');
  await wait(450);
  assert.equal(await js('!!document.querySelector(".companion-search-dialog.modal-in")'), false);
  assert.equal(await js('(()=>{const input=document.querySelector("#companion-textarea");const r=input.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input})()'), true, "closed overlays must release composer taps");
  await tap('.companion-search-trigger');
  await wait(400);
  await call("Page.reload", {}, sessionId);
  await eventually(async () => { try { return await js('!!document.querySelector("#companion-textarea")'); } catch { return false; } });
  assert.equal(
    await js('!!document.querySelector("#companion-textarea")'),
    true,
  );
  assert.equal(await js("location.hash"), "");
  await js(
    `(()=>{const input=document.querySelector('#companion-textarea');input.value='A longer test-owned conversation message for scrolling. '.repeat(30);input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait(50);
  await tap('.companion-send');
  await eventually(
    async () => (await partner.snapshot()).messages.length === 2,
  );
  await wait(300);
  await js(
    `(()=>{const timeline=document.querySelector('.companion-timeline');timeline.scrollTop=0;timeline.dispatchEvent(new Event('scroll'));const original=window.fetch;window.fetch=(input,...rest)=>String(input)==='/api/messages'?new Promise(()=>{}):original(input,...rest);const input=document.querySelector('#companion-textarea');input.value='Immediate scroll fixture';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait(50);
  await tap('.companion-send');
  await wait(100);
  assert.ok(
    await js(
      `(()=>{const node=document.querySelector('.companion-timeline');return node.scrollHeight-node.clientHeight-node.scrollTop<2})()`,
    ),
  );
  assert.equal(
    await js(
      `[...document.querySelectorAll('.companion-text-bubble')].some(node=>node.textContent.includes('Immediate scroll fixture'))`,
    ),
    true,
  );
  // Initialize Framework7 in a touch-capable environment, as on Android.
  await call("Page.reload", {}, sessionId);
  await execute("agent-browser", ["--session", session, "wait", ".incoming .companion-text-bubble"]);
  await wait(300);
  await tap('.companion-history-toggle');
  await wait(500);
  await touch("touchStart", [p(330, 300)]);
  for (let step = 1; step <= 12; step++) {
    await touch("touchMove", [p(330 - step * 25, 300)]);
    await wait(16);
  }
  await touch("touchEnd", []);
  await wait(500);
  assert.equal(await js('!!document.querySelector(".companion-history-drawer.panel-in")'), false, 'left swipe must close the sidebar');
  assert.equal(await js('document.querySelector(".companion-history-toggle").getAttribute("aria-expanded")'), 'false');
  await touch("touchStart", [p(30, 28)]);
  await touch("touchEnd", []);
  await wait(500);
  const alarmTab = await js('document.querySelector("#companion-alarms-tab").getBoundingClientRect().toJSON()');
  await touch("touchStart", [p(alarmTab.x + alarmTab.width / 2, alarmTab.y + alarmTab.height / 2)]);
  await touch("touchEnd", []);
  await wait(300);
  const refresh = await js(`(()=>{const b=document.querySelector('.companion-alarm-refresh');return {width:b.getBoundingClientRect().width,label:b.getAttribute('aria-label'),text:b.textContent.trim(),icon:!!b.querySelector('svg')}})()`);
  assert.ok(refresh.width===44 && refresh.label && !refresh.text && refresh.icon, JSON.stringify(refresh));
  await touch("touchStart", [p(30, 25)]);
  await touch("touchEnd", []);
  console.log(
    JSON.stringify({
      longPress: true,
      mouseHold: true,
      mouseReleaseCancellation: true,
      mouseDragCancellation: true,
      mouseImageHold: true,
      moveCancellation: true,
      multitouchCancellation: true,
      photoWidth: imageRect.width,
      pinchScale: scale,
      pan: true,
      menuThenPreviewClose: true,
      panelClose: true,
      panelSwipeClose: true,
      compactAlarmRefresh: true,
      searchReload: true,
      galleryVirtualization: true,
      galleryPagination: true,
      originalDownload: true,
      immediateSendScroll: true,
    }),
  );
} finally {
  ws?.close();
  try {
    await execute("agent-browser", ["--session", session, "close"]);
  } finally {
    try { await app?.close(); } finally { await f.close(); }
  }
}
