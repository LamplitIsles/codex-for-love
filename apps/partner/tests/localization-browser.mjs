// Locale switching and framework-owned controls against a test-owned Partner.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const execute=promisify(execFile),f=await fixture(),session=`cfl-localization-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
const settle=()=>js('new Promise(r=>setTimeout(r,450))');
try{
 const partner=await f.createPartner();await partner.submit(crypto.randomUUID(),'generate image');await eventually(async()=>(await partner.snapshot()).pendingCount===0);
 app=createWebServer(partner,resolve(process.env.CFL_TEST_BUILD_DIR??'apps/partner/build'));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','#companion-textarea');
 await settle();
 const timestamps=await js(`Array.from(document.querySelectorAll('.companion-message-time'),time=>{const row=time.closest('.companion-row'),bubble=row.querySelector('.message-bubble'),avatar=row.querySelector('.message-avatar'),footer=time.closest('.message-footer');return {external:!!footer&&!time.closest('.message-bubble'),colorMatches:!!footer&&getComputedStyle(time).color===getComputedStyle(footer).color,delta:avatar.getBoundingClientRect().top-bubble.getBoundingClientRect().top,below:time.getBoundingClientRect().top>=bubble.getBoundingClientRect().bottom,last:row.classList.contains('message-last'),count:row.querySelectorAll('.companion-message-time').length}})`);
 assert.ok(timestamps.length>=2,'fixture exposes incoming and outgoing timestamps');
 for(const time of timestamps){assert.equal(time.external,true,'timestamp uses the official footer outside the bubble');assert.ok(Math.abs(time.delta)<1,JSON.stringify(time));assert.equal(time.below,true,'timestamp clears both text and image bubbles');assert.equal(time.last,true,'only the last part has a timestamp');assert.equal(time.count,1);assert.equal(time.colorMatches,true,'timestamp inherits the footer text color');}
 const checkContrast=async()=>{
  const colors=await js(`(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};return [...document.querySelectorAll('.companion-row .message-bubble')].map(b=>{const c=getComputedStyle(b);return{foreground:rgb(c.color),background:rgb(c.backgroundColor)}})})()`);
  const luminance=color=>{const c=color.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722};
  for(const color of colors){const a=luminance(color.foreground),b=luminance(color.background);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,'bubble text remains readable: '+JSON.stringify(color));}
 };
 await checkContrast();
 if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/chat-light.png');
 const targets=await js(`['.companion-context-meter','.companion-preferences-trigger'].map(selector=>document.querySelector(selector).getBoundingClientRect().toJSON())`);
 for(const target of targets){assert.ok(target.width>=44&&target.height>=44,'header target is easy to tap: '+JSON.stringify(target));}
 await browser('click','.companion-preferences-trigger');await browser('wait','.companion-preferences-panel.modal-in');await settle();
 const rows=await js(`Array.from(document.querySelectorAll('.companion-preferences-panel label.item-radio'),row=>{const r=row.getBoundingClientRect(),panel=row.closest('.popover').getBoundingClientRect();return {height:r.height,inside:r.left>=panel.left&&r.right<=panel.right&&r.top>=panel.top&&r.bottom<=panel.bottom}})`);
 assert.equal(rows.length,5);for(const row of rows){assert.ok(row.height>=44,'radio row is easy to tap');assert.equal(row.inside,true,'radio row is visible inside the popover');}
 for(const value of ['dark','light','system']){await browser('click',`label:has(input[name=companion-appearance][value=${value}]) .item-title`);await settle();assert.equal(await js('localStorage.getItem("her.companion.appearance")'),value,'clicking the row title selects theme');assert.equal(await js('!!document.querySelector(".companion-preferences-panel.modal-in")'),true);await checkContrast();
  const theme=await js(`(()=>{const surface=getComputedStyle(document.querySelector('.companion-preferences-panel')).backgroundColor;return{surface,header:getComputedStyle(document.querySelector('.companion-header .navbar-bg')).backgroundColor,input:getComputedStyle(document.querySelector('#companion-textarea')).color,text:getComputedStyle(document.querySelector('#dsh-companion')).color,rows:[...document.querySelectorAll('.companion-preferences-panel .item-title')].map(e=>getComputedStyle(e).color)}})()`);
  assert.equal(theme.header,theme.surface,'header and popover share the surface palette');assert.equal(theme.input,theme.text,'input and chat share the text palette');for(const color of theme.rows)assert.equal(color,theme.text,'settings use the shared text palette');
  if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/palette-'+value+'.png');
 }
 if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/chat-theme-settings.png');
 await browser('press','Escape');await settle();
 await browser('click','.companion-context-meter');await browser('wait','.companion-context-popover.modal-in');await settle();
 if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/context-summary.png');
 const context=await js(`(()=>{const el=document.querySelector('.companion-context-popover'),r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right,width:innerWidth,height:innerHeight,contentInside:[...el.querySelectorAll('p')].every(e=>{const x=e.getBoundingClientRect();return x.left>=r.left&&x.right<=r.right&&x.bottom<=r.bottom})}})()`);
 assert.equal(await js(`document.querySelector('.companion-context-summary').getClientRects().length`),1);
 assert.equal(await js(`(()=>{const p=document.querySelector('.companion-context-summary'),range=document.createRange();range.selectNodeContents(p);return range.getBoundingClientRect().height<=parseFloat(getComputedStyle(p).lineHeight)+1})()`),true,'context capacity fits one line');
 assert.ok(context.top>=0&&context.bottom<=context.height&&context.right<=context.width&&context.contentInside,JSON.stringify(context));await browser('press','Escape');await settle();
 await js(`(()=>{window.galleryMode='empty';const original=window.fetch;window.fetch=(input,...rest)=>String(input).startsWith('/api/conversation-images')?Promise.resolve(galleryMode==='error'?new Response('{}',{status:503}):Response.json({images:[]})):original(input,...rest)})()`);
 const language=async index=>{await browser('click','.companion-preferences-trigger');await browser('wait','.companion-preferences-panel.modal-in');await settle();await browser('click',`label:has(input[name=companion-language][value=${index===0?'zh':'en'}]) .item-title`);await settle();await browser('press','Escape');await settle()};
 await language(0);assert.equal(await js('document.documentElement.lang'),'zh-Hans');
 await browser('click','.companion-history-toggle');await browser('wait','.companion-history-drawer.panel-in');await settle();
 assert.deepEqual(await js(`[...document.querySelectorAll('.companion-diary-tabs [role=tab]')].map(b=>b.textContent.trim())`),['关系历史','日记','相册','自动唤醒']);
 const checkTabs=async()=>{
  const tabs=await js(`[...document.querySelectorAll('.companion-diary-tabs [role=tab]')].map(b=>{const r=b.getBoundingClientRect(),icon=b.querySelector('svg').getBoundingClientRect(),label=b.querySelector('span').getBoundingClientRect();return{top:r.top,left:r.left,right:r.right,height:r.height,width:r.width,iconAbove:icon.bottom<=label.top,inside:label.left>=r.left&&label.right<=r.right&&label.bottom<=r.bottom,selected:b.getAttribute('aria-selected')==='true',background:getComputedStyle(b).backgroundColor}})`);
  assert.equal(tabs.length,4);for(const tab of tabs){assert.ok(tab.width>=44&&tab.height>=44);assert.equal(tab.top,tabs[0].top,'four tabs share one row');assert.equal(tab.iconAbove,true);assert.equal(tab.inside,true,'label stays inside tab');}
  assert.equal(tabs.filter(t=>t.selected).length,1);assert.notEqual(tabs.find(t=>t.selected).background,'rgba(0, 0, 0, 0)');
 };
 for(const width of [320,390,1024]){await browser('set','viewport',String(width),'844');await settle();await checkTabs();}
 await browser('set','viewport','390','844');await settle();
 if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/sidebar-zh.png');
 await browser('click','#companion-images-tab');await settle();assert.equal(await js(`document.querySelector('.companion-gallery .companion-history-state').textContent.trim()`),'还没有聊天图片。');
 await js(`galleryMode='error'`);await browser('click','#companion-images-tab');await settle();assert.equal(await js(`document.querySelector('.companion-gallery [role=alert] p').textContent.trim()`),'图片库暂时无法读取。');assert.equal(await js(`document.querySelector('.companion-gallery [role=alert] button').textContent.trim()`),'重试');
 await browser('click','.companion-history-controls button');await settle();
 await js(`document.querySelector('.incoming .companion-text-bubble').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2}))`);await browser('wait','.companion-action-menu.modal-in');await settle();assert.deepEqual(await js(`[...document.querySelectorAll('.companion-action-menu .list-button')].map(b=>b.textContent.trim())`),['复制消息','取消']);const menu=await js(`(()=>{const rows=[...document.querySelectorAll('.companion-action-menu .list-button')].map(b=>b.getBoundingClientRect());return {gap:rows[1].top-rows[0].bottom,heights:rows.map(r=>r.height)}})()`);assert.ok(menu.gap<=8,JSON.stringify(menu));assert.ok(menu.heights.every(h=>h>=44));if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/message-menu.png');await browser('press','Escape');await settle();
 await browser('click','.companion-media-button');await browser('wait','.photo-browser-popup.modal-in');await settle();assert.equal(await js(`document.querySelector('.photo-browser-popup .popup-close').textContent.trim()`),'关闭');assert.equal(await js(`document.querySelector('.photo-browser-popup .popup-close').getAttribute('aria-label')`),'关闭大图');assert.equal(await js(`document.activeElement===document.querySelector('.photo-browser-popup .popup-close')`),true);await browser('press','Escape');await settle();
 await language(1);assert.equal(await js('document.documentElement.lang'),'en');await browser('click','.companion-history-toggle');await browser('wait','.companion-history-drawer.panel-in');await settle();assert.deepEqual(await js(`[...document.querySelectorAll('.companion-diary-tabs [role=tab]')].map(b=>b.textContent.trim())`),['Relationship','Diary','Album','Auto wake']);
 for(const width of [320,390,1024]){await browser('set','viewport',String(width),'844');await settle();await checkTabs();}
 if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/sidebar-en-desktop.png');
 console.log('PASS: Chinese/English switching, sidebar, gallery empty/error/retry, Actions labels, Photo Browser close text/accessibility/focus');
}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await app.close();await f.close()}
