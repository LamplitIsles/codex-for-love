// Avatar alignment and typing use test-owned profile assets and a held fake provider.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fixture,eventually} from './fixture.ts';
import {createWebServer} from '../runtime/server.ts';
const execute=promisify(execFile),f=await fixture(),session=`cfl-typing-${process.pid}`;let app;
const browser=async(...args)=>JSON.parse((await execute('agent-browser',['--session',session,'--json',...args],{encoding:'utf8'})).stdout).data;
const js=async expression=>(await browser('eval','--base64',Buffer.from(expression).toString('base64'))).result;
const settle=()=>js('new Promise(r=>setTimeout(r,450))');
const shot=async name=>{if(process.env.CFL_TEST_SCREENSHOTS)await browser('screenshot',process.env.CFL_TEST_SCREENSHOTS+'/'+name+'.png')};
try{
 const avatar=join(f.workspace,'avatar.png');await writeFile(avatar,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI0YAAAAASUVORK5CYII=','base64'));f.config.avatars={companion:avatar,user:avatar};
 const partner=await f.createPartner();await partner.submit(crypto.randomUUID(),'generate image');await eventually(async()=>(await partner.snapshot()).pendingCount===0);await f.holdProvider(true);await partner.submit(crypto.randomUUID(),'第一行\n第二行\n第三行');await eventually(async()=>(await partner.snapshot()).typing);
 app=createWebServer(partner,resolve(process.env.CFL_TEST_BUILD_DIR??'apps/partner/build'));app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 await browser('open',`http://127.0.0.1:${app.server.address().port}`);await browser('set','viewport','390','844');await browser('wait','[data-testid=companion-typing-indicator]');await settle();
 const metrics=await js(`(()=>{const rows=[...document.querySelectorAll('.companion-row')];const typing=document.querySelector('[data-testid=companion-typing-indicator]'),img=typing.querySelector('.message-avatar img'),normal=document.querySelector('.incoming:not(.message-typing) .message-avatar img');return{avatars:rows.map(row=>{const a=row.querySelector('.message-avatar'),b=row.querySelector('.message-bubble');return{first:row.classList.contains('message-first'),opacity:getComputedStyle(a).opacity,delta:a.getBoundingClientRect().top-b.getBoundingClientRect().top}}),typingImage:!!img&&img.complete&&img.naturalWidth>0,sameAvatar:img?.src===normal?.src,dots:[...typing.querySelectorAll('.message-typing-indicator>div')].map(dot=>{const s=getComputedStyle(dot);return{width:parseFloat(s.width),height:parseFloat(s.height),transform:s.transform,duration:parseFloat(s.animationDuration),opacity:parseFloat(s.opacity)}}),font:getComputedStyle(document.body).fontFamily,size:getComputedStyle(document.body).fontSize,line:parseFloat(getComputedStyle(document.querySelector('.message-bubble')).lineHeight)}})()`);
 assert.ok(metrics.avatars.some(a=>!a.first),'fixture has a multi-part message');for(const a of metrics.avatars){assert.equal(a.opacity,a.first?'1':'0');assert.ok(Math.abs(a.delta)<1,JSON.stringify(a));}
 assert.equal(metrics.typingImage,true,'typing avatar loads an actual image');assert.equal(metrics.sameAvatar,true,'typing uses the normal agent avatar');assert.equal(metrics.dots.length,3);for(const dot of metrics.dots){assert.ok(dot.width<=4&&dot.height<=4&&dot.duration>=1.4&&dot.opacity<=.36,JSON.stringify(dot));assert.equal(dot.transform,'none','typing dots stay in place');}
 assert.match(metrics.font,/Noto Sans SC/);assert.equal(metrics.size,'16px');assert.ok(metrics.line>=24.7&&metrics.line<=24.9);await shot('typing-top-alignment');
 await browser('set','media','light','reduced-motion');await settle();assert.deepEqual(await js(`[...document.querySelectorAll('.message-typing-indicator>div')].map(e=>getComputedStyle(e).animationName)`),['none','none','none']);
 await f.holdProvider(false);await browser('wait','1000');await eventually(async()=>(await partner.snapshot()).pendingCount===0);await browser('wait','1000');assert.equal(await js('!!document.querySelector("[data-testid=companion-typing-indicator]")'),false);await shot('message-top-alignment');
 console.log('PASS: first-part-only avatars align with bubble tops, typing avatar loads, restrained stationary dots, reduced motion, original body typography and typing lifecycle');
}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});if(app)await app.close();await f.close()}
