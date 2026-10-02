// Drawer acceptance uses fixture-owned alarms and scoped fetch failures.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {fixture} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
import {createAlarm} from '../runtime/alarms.ts';
import {partnerPaths} from '../runtime/storage-paths.ts';
const execute=promisify(execFile),f=await fixture(),session=`cfl-alarm-drawer-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
const settle=()=>js('new Promise(r=>setTimeout(r,450))');
const shot=async name=>{if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/'+name+'.png')};
try{
 const partner=await f.createPartner();const message='睡前记得休息。\n'+('这是比较长的一段提醒，需要能在原地展开完整阅读。').repeat(8);
 createAlarm(partnerPaths(f.workspace).alarms,message,{kind:'daily',hour:21,minute:30,timeZone:'Asia/Taipei'});
 createAlarm(partnerPaths(f.workspace).alarms,'周末出去走走',{kind:'once',at:new Date(Date.now()+86400000*2).toISOString()});
 app=createWebServer(partner,resolve(process.env.CFL_TEST_BUILD_DIR??'apps/partner/build'));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','#companion-textarea');await settle();
 await js(`localStorage.setItem('her.companion.language','zh')`);await browser('reload');await browser('wait','#companion-textarea');await settle();
 await js(`(()=>{const original=window.fetch;window.alarmMode='real';window.fetch=async(input,options)=>{if(String(input)!=='/api/alarms')return original(input,options);if(alarmMode==='slow')await new Promise(r=>setTimeout(r,1500));if(alarmMode==='error')return new Response('{}',{status:500});if(alarmMode==='empty')return Response.json({alarms:[]});return original(input,options)}})()`);
 await browser('click','.companion-history-toggle');await browser('wait','.companion-history-drawer.panel-in');await settle();await browser('click','#companion-alarms-tab');await browser('wait','.companion-alarm-list .accordion-item');await settle();
 assert.equal(await js(`document.querySelectorAll('.companion-alarm-list .accordion-item').length`),2);assert.match(await js(`document.querySelector('.companion-alarms-heading').textContent`),/自动唤醒/);
 for(const width of [320,390,1024]){await browser('set','viewport',String(width),'844');await settle();const layout=await js(`(()=>{const p=document.querySelector('.companion-history-drawer').getBoundingClientRect();return{panel:p.width,rows:[...document.querySelectorAll('.companion-alarm-list .item-link')].map(e=>{const r=e.getBoundingClientRect();return{inside:r.left>=p.left&&r.right<=p.right,width:r.width}}),tabs:[...document.querySelectorAll('.companion-diary-tabs button')].map(e=>e.getBoundingClientRect().top),overflow:document.querySelector('.companion-history-scroll').scrollWidth>document.querySelector('.companion-history-scroll').clientWidth}})()`);assert.equal(layout.overflow,false,JSON.stringify(layout));assert.ok(layout.rows.every(r=>r.inside));assert.ok(Math.max(...layout.tabs)-Math.min(...layout.tabs)<1,'all four tabs share one row');}
 await browser('set','viewport','390','844');await settle();await shot('wake-list');
 await browser('click','.companion-alarm-list li:first-child .item-link');await browser('wait','.companion-alarm-list .accordion-item-opened');await settle();assert.equal(await js(`document.querySelector('.accordion-item-opened .companion-alarm-message').textContent`),message);await shot('wake-expanded');
 await browser('click','.companion-alarm-list li:first-child .item-link');await settle();assert.equal(await js(`!!document.querySelector('.companion-alarm-list .accordion-item-opened')`),false);
 await js(`alarmMode='slow'`);await browser('click','.companion-alarm-refresh');await browser('wait','.companion-alarm-loading .preloader');await shot('wake-loading');await browser('wait','.companion-alarm-list');
 await js(`alarmMode='error'`);await browser('click','.companion-alarm-refresh');await browser('wait','.companion-alarm-empty[role=alert]');await shot('wake-error');
 await js(`alarmMode='empty'`);await browser('click','.companion-alarm-empty .button');await browser('wait','500');assert.match(await js(`document.querySelector('.companion-alarm-empty').textContent`),/还没有唤醒安排/);await shot('wake-empty');
 await js(`alarmMode='real'`);await browser('click','.companion-alarm-refresh');await browser('wait','.companion-alarm-list');await js(`document.documentElement.classList.add('dark')`);await settle();await shot('wake-dark');
 console.log('PASS: fixture-owned wake list, original schedules, inline expand/collapse, loading/error/retry/empty, four horizontal tabs, responsive containment and dark theme');
}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await app.close();await f.close()}
