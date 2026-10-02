// Initial layout and foreground recovery against a test-owned Partner.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const execute=promisify(execFile),f=await fixture(),session=`cfl-initial-scroll-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
const settle=()=>js('new Promise(r=>setTimeout(r,450))');
try{
 const partner=await f.createPartner();for(let i=0;i<8;i++){await partner.submit(crypto.randomUUID(),`generate image Initial scroll fixture ${i} `+'A long message for viewport overflow. '.repeat(12));await eventually(async()=>(await partner.snapshot()).pendingCount===0);}
 app=createWebServer(partner,resolve(process.env.CFL_TEST_BUILD_DIR??'apps/partner/build'));const handler=app.server.listeners('request')[0];app.server.removeAllListeners('request');app.server.on('request',(req,res)=>{if(req.url.startsWith('/api/images/'))setTimeout(()=>handler(req,res),150);else handler(req,res)});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','#companion-textarea');
 await settle();
 const measure=()=>js(`(()=>{const t=document.querySelector('.companion-timeline');return {gap:t.scrollHeight-t.clientHeight-t.scrollTop,scroll:t.scrollTop,height:t.scrollHeight,viewport:t.clientHeight}})()`);
 for(let i=0;i<3;i++){if(i){await browser('reload');await browser('wait','.timeline-ready');await settle();}await browser('wait','1500');const m=await measure();console.log('INITIAL',i,m);assert.ok(m.height>m.viewport,'fixture overflows');assert.ok(m.gap<2,'opening chat should show latest message: '+JSON.stringify(m));}
 await js(`(()=>{const t=document.querySelector('.companion-timeline');t.scrollTop=160;t.dispatchEvent(new Event('scroll'))})()`);await settle();
 assert.ok((await measure()).gap>96,'reader is away from latest');
 await settle();assert.equal((await measure()).scroll,160,'reading in the foreground retains position');
 await js(`(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});Object.defineProperty(document,'hidden',{configurable:true,get:()=>document.visibilityState==='hidden'});document.dispatchEvent(new Event('visibilitychange',{bubbles:true}));})()`);await settle();
 assert.ok((await measure()).gap>96,'backgrounding does not move the reader');
 await partner.submit(crypto.randomUUID(),'A new fixture reply while backgrounded');await eventually(async()=>(await partner.snapshot()).pendingCount===0);
 await js(`(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange',{bubbles:true}));})()`);await settle();
 const resumed=await measure();console.log('RESUMED',resumed);assert.ok(resumed.gap<2,'returning to foreground should show latest: '+JSON.stringify(resumed));
 console.log('PASS initial and foreground scroll');
}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await app.close();await f.close()}
