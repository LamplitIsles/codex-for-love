// Composer acceptance runs only against a temporary workspace and fake capture/provider.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {once} from 'node:events';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const execute=promisify(execFile);const f=await fixture();const session=`cfl-composer-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
const settle=()=>js('new Promise(r=>setTimeout(r,150))');
const draft=async value=>{await js(`(()=>{const e=document.querySelector('#companion-textarea');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await settle()};
try{
 const partner=await f.createPartner();await partner.submit(crypto.randomUUID(),'generate image');await eventually(async()=>(await partner.snapshot()).results.length===1);
 await cp(process.env.CFL_TEST_BUILD_DIR??new URL('../build/',import.meta.url),join(f.directory,'assets'),{recursive:true});app=createWebServer(partner,join(f.directory,'assets'));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const init=join(f.directory,'init.js');await writeFile(init,`
 window.fixtureErrors=[];window.addEventListener("error",e=>fixtureErrors.push(e.message));
 window.fixtureSends=0;window.fixtureHold=false;window.fixturePermissionRequests=0;
 Notification.requestPermission=async()=>{fixturePermissionRequests++;return "default"};
 const original=window.fetch;
 window.fetch=async(input,...args)=>{
  const path=String(input);
  if(path.startsWith('/api/session')){const r=await original(input,...args);const s=await r.json();s.speech=true;return new Response(JSON.stringify(s),{headers:{'content-type':'application/json'}})}
  if(path==='/api/messages')fixtureSends++;
  if(path==='/api/voice/transcribe'){while(fixtureHold){if(args[0]?.signal?.aborted)throw new DOMException('canceled','AbortError');await new Promise(r=>setTimeout(r,20))}if(args[0]?.signal?.aborted)throw new DOMException('canceled','AbortError');return new Response(JSON.stringify({text:'hello voice',expression:'neutral'}),{headers:{'content-type':'application/json'}})}
  return original(input,...args);
 };
 Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>({getTracks:()=>[{stop(){}}]})});
 window.MediaRecorder=class{static isTypeSupported(type){return type==='audio/webm'};constructor(){this.state='inactive'}start(){this.state='recording'}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fake-audio'],{type:'audio/webm'})});this.onstop?.()}};
 `);
 await browser('--init-script',init,'open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('reload');await browser('wait','#companion-textarea');await settle();
 assert.equal(await js("!!document.querySelector('.companion-image-bubble')"),true);
 assert.equal(await js(`document.querySelector('.companion-image-bubble').closest('.message')===document.querySelector('.incoming .companion-text-bubble').closest('.message')`),false, "image and text must be independent message bubbles");
 const imageBounds=await js(`(()=>{const img=document.querySelector('.companion-image-bubble img'),bubble=img.closest('.message-bubble');return {image:img.getBoundingClientRect().toJSON(),bubble:bubble.getBoundingClientRect().toJSON()}})()`);
 assert.ok(imageBounds.image.left>=imageBounds.bubble.left-1&&imageBounds.image.right<=imageBounds.bubble.right+1&&imageBounds.image.top>=imageBounds.bubble.top-1&&imageBounds.image.bottom<=imageBounds.bubble.bottom+1,JSON.stringify(imageBounds));
 assert.equal(await js(`getComputedStyle(document.querySelector('.companion-header .navbar-bg')).backgroundColor==='rgba(0, 0, 0, 0)'`),false,'official navbar must cover scrolling messages');
 // Reading actions must never restore an editable focus and reopen the keyboard.
 await js(`(()=>{navigator.clipboard.writeText=async()=>{};const input=document.querySelector('textarea');input.focus();document.querySelector('.incoming .companion-text-bubble').dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}))})()`);
 await browser('wait','.companion-action-menu.modal-in');await browser('click','.companion-action-menu .actions-button');await js('new Promise(r=>setTimeout(r,500))');
 assert.equal(await js(`document.activeElement===document.querySelector('textarea')`),false,'copy must not restore composer focus');
 await js(`document.querySelector('textarea').focus();document.querySelector('.companion-preferences-trigger').click()`);await browser('wait','.companion-preferences-panel.modal-in');
 await browser('press','Escape');await js('new Promise(r=>setTimeout(r,500))');assert.equal(await js(`document.activeElement===document.querySelector('textarea')`),false,'settings close must not restore editor focus');
 const measure=()=>js(`(()=>{const row=document.querySelector('.companion-compose-row');const textarea=document.querySelector('textarea');const rect=e=>e.getBoundingClientRect().toJSON();return{surface:rect(row),textarea:rect(textarea),radius:parseFloat(getComputedStyle(textarea).borderTopLeftRadius),scrollWidth:textarea.scrollWidth,width:textarea.clientWidth,height:textarea.clientHeight,scrollHeight:textarea.scrollHeight,buttons:[...row.querySelectorAll('.toolbar-pane>.button')].map(rect),send:row.querySelector('.companion-send').disabled,overflow:document.documentElement.scrollWidth>innerWidth,padding:parseFloat(getComputedStyle(document.querySelector('.companion-timeline')).paddingBottom)}})()`);
 for(const width of [390,320,844]){
  await browser('set','viewport',String(width),'844');await draft('');let m=await measure();const shortHeight=m.height;assert.equal(m.send,true);assert.ok(m.padding>=m.surface.height,JSON.stringify(m));
  assert.equal(m.buttons.length,3);assert.ok(m.radius>0,"composer must retain framework rounded corners");for(const b of m.buttons)assert.ok(Math.abs(b.bottom-m.textarea.bottom)<=1,"composer control bottoms must align: "+JSON.stringify(m));for(const b of m.buttons)assert.ok(b.width>=44&&b.height>=44&&b.left>=m.surface.left&&b.right<=m.surface.right,JSON.stringify(m));
  await draft('hi');m=await measure();assert.equal(m.send,false);assert.equal(m.height,shortHeight);
  await draft('长消息'.repeat(35));m=await measure();assert.ok(m.height>shortHeight,JSON.stringify(m));for(const b of m.buttons)assert.ok(Math.abs(b.bottom-m.textarea.bottom)<=1,'multiline composer control bottoms must align: '+JSON.stringify(m));assert.ok(!m.overflow&&m.scrollWidth<=m.width,JSON.stringify(m));
  await draft('https://example.com/'+'abcdefgh'.repeat(200));m=await measure();assert.ok(m.height<=144&&m.scrollHeight>m.height&&!m.overflow&&m.scrollWidth<=m.width,JSON.stringify(m));
  await draft('hi\nthere');assert.ok((await measure()).height>shortHeight);await draft('hi');assert.ok(Math.abs((await measure()).height-shortHeight)<=2);
  await browser('click','.companion-history-toggle');await settle();const tabs=await js(`(()=>{const el=document.querySelector('.companion-diary-tabs');return [...el.querySelectorAll('.button')].map(b=>({width:b.clientWidth,scroll:b.scrollWidth,height:b.clientHeight,text:b.textContent.trim()}))})()`);assert.ok(tabs.every(b=>b.width>=130&&b.scroll<=b.width&&b.height>=44),JSON.stringify(tabs));
  // Closing must release the backdrop even if no transitionend can occur.
  await js(`document.querySelector('.companion-history-drawer').style.transitionDuration='0s';document.querySelector('.companion-history-controls button').click()`);await js('new Promise(r=>setTimeout(r,550))');
  assert.equal(await js(`(()=>{const input=document.querySelector('textarea'),r=input.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input})()`),true,'closed panel must not intercept composer taps');

 }
 await browser('set','viewport','390','844');await draft('');
 await js(`(async()=>{const canvas=document.createElement('canvas');canvas.width=200;canvas.height=100;const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File([blob],'fixture.png',{type:'image/png'}));const input=document.querySelector('#companion-image-library');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);await settle();
 let attachment=await measure();assert.equal(attachment.send,false);assert.ok(await js(`document.querySelector('.messagebar-attachment img').getBoundingClientRect().width>0`));assert.equal(await js(`document.querySelector('.companion-image-draft-remove').getBoundingClientRect().width`),44);await browser('click','.companion-image-draft-remove');await settle();assert.equal(await js(`!!document.querySelector('.messagebar-attachment')`),false);
 await browser('set','viewport','390','844');await draft('before AFTER');await js(`document.querySelector('textarea').setSelectionRange(7,12)`);await browser('click','.companion-microphone');await settle();let send=await js(`({disabled:document.querySelector('.companion-send').disabled,readonly:document.querySelector('textarea').readOnly,label:document.querySelector('.companion-attach').getAttribute('aria-label'),stop:!!document.querySelector('.companion-microphone svg rect')})`);assert.ok(send.disabled&&send.readonly&&send.stop);assert.equal(send.label,'Cancel recording');
 await js('fixtureHold=true');await browser('click','.companion-microphone');await settle();assert.equal(await js(`document.querySelector('.companion-microphone').dataset.state`),'transcribing');assert.equal(await js('fixtureSends'),0);assert.equal(await js(`document.querySelector('textarea').value`),'before AFTER');await js('fixtureHold=false');await browser('wait','.companion-microphone[data-state="idle"]');await settle();assert.equal(await js(`document.querySelector('textarea').value`),'before hello voice');assert.equal(await js(`document.activeElement===document.querySelector('textarea')`),false,'transcription must not focus editor');assert.equal(await js('fixtureSends'),0);
 await browser('click','.companion-microphone');await settle();await browser('click','.companion-attach');await settle();assert.equal(await js(`document.querySelector('textarea').value`),'before hello voice');assert.equal(await js(`document.querySelector('.companion-microphone').dataset.state`),'idle');
 // A canceled request may complete late but cannot replace the draft.
 await browser('click','.companion-microphone');await js('fixtureHold=true');await browser('click','.companion-microphone');await settle();await browser('click','.companion-attach');await js('fixtureHold=false');await settle();assert.equal(await js(`document.querySelector('textarea').value`),'before hello voice');assert.equal(await js('fixtureSends'),0);assert.equal(await js("!!document.querySelector('[data-testid=companion-voice-error-status]')"),false);
 await draft('notification permission fixture');await browser('click','.companion-send');await settle();assert.equal(await js('fixtureSends'),1);assert.equal(await js('fixturePermissionRequests'),0,'sending must not request notification permission');
 assert.deepEqual(await js('fixtureErrors'),[], 'Framework7 input and business callbacks must complete without runtime errors');
 console.log('PASS: reading focus/copy/settings/transcription/no permission prompt, official messagebar resize/cap/wrap/320px/controls, sidebar labels/backdrop, image bubble, voice manual draft/selection/cancel/late result');
}catch(error){console.error('UI DIAGNOSTIC',JSON.stringify(await js('({errors:fixtureErrors,body:document.body.innerHTML.slice(0,1400),url:location.href})').catch(()=>null)));throw error;}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await new Promise(r=>app.server.close(r));await f.close()}
