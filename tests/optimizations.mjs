import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {installDOM} from '../extension/dom-capture.js';
import {ResourceBridge} from '../extension/resources.js';
import {DocumentState} from '../extension/document-state.js';
const font=await readFile(process.env.TEST_FONT_PATH||'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgH8AAAAASUVORK5CYII=','base64');
const hits=[];
const server=http.createServer(async(req,res)=>{
 if(['/extension/video-capture.js','/extension/video-layout.js'].includes(req.url)){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('..'+req.url,import.meta.url)));return;}
 hits.push(req.url);
 if(req.url==='/font.ttf'){res.setHeader('Content-Type','font/ttf');res.end(font);return;}
 if(['/image.png','/hidden.png'].includes(req.url)){res.setHeader('Content-Type','image/png');res.end(png);return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.end('<!doctype html><html><head><style>@font-face{font-family:UsedFont;src:url("/font.ttf") format("truetype"),url("/unused-alternative.woff2") format("woff2")}@font-face{font-family:UnusedFont;src:url("/unused-font.woff2")}#font{font-family:UsedFont}#background{width:40px;height:40px;background-image:url("/image.png")}</style></head><body><div id="font">Loaded font</div><input id="field"><img id="photo" src="/image.png"><div id="background"></div>'+Array.from({length:200},(_,i)=>'<div><span>row '+i+'</span></div>').join('')+'</body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const source=await browser.newPage();await source.goto('http://127.0.0.1:'+server.address().port);await source.evaluate(()=>document.fonts.ready);
 await source.evaluate(()=>{const hidden=document.createElement('div');hidden.id='hidden';hidden.style.display='none';hidden.innerHTML='<div style="width:40px;height:40px;background-image:url(/hidden.png)"></div>';document.body.append(hidden);});
 await source.evaluate(()=>{const columns=document.createElement('div');columns.id='columns';columns.style.cssText='width:200px;height:100px;column-count:2;column-gap:0';columns.innerHTML=Array.from({length:4},(_,i)=>'<div style="height:50px;break-inside:avoid">column '+i+'</div>').join('');document.body.append(columns);});
 const columnPositions=await source.locator('#columns>div').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().x));
 await source.evaluate(installDOM);const cdp=await source.context().newCDPSession(source);
 const bridge=new ResourceBridge((m,p)=>cdp.send(m,p),expression=>source.evaluate(expression));await bridge.scan();
 const initial=await source.evaluate(()=>__tabShareDOM.capture());
 assert.equal(initial.meta.truncated,false);
 assert.ok(initial.resources.some(r=>r.url.endsWith('/font.ttf')),'used, loaded font is forwarded');
 assert.ok(initial.resources.every(r=>!r.url.includes('unused-')),'unused faces and alternative sources are not requested');
 assert.ok(!hits.some(url=>url.includes('unused-')),'unused fonts are not fetched from the website');
 assert.ok(!initial.resources.some(r=>r.url.endsWith('/hidden.png')),'hidden responsive controls must not request unloaded images');
 await bridge.transfer(initial.resources,[],{});assert.equal(await source.evaluate(()=>__tabShareDOM.fallback().full),false);
 console.log('PASS: used fonts are shared; unused fonts do not trigger video or extra network requests');
 await source.evaluate(()=>{document.querySelector('#hidden').style.display='block';});
 await source.waitForFunction(()=>performance.getEntriesByName(location.origin+'/hidden.png').some(r=>r.responseEnd>0));
 const revealed=await source.evaluate(()=>__tabShareDOM.capture());assert.ok(revealed.resources.some(r=>r.url.endsWith('/hidden.png')));
 await bridge.transfer(revealed.resources,[],{});assert.equal(await source.evaluate(()=>__tabShareDOM.fallback().full),false);
 console.log('PASS: hidden background image is deferred until its control appears; no false full-page video');
 const changed=await source.evaluate(async()=>{const style=document.createElement('style');style.id='dynamic';style.textContent='@keyframes added{from{opacity:.1}to{opacity:1}}';document.head.append(style);await Promise.resolve();return __tabShareDOM.capture();});
 assert.ok(changed.cssChanged&&changed.css.includes('@keyframes added'));
 const removed=await source.evaluate(async()=>{document.querySelector('#dynamic').remove();await Promise.resolve();return __tabShareDOM.capture();});
 const state=new DocumentState();state.apply(initial);state.apply(revealed);state.apply(changed);state.apply(removed);assert.ok(!state.snapshot().css.includes('@keyframes added'));
 console.log('PASS: CSS-only additions and deletions reach current state and late joins');
 const visitor=await browser.newPage();await visitor.goto('http://127.0.0.1:'+server.address().port);
 const mirrorSource=(await readFile(new URL('../web/mirror.js',import.meta.url),'utf8')).replace('export class Mirror','globalThis.ReviewMirror=class Mirror');await visitor.evaluate(mirrorSource);
 const result=await visitor.evaluate(({initial,png})=>{
   const urls=new Map(),resources={resolve:v=>String(v).replace(/ts-asset:([A-Za-z0-9_-]+)/g,(_,id)=>urls.get(id)||'')};
   const mirror=new ReviewMirror(document,resources);mirror.apply(initial);
   const source=initial.nodes.find(n=>n.attrs?.id==='photo'),asset=source.attrs.src.slice(9);
   const raw=atob(png),data=Uint8Array.from(raw,c=>c.charCodeAt(0));urls.set(asset,URL.createObjectURL(new Blob([data],{type:'image/png'})));
   const field=document.querySelector('#field');field.value='local edit';mirror.localEdit(field);
   let writes=0;const original=CSSStyleDeclaration.prototype.setProperty;CSSStyleDeclaration.prototype.setProperty=function(...args){writes++;return original.apply(this,args);};
   const start=performance.now();mirror.refreshResources([asset]);const ms=performance.now()-start;
   const intact=field.value==='local edit',photo=document.querySelector('#photo').src,background=getComputedStyle(document.querySelector('#background')).backgroundImage;
   const id=document.querySelector('#background').dataset.nodeId;mirror.apply({version:initial.version,sequence:2,root:initial.root,updates:[{id,changes:{style:{'background-image':null}}}],meta:initial.meta});
   const pruned=!mirror.resourceUsers.get(asset)?.has(id);
   return {nodes:mirror.nodes.size,writes,ms,intact,photo,background,pruned,columnPositions:[...document.querySelectorAll('#columns>div')].map(n=>n.getBoundingClientRect().x)};
 },{initial,png:png.toString('base64')});
 assert.ok(result.writes<=3,'resource arrival must not rewrite unrelated styles');assert.equal(result.intact,true);assert.ok(result.photo.startsWith('blob:'));assert.ok(result.background.includes('blob:'));assert.equal(result.pruned,true);
 assert.deepEqual(result.columnPositions,columnPositions,'multi-column content must keep the same horizontal positions');
 console.log('PASS: targeted resource refresh:',result.nodes,'nodes,',result.writes,'style writes,',result.ms.toFixed(2),'ms; local input preserved');
 bridge.dispose();
 await source.bringToFront();
 const native=await source.evaluate(async()=>{
   const {NativeCapture}=await import('/extension/video-capture.js'),{videoLayout}=await import('/extension/video-layout.js');
   const source=document.createElement('canvas');source.width=640;source.height=360;document.body.append(source);
   const paint=()=>{const ctx=source.getContext('2d');ctx.fillStyle='blue';ctx.fillRect(0,0,640,360);ctx.fillStyle='red';ctx.fillRect(100,50,100,60);};paint();
   const timer=setInterval(paint,32),raw=source.captureStream(30).getVideoTracks()[0],c=new NativeCapture(raw);
   const layout=videoLayout({width:640,height:360,scrollX:0,scrollY:0,full:false,regions:[{id:'a',x:100,y:50,width:100,height:60}]});
   try{
     c.setLayout(layout);c.setActive(true);
     const end=performance.now()+5000;while(c.canvas.width!==100&&performance.now()<end)await new Promise(resolve=>setTimeout(resolve,25));
     const region={width:c.canvas.width,height:c.canvas.height,pixel:[...c.canvas.getContext('2d').getImageData(20,20,1,1).data],cropped:c.track!==raw};
     c.setLayout(videoLayout({...layout,full:true}));const direct=c.track===raw;
     c.setLayout(layout);c.setFPS(2);let frames=0;const request=c.cropped.requestFrame.bind(c.cropped);c.cropped.requestFrame=()=>{frames++;request();};
     await new Promise(resolve=>setTimeout(resolve,2200));const hiddenFrames=frames;
     c.setActive(false);const paused=!raw.enabled&&!c.cropped.enabled;
     const before=frames;await new Promise(resolve=>setTimeout(resolve,250));const idle=frames===before;
     c.setFPS(30);c.setActive(true);await new Promise(resolve=>setTimeout(resolve,100));c.stop();
     return {region,direct,hiddenFrames,paused,idle,released:raw.readyState==='ended'&&c.cropped.readyState==='ended'&&c.video.srcObject===null};
   }finally{clearInterval(timer);c.stop();source.remove();}
 });
 assert.deepEqual(native.region,{width:100,height:60,pixel:[255,0,0,255],cropped:true});assert.equal(native.direct,true);
 assert.ok(native.hiddenFrames>=1&&native.hiddenFrames<=6,'background native frames stay bounded');assert.ok(native.paused&&native.idle&&native.released);
 console.log('PASS: native MediaStreamTrack region pixels, direct full-frame switching, background frames, pause and track cleanup');
 const large=await browser.newPage();await large.goto('http://127.0.0.1:'+server.address().port);
 const limited=await large.evaluate(async install=>{
   document.body.replaceChildren();let parent=document.body;for(let i=0;i<30;i++){const n=document.createElement('div');parent.append(n);parent=n;}
   for(let i=0;i<4000;i++)parent.append(document.createTextNode('node '+i));
   Object.defineProperty(crypto,'randomUUID',{configurable:true,value:undefined});(0,eval)(install);
   const first=__tabShareDOM.capture();parent.append(document.createTextNode('later'));
   await Promise.resolve();const next=__tabShareDOM.capture(true);
   return {first,next,full:__tabShareDOM.fallback().full};
 },installDOM);
 assert.equal(limited.first.meta.truncated,true);assert.equal(limited.first.nodes.length,1);assert.ok(limited.full);assert.equal(limited.next,null);
 assert.match(limited.first.version,/^[0-9a-f]{32}$/);
 console.log('PASS: large nested DOM produces only video metadata, no repeated partial snapshots; UUID fallback uses Web Crypto');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
