import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const exec=promisify(execFile),f=await fixture(),session=`regression-focus-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await exec('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async s=>(await browser('eval','--base64',Buffer.from(s).toString('base64'))).result;
const wait=()=>js('new Promise(r=>setTimeout(r,450))');
try {
 const partner=await f.createPartner();await partner.submit(crypto.randomUUID(),'Keyboard review fixture');await eventually(async()=>(await partner.snapshot()).pendingCount===0);
 app=createWebServer(partner,process.env.CFL_TEST_BUILD_DIR ?? fileURLToPath(new URL("../build/", import.meta.url)));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','.timeline-ready .incoming .companion-text-bubble');await wait();
 const messageFocus=await js(`(()=>{const e=document.querySelector('.incoming .companion-text-bubble');e.focus();return {tabIndex:e.tabIndex,focused:document.activeElement===e}})()`);
 await browser('press','Shift+F10');await wait();const keyboardMenu=await js(`!!document.querySelector('.companion-action-menu.modal-in')`);
 await browser('press','Escape');await browser('click','.companion-history-toggle');await browser('wait','.companion-history-drawer.panel-in');await wait();
 const focus=[];let escaped=false;
 for(let i=0;i<15;i++){await browser('press','Tab');const p=await js(`(()=>{const e=document.activeElement;return {tag:e.tagName,id:e.id,text:e.textContent.trim().slice(0,30),inside:!!e.closest('.companion-history-drawer'),modalOpen:!!document.querySelector('.companion-history-drawer.panel-in')}})()`);focus.push(p);if(!p.inside&&p.modalOpen){escaped=true;break;}}
 assert.equal(keyboardMenu,true,'keyboard Context Menu / Shift+F10 must open message actions');assert.equal(escaped,false,'Tab stays in the modal drawer');
 await browser('press','Shift+Tab');
 assert.equal(await js(`!!document.activeElement.closest('.companion-history-drawer')`),true,'reverse Tab stays in drawer');
 await browser('press','Escape');await wait();
 await js(`document.querySelector('.companion-search-trigger').focus()`);await browser('press','Enter');await browser('wait','.companion-search-dialog.modal-in');await js('new Promise(r=>setTimeout(r,700))');
 for(let i=0;i<12;i++){await browser('press',i%2?'Shift+Tab':'Tab');assert.equal(await js(`!!document.activeElement.closest('.companion-search-dialog')`),true,'search popup traps Tab');}
 await browser('press','Escape');await eventually(()=>js(`!document.querySelector('.companion-search-dialog')`));
 assert.equal(await js(`document.activeElement===document.querySelector('.companion-search-trigger')`),true,'search close returns focus to trigger');
 console.log(JSON.stringify({messageFocus,keyboardMenu,escaped,focus},null,2));
} finally {await exec('agent-browser',['--session',session,'close']).catch(()=>{});try { if(app)await app.close(); } finally { await f.close(); }}
