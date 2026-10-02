import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const exec=promisify(execFile),f=await fixture(),session=`regression-photo-back-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await exec('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async s=>(await browser('eval','--base64',Buffer.from(s).toString('base64'))).result;
const wait=()=>js('new Promise(r=>setTimeout(r,450))');
try {
 const partner=await f.createPartner();await partner.submit(crypto.randomUUID(),'generate image');await eventually(async()=>(await partner.snapshot()).pendingCount===0);
 app=createWebServer(partner,process.env.CFL_TEST_BUILD_DIR ?? fileURLToPath(new URL("../build/", import.meta.url)));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','.timeline-ready .incoming .companion-text-bubble');await wait();
 await browser('click','.companion-media-button');await browser('wait','.photo-browser-popup.modal-in');await wait();
 await browser('press','Tab');assert.equal(await js(`document.activeElement.matches('.swiper-slide-active img')`),true,'viewer image is keyboard reachable');await browser('press','Shift+F10');await browser('wait','.companion-action-menu.modal-in');await wait();
 const measure=()=>js(`({imageOpen:!!document.querySelector('.photo-browser-popup.modal-in'),menuOpen:!!document.querySelector('.companion-action-menu.modal-in'),backdrop:!!document.querySelector('.popover-backdrop.backdrop-in'),url:location.pathname})`);
 console.log('BEFORE',await measure());await browser('back');await wait();await wait();const after=await measure();console.log('AFTER',after);
 assert.equal(after.menuOpen&&!after.imageOpen,false,'closing the image viewer must not leave an orphan action menu/backdrop');

} finally {await exec('agent-browser',['--session',session,'close']).catch(()=>{});try { if(app)await app.close(); } finally { await f.close(); }}
