// Message links are checked against a test-owned HTTP destination and fake Partner.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const execute=promisify(execFile),f=await fixture(),session=`cfl-message-links-${process.pid}`;
let app,ws,hits=0;
const target=createServer((request,response)=>{if(request.url==='/linked-page')hits++;response.end('<h1>Test link opened</h1>')});
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
try{
 target.listen(0,'127.0.0.1');await once(target,'listening');
 const destination=`http://127.0.0.1:${target.address().port}/linked-page`;
 const partner=await f.createPartner();await partner.submit(crypto.randomUUID(),`[Test message link](${destination})`);await eventually(async()=>(await partner.snapshot()).pendingCount===0);
 app=createWebServer(partner,resolve(process.env.CFL_TEST_BUILD_DIR??'apps/partner/build'));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('wait','.timeline-ready .outgoing .markdown a');await js(`document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,300)))`);
 const anchor=await js(`(()=>{const a=document.querySelector('.outgoing .markdown a');return {href:a.href,target:a.target,classes:a.className}})()`);console.log('Rendered link:',anchor);
 ws=new WebSocket((await execute('agent-browser',['--session',session,'get','cdp-url'],{encoding:'utf8'})).stdout.trim());await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 let id=0;const pending=new Map();ws.onmessage=event=>{const r=JSON.parse(event.data),p=pending.get(r.id);if(p){pending.delete(r.id);r.error?p.reject(r.error):p.resolve(r.result)}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}))});
 const {targetInfos}=await call('Target.getTargets');const source=targetInfos.find(t=>t.type==='page'&&t.url.startsWith(`http://127.0.0.1:${app.server.address().port}`));assert.ok(source,'the original chat stays open');
 const {sessionId}=await call('Target.attachToTarget',{targetId:source.targetId,flatten:true});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 await call('Target.activateTarget',{targetId:source.targetId});await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2},sessionId);await call('Page.reload',{},sessionId);await eventually(async()=>await evaluate(`!!document.querySelector('.timeline-ready .outgoing .markdown a')`));
 await call('Page.bringToFront',{},sessionId);await evaluate(`document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,500)))`);const rect=await evaluate(`document.querySelector('.outgoing .markdown a').getBoundingClientRect().toJSON()`);const point={x:rect.x+rect.width/2,y:rect.y+rect.height/2,radiusX:1,radiusY:1,id:0,force:1};
 const touch=(type,touchPoints)=>call('Input.dispatchTouchEvent',{type,touchPoints},sessionId);const wait=ms=>new Promise(r=>setTimeout(r,ms));await call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1},sessionId);await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1},sessionId);await eventually(async()=>hits>0);assert.equal(anchor.target,'_blank');assert.ok(anchor.classes.includes('external'));await call('Page.bringToFront',{},sessionId);await wait(400);const beforeHold=hits;
 await touch('touchStart',[point]);await wait(600);await touch('touchEnd',[]);await wait(400);assert.equal(await evaluate(`!!document.querySelector('.companion-action-menu.modal-in')`),true,'long press still opens the message menu');assert.equal(hits,beforeHold,'long-press release does not navigate');
 const menuGeometry=await evaluate(`(()=>{const root=document.querySelector('.companion-action-menu');const rows=[...root.querySelectorAll('.list-button')].map(e=>e.getBoundingClientRect().toJSON());return {height:root.getBoundingClientRect().height,gap:rows[1].top-rows[0].bottom,rowHeights:rows.map(r=>r.height)}})()`);console.log('Message menu geometry:',menuGeometry);assert.ok(menuGeometry.gap<=8,'message actions should not have a blank section between rows');assert.ok(menuGeometry.rowHeights.every(h=>h>=44),'message actions retain accessible touch targets');
 const cancel=await evaluate(`document.querySelector('.companion-action-menu li:last-child .list-button').getBoundingClientRect().toJSON()`);await touch('touchStart',[{...point,x:cancel.x+cancel.width/2,y:cancel.y+cancel.height/2}]);await wait(40);await touch('touchEnd',[]);await eventually(async()=>await evaluate(`!document.querySelector('.popover-backdrop.backdrop-in')`));await wait(400);
 await evaluate(`document.querySelector('.outgoing .markdown a').scrollIntoView({block:'center'})`);await wait(300);const currentRect=await evaluate(`document.querySelector('.outgoing .markdown a').getBoundingClientRect().toJSON()`);point.x=currentRect.x+currentRect.width/2;point.y=currentRect.y+currentRect.height/2;await touch('touchStart',[point]);await wait(40);await touch('touchEnd',[]);await eventually(async()=>hits>beforeHold);assert.equal(await evaluate(`getComputedStyle(document.querySelector('.companion-text-bubble')).userSelect`),'none','native text handles remain disabled');
 console.log('PASS: mouse click and trusted touch tap open links in another tab; long press opens the message menu without navigating; chat and selection suppression remain intact');
}finally{ws?.close();await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await app.close();await f.close();await new Promise(resolve=>target.close(resolve));}
