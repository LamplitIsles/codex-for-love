// Cold loading waits for all synchronization batches; late images retain bottom alignment.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const execute=promisify(execFile),f=await fixture(),session=`cfl-cold-sync-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
const settle=()=>js('new Promise(r=>setTimeout(r,450))');
try{
 const partner=await f.createPartner();for(let i=0;i<4;i++){await partner.submit(crypto.randomUUID(),`generate image Initial scroll fixture ${i} `+'A long message for viewport overflow. '.repeat(12));await eventually(async()=>(await partner.snapshot()).pendingCount===0);}
 app=createWebServer(partner,resolve(process.env.CFL_TEST_BUILD_DIR??'apps/partner/build'));const handler=app.server.listeners('request')[0];app.server.removeAllListeners('request');app.server.on('request',(req,res)=>{
 if(req.url==='/api/session'){
  const end=res.end.bind(res);res.end=(body,...args)=>{const batch=JSON.parse(body);batch.messages=batch.messages.slice(0,2);const ids=new Set(batch.messages.map(m=>m.id));batch.results=batch.results.filter(r=>r.sourceIds.some(id=>ids.has(id)));batch.cursor=0;batch.hasChangesMore=true;return end(JSON.stringify(batch),...args)};handler(req,res);
 }else if(req.url.startsWith('/api/session?after=0'))setTimeout(()=>handler(req,res),150);
 else if(req.url.startsWith('/api/images/'))setTimeout(()=>handler(req,res),100);
 else handler(req,res)
});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','#companion-textarea');
 await settle();
 const measure=()=>js(`(()=>{const t=document.querySelector('.companion-timeline');return {gap:t.scrollHeight-t.clientHeight-t.scrollTop,scroll:t.scrollTop,height:t.scrollHeight,viewport:t.clientHeight,lastBottom:[...document.querySelectorAll(".message-bubble")].at(-1).getBoundingClientRect().bottom,composerTop:document.querySelector(".companion-composer").getBoundingClientRect().top}})()`);
 for(let i=0;i<3;i++){if(i){await browser('reload');await browser('wait','.timeline-ready');await settle();}await browser('wait','1500');const m=await measure();console.log('INITIAL',i,m);assert.ok(m.height>m.viewport,'fixture overflows');assert.ok(m.gap<2,'opening chat should show latest message: '+JSON.stringify(m));assert.ok(m.lastBottom<=m.composerTop,'latest bubble must be above the composer: '+JSON.stringify(m));}
 console.log('PASS cold-start synchronization');
}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await app.close();await f.close()}
