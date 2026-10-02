// Search UI exercises test-owned HTTP fixtures, including delayed responses and failures.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {fixture} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const execute=promisify(execFile),f=await fixture(),session=`cfl-search-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
const settle=()=>js('new Promise(r=>setTimeout(r,450))');
const shot=async name=>{if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/'+name+'.png')};
try{
 app=createWebServer(await f.createPartner(),resolve(process.env.CFL_TEST_BUILD_DIR??'apps/partner/build'));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','#companion-textarea');await settle();
 await js(`localStorage.setItem('her.companion.language','zh')`);await browser('reload');await browser('wait','#companion-textarea');await settle();
 await js(`(()=>{const original=window.fetch;window.searchMode='results';window.readMode='context';window.searchCalls=0;window.fetch=async(input,...rest)=>{
 const url=String(input);if(!url.startsWith('/api/conversation-search'))return original(input,...rest);
 await new Promise(r=>setTimeout(r,1000));
 if(url.includes('?')){searchCalls++;if(searchMode==='error')return new Response('{}',{status:503});return Response.json({estimatedTotalHits:searchMode==='empty'?0:2,hits:searchMode==='empty'?[]:[{id:'a',kind:'message',sessionId:'test',role:'user',createdAt:'2026-10-02T01:00:00Z',snippet:'找回 <mark>旅行</mark> 那段对话，测试很长的中文搜索摘要。'.repeat(8)},{id:'b',kind:'compaction',sessionId:'test',createdAt:'2026-10-01T01:00:00Z',snippet:'摘要 <mark>旅行</mark>'}]})}
 if(readMode==='error')return new Response('{}',{status:503});return Response.json({record:{id:'a',kind:'message',role:'user',createdAt:'2026-10-02T01:00:00Z',content:'命中的旅行计划'},context:{targetSourceRecordIndex:10,truncated:true,items:Array.from({length:20},(_,i)=>({sourceRecordIndex:i,kind:'message',role:i%2?'assistant':'user',content:'周围消息 '+i+'\\n'+('这是上下文里的很长的一行。\\n').repeat(12)}))}})
 }})()`);
 await browser('click','.companion-search-trigger');await browser('wait','.companion-search-dialog.modal-in');await settle();
 assert.match(await js(`document.querySelector('.companion-search-results').textContent`),/输入记得/);await shot('search-initial');
 await browser('fill','.companion-search-form input','旅行');await browser('press','Enter');await browser('wait','.companion-search-state');
 const loading=await js(`(()=>{const e=document.querySelector('.companion-search-state'),p=e.querySelector('.preloader').getBoundingClientRect(),t=e.querySelector(':scope > span:last-child').getBoundingClientRect();return{gap:t.left-p.right,height:p.height,text:e.textContent.trim()}})()`);
 assert.ok(loading.gap>=8&&loading.height>=20,JSON.stringify(loading));assert.match(loading.text,/寻找|搜索/);await shot('search-loading');
 await browser('wait','.companion-search-result');assert.equal(await js('searchCalls'),1);assert.equal(await js(`document.querySelectorAll('li.companion-search-result').length`),2);await shot('search-results');
 for(const width of [320,390,1024]){await browser('set','viewport',String(width),'844');await settle();const layout=await js(`(()=>{const el=document.querySelector('.companion-search-dialog'),r=el.getBoundingClientRect(),input=el.querySelector('input').getBoundingClientRect(),button=el.querySelector('.companion-search-submit').getBoundingClientRect(),list=el.querySelector('.list').getBoundingClientRect();return{inputWidth:input.width,buttonWidth:button.width,inputRight:input.right,buttonLeft:button.left,listRight:list.right,popupRight:r.right,scrollWidth:el.scrollWidth,width:el.clientWidth}})()`);assert.ok(layout.inputWidth>=140&&layout.inputRight<=layout.buttonLeft&&layout.listRight<=layout.popupRight&&layout.scrollWidth<=layout.width,JSON.stringify(layout));}
 await browser('set','viewport','390','844');await settle();await browser('click','.companion-search-list li:first-child .item-link');await browser('wait','.companion-search-reader .preloader');await shot('reader-loading');await browser('wait','.search-target');await settle();
 const reader=await js(`(()=>{const r=document.querySelector('.companion-search-reader').getBoundingClientRect(),target=document.querySelector('.search-target mark').getBoundingClientRect();return{visible:target.top>=r.top&&target.bottom<=r.bottom,both:!!document.querySelector('.message-sent.message-received'),sent:!!document.querySelector('.message-sent .message-content .message-bubble'),received:!!document.querySelector('.message-received .message-content .message-bubble')}})()`);
 assert.deepEqual(reader,{visible:true,both:false,sent:true,received:true});await shot('reader-context');
 await browser('click','.companion-search-back');await browser('wait','.companion-search-result');await js(`readMode='error'`);await browser('click','.companion-search-list li:first-child .item-link');await browser('wait','.companion-search-reader [role=alert]');assert.match(await js(`document.querySelector('.companion-search-reader [role=alert]').textContent`),/打不开/);await shot('reader-error');
 await js(`readMode='context'`);await browser('click','.companion-search-reader [role=alert] button');await browser('wait','.search-target');await browser('click','.companion-search-back');await browser('wait','.companion-search-submit');
 await js(`searchMode='empty'`);await browser('click','.companion-search-submit');await browser('wait','1500');assert.match(await js(`document.querySelector('.companion-search-results').textContent`),/没有/);await shot('search-empty');
 await js(`searchMode='error'`);await browser('click','.companion-search-submit');await browser('wait','.companion-search-results [role=alert]');await shot('search-error');
 await js(`searchMode='results'`);await browser('click','.companion-search-results [role=alert] button');await browser('wait','.companion-search-result');
 await browser('click','.companion-search-form input');await settle();await browser('click','.companion-search-form .input-clear-button');assert.equal(await js(`document.querySelector('.companion-search-form input').value`),'');assert.equal(await js(`getComputedStyle(document.querySelector('.companion-search-submit')).pointerEvents==='none'`),true);
 await browser('click','.companion-search-back');await settle();assert.equal(await js('!!document.querySelector(".companion-search-dialog.modal-in")'),false);assert.notEqual(await js('document.activeElement.tagName'),'TEXTAREA');
 await browser('click','.companion-preferences-trigger');await browser('wait','.companion-preferences-panel.modal-in');await settle();await browser('click','label:has(input[name=companion-appearance][value=dark]) .item-title');await browser('click','label:has(input[name=companion-language][value=en]) .item-title');await browser('press','Escape');await settle();
 await browser('click','.companion-search-trigger');await browser('wait','.companion-search-dialog.modal-in');await settle();assert.equal(await js(`document.querySelector('.companion-search-form input').placeholder`),'Words or phrase');
 await browser('fill','.companion-search-form input','旅行');await browser('click','.companion-search-submit');await browser('wait','.companion-search-result');await shot('search-dark-en');
 await browser('click','.companion-search-back');await settle();
 console.log('PASS: search loading/results/empty/error/retry/clear, responsive layout, reader loading/context/error/retry/back, highlighted target positioning and exclusive message directions');
}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await app.close();await f.close()}
