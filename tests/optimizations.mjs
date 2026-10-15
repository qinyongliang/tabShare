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
 if(req.url==='/icons'){res.setHeader('Content-Type','text/html');res.end(await readFile(new URL('./fixtures/icons.html',import.meta.url)));return;}
 if(req.url==='/placeholders'){res.setHeader('Content-Type','text/html');res.end(await readFile(new URL('./fixtures/placeholders.html',import.meta.url)));return;}
 if(req.url==='/icon.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M10 0L20 20H0Z"/></svg>');return;}
 if(req.url==='/sprite.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint:star"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><symbol id="star" viewBox="0 0 20 20"><path fill="url(&quot;#paint:star&quot;)" d="M10 0L13 7H20L15 12L17 20L10 16L3 20L5 12L0 7H7Z"/></symbol></svg>');return;}
 if(req.url==='/trusted'){res.setHeader('Content-Security-Policy',"require-trusted-types-for 'script'");res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>Trusted Types page</body>');return;}
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
 const chunks=[];let chunk;do{chunk=await source.evaluate(()=>__tabShareDOM.capture());if(chunk)chunks.push(chunk);}while(chunk?.meta.pending);
 const initialState=new DocumentState();for(const c of chunks)initialState.apply(c);
 const initial={...initialState.snapshot(),resources:chunks.flatMap(c=>c.resources||[])};
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
 const cleanReset=await visitor.evaluate(initial=>{const mirror=new ReviewMirror(document);document.body.style.margin='8px';mirror.apply({...initial,reset:true,css:':where([data-node-id]){margin:0px}',nodes:[{id:initial.root,tag:'body',children:[],style:{},attrs:{}}]});return getComputedStyle(document.body).margin;},initial);
 assert.equal(cleanReset,'0px','reset must remove old root styles before applying compact defaults');
 const trusted=await browser.newPage();await trusted.goto('http://127.0.0.1:'+server.address().port+'/trusted');await trusted.evaluate(installDOM);
 assert.ok(await trusted.locator('[data-tabshare-owner-ui]').count());await trusted.close();
 console.log('PASS: compact root reset clears stale margins; owner UI initializes with Trusted Types enforcement');
 const icons=await browser.newPage();await icons.goto('http://127.0.0.1:'+server.address().port+'/icons');await icons.evaluate(installDOM);
 const iconCDP=await icons.context().newCDPSession(icons),iconBridge=new ResourceBridge((m,p)=>iconCDP.send(m,p),expression=>icons.evaluate(expression));await iconBridge.scan();
 const iconChunks=[];do{chunk=await icons.evaluate(()=>__tabShareDOM.capture());if(chunk)iconChunks.push(chunk);}while(chunk?.meta.pending);
 const iconAssets=[];await iconBridge.transfer(iconChunks.flatMap(c=>c.resources||[]),['test'],{deliver:async(session,id,item)=>{iconAssets.push({id,mime:item.mime,data:Buffer.from(item.bytes).toString('base64')});return false;}});
 assert.ok(iconAssets.some(a=>a.mime==='image/svg+xml'),'loaded SVG masks and external symbols are forwarded');
 assert.ok(!iconChunks.flatMap(c=>c.resources||[]).some(r=>r.url.endsWith('/icons#round')||r.url.endsWith('/icons#brand')),'local paint servers must not become network assets');
 const iconMirror=await browser.newPage();await iconMirror.goto('http://127.0.0.1:'+server.address().port);await iconMirror.evaluate(mirrorSource);
 await iconMirror.evaluate((await readFile(new URL('../web/resources.js',import.meta.url),'utf8')).replace('export class Resources','globalThis.ReviewResources=class Resources'));
 await iconMirror.evaluate(async({chunks,assets})=>{const resources=new ReviewResources('test','test',()=>{});resources.keepVersion(chunks[0].version);for(const a of assets){const bytes=Uint8Array.from(atob(a.data),c=>c.charCodeAt(0)),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');await resources.add({id:a.id,mime:a.mime,size:bytes.length,sha256},bytes);}const mirror=new ReviewMirror(document,resources);for(const c of chunks)mirror.apply(c);}, {chunks:iconChunks,assets:iconAssets});
 await iconMirror.waitForTimeout(200);
 for(const selector of ['#logo','#google','#github','#sprite','#external','#mask','#inline']){
   const images=await Promise.all([icons,iconMirror].map(async p=>(await p.locator(selector).screenshot()).toString('base64')));
   const diff=await iconMirror.evaluate(async images=>{const bitmaps=await Promise.all(images.map(async data=>createImageBitmap(await(await fetch('data:image/png;base64,'+data)).blob())));const pixels=bitmaps.map(b=>{const c=document.createElement('canvas');c.width=b.width;c.height=b.height;const x=c.getContext('2d');x.drawImage(b,0,0);return x.getImageData(0,0,c.width,c.height).data;});let changed=0;for(let i=0;i<pixels[0].length;i+=4)if([0,1,2].some(k=>Math.abs(pixels[0][i+k]-pixels[1][i+k])>12))changed++;return {sameSize:bitmaps[0].width===bitmaps[1].width&&bitmaps[0].height===bitmaps[1].height,ratio:changed/(pixels[0].length/4)};},images);
   if(!diff.sameSize||diff.ratio>=.01)console.log('Icon diagnostic:',selector,await Promise.all([icons,iconMirror].map(p=>p.locator(selector).evaluate(n=>{const icon=n.querySelector('span');return {html:n.outerHTML,mask:icon&&getComputedStyle(icon).maskImage};}))),iconAssets.map(a=>({id:a.id,mime:a.mime,size:a.data.length})));
   assert.ok(diff.sameSize&&diff.ratio<.01,selector+' icon geometry and pixels must match: '+JSON.stringify(diff));
 }
 iconBridge.dispose();await icons.close();await iconMirror.close();
 console.log('PASS: native SVG logos, currentColor paths, gradients/clips, local/external symbols and CSS SVG masks retain source geometry and pixels');
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
   const batches=[];let d;do{d=__tabShareDOM.capture();if(d)batches.push(d);}while(d?.meta.pending);
   parent.append(document.createTextNode('later'));await Promise.resolve();const next=__tabShareDOM.capture();
   return {batches,next,full:__tabShareDOM.fallback().full};
 },installDOM);
 assert.ok(limited.batches.length>1);assert.ok(limited.batches.every(d=>d.nodes.length<=300&&!d.meta.truncated));
 assert.equal(limited.batches.reduce((n,d)=>n+d.nodes.length,0),4031);assert.equal(limited.full,false);
 assert.ok(limited.next.nodes.some(n=>n.text==='later'));assert.match(limited.batches[0].version,/^[0-9a-f]{32}$/);
 const incremental=await visitor.evaluate(batches=>{const mirror=new ReviewMirror(document);for(const batch of batches)mirror.apply(batch);return {text:document.body.textContent,nodes:mirror.nodes.size};},limited.batches);
 assert.equal(incremental.nodes,4031);assert.ok(incremental.text.includes('node 3999'));
 console.log('PASS: large nested DOM streams in bounded incremental batches; late children attach; DOM stays active');

 const bulk=await browser.newPage();await bulk.goto('http://127.0.0.1:'+server.address().port);
 const bulkResult=await bulk.evaluate(async install=>{document.body.replaceChildren();for(let i=0;i<1200;i++){const n=document.createElement('div');n.style.cssText='padding:4px;border:1px solid #888;background:rgb(240,245,250);font:16px system-ui;color:rgb(30,50,70)';n.textContent='Row '+i;document.body.append(n);}(0,eval)(install);let d,raw=0,packed=0,batches=0;const start=performance.now();do{d=__tabShareDOM.capture();if(!d)break;batches++;packed+=JSON.stringify(d).length;const expand=v=>{if(v.styleRef===undefined)return v;const {styleRef,...rest}=v;return {...rest,style:d.styles[styleRef]};};raw+=JSON.stringify({...d,styles:undefined,nodes:d.nodes.map(expand),updates:d.updates.map(u=>({...u,changes:expand(u.changes)}))}).length;}while(d.meta.pending);return {raw,packed,batches,ms:performance.now()-start,idle:__tabShareDOM.capture()};},installDOM);
 assert.ok(bulkResult.packed<bulkResult.raw*.55,'repeated styles must substantially reduce raw DOM payload');assert.equal(bulkResult.idle,null,'packing must not mutate retained diff state');console.log('PASS: 1200-row style pooling:',bulkResult.raw,'→',bulkResult.packed,'JSON bytes,',bulkResult.batches,'batches,',bulkResult.ms.toFixed(0),'ms capture');
 const prioritized=await bulk.evaluate(async()=>{const input=document.createElement('input');input.id='priority-input';document.body.append(input);input.focus({preventScroll:true});await Promise.resolve();let d,registered=false;do{d=__tabShareDOM.capture();registered ||= !!d?.nodes.some(n=>n.attrs?.id==='priority-input');}while(d?.meta.pending);document.body.style.padding='12px';input.value='Immediate feedback';input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'Immediate feedback'}));await Promise.resolve();const next=__tabShareDOM.capture();return {registered,firstValue:next.updates[0]?.changes.value,pending:next.meta.pending};});
 if(prioritized.firstValue!=='Immediate feedback')console.log('Priority diagnostic:',prioritized);
 assert.equal(prioritized.registered,true);assert.equal(prioritized.firstValue,'Immediate feedback','input feedback must precede a large dirty subtree');assert.equal(prioritized.pending,true);await bulk.close();

 const caret=await source.evaluate(()=>{const input=document.createElement('input');input.style.cssText='position:fixed;left:120px;top:80px;width:300px;height:40px;padding:4px;border:1px solid;font:20px monospace';input.value='abcdef';document.body.append(input);input.focus();input.setSelectionRange(0,0);const a=__tabShareDOM.capture().meta.caret;input.setSelectionRange(3,3);const b=__tabShareDOM.capture().meta.caret;const c=document.createElement('canvas').getContext('2d');c.font=getComputedStyle(input).font;const advance=c.measureText('abc').width;input.setSelectionRange(1,4);const selection=__tabShareDOM.capture().meta.selection;return {a,b,advance,selection};});
 assert.ok(Math.abs(caret.b.x-caret.a.x-caret.advance)<1,'input caret tracks the insertion position');assert.ok(caret.b.y>=80&&caret.b.y<120);assert.equal(caret.selection.text,'bcd');
 await visitor.evaluate((await readFile(new URL('../web/remote-input.js',import.meta.url),'utf8')).replace('export class RemoteInput','globalThis.ReviewRemoteInput=class RemoteInput'));
 await visitor.addStyleTag({content:await readFile(new URL('../web/style.css',import.meta.url),'utf8')});
 const ime=await visitor.evaluate(()=>{const frame=document.createElement('iframe');frame.style.cssText='position:fixed;left:40px;top:60px;width:600px;height:300px;border:0;transform:scale(.5);transform-origin:top left';document.body.append(frame);const sent=[],remote=new ReviewRemoteInput(document,frame,m=>sent.push(m),()=>{});remote.activate(100,100);remote.update({caret:{x:120,y:80,height:24,fontSize:20}});const r=remote.box.getBoundingClientRect();remote.box.dispatchEvent(new CompositionEvent('compositionstart'));remote.box.dispatchEvent(new CompositionEvent('compositionend',{data:'中文'}));remote.box.dispatchEvent(new InputEvent('beforeinput',{data:'中文',inputType:'insertFromComposition',cancelable:true}));remote.release();return {x:r.x,y:r.y,height:r.height,sent,hidden:remote.box.hidden};});
 assert.ok(Math.abs(ime.x-100)<1&&Math.abs(ime.y-100)<1&&Math.abs(ime.height-12)<1,'IME proxy uses scaled viewport caret coordinates');assert.deepEqual(ime.sent,[{action:'text',text:'中文'}]);assert.equal(ime.hidden,true);
 console.log('PASS: caret geometry and selected text; scaled IME proxy commits composition once at the remote caret');

 const placeholderSource=await browser.newPage(),placeholderMirror=await browser.newPage();
 await placeholderSource.goto('http://127.0.0.1:'+server.address().port+'/placeholders');await placeholderSource.evaluate(installDOM);
 await placeholderSource.evaluate(()=>{const unrelated=document.querySelector('#unrelated');for(let i=0;i<1000;i++)unrelated.append(document.createElement('span'));});
 await placeholderMirror.goto('http://127.0.0.1:'+server.address().port);await placeholderMirror.evaluate(mirrorSource);await placeholderMirror.evaluate(()=>{globalThis.placeholderMirror=new ReviewMirror(document);});
 async function syncPlaceholders(){const batches=await placeholderSource.evaluate(()=>{const batches=[];let d;do{d=__tabShareDOM.capture();if(d)batches.push(d);}while(d?.meta.pending);return batches;});await placeholderMirror.evaluate(batches=>{for(const d of batches)placeholderMirror.apply(d);},batches);return batches;}
 await syncPlaceholders();
 assert.equal(await placeholderMirror.locator('#hint').evaluate(n=>getComputedStyle(n).opacity),'1');
 await placeholderSource.locator('#plain').fill('a');const firstInput=await syncPlaceholders();
 assert.equal(await placeholderMirror.locator('#hint').evaluate(n=>getComputedStyle(n).opacity),'0','typing must hide a CSS placeholder outside the input');
 assert.equal(await placeholderMirror.locator('#outline').evaluate(n=>getComputedStyle(n).color),'rgb(20, 80, 200)','focus-within styles follow input focus');
 assert.ok(firstInput.every(d=>!d.reset),'placeholder updates use differences');
 const typingCost=await placeholderSource.evaluate(()=>{const original=globalThis.getComputedStyle;let unrelated=0;globalThis.getComputedStyle=(node,...args)=>{if(document.querySelector('#unrelated').contains(node))unrelated++;return original(node,...args);};const node=document.querySelector('#plain');node.value='ab';node.dispatchEvent(new InputEvent('input',{bubbles:true,data:'b'}));const d=__tabShareDOM.capture();globalThis.getComputedStyle=original;return {unrelated,updated:d?.updates?.length||0,nodes:d?.nodes?.length||0,reset:d?.reset};});
 assert.equal(typingCost.unrelated,0,'ordinary typing must not rescan unrelated computed styles');assert.equal(typingCost.nodes,0);assert.equal(typingCost.updated,1);assert.equal(typingCost.reset,false);
 const cssScanCost=await placeholderSource.evaluate(()=>{const descriptor=Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype,'cssRules');let scans=0;Object.defineProperty(CSSStyleSheet.prototype,'cssRules',{...descriptor,get(){scans++;return descriptor.get.call(this);}});try{const n=document.querySelector('#plain');n.value='abc';n.dispatchEvent(new InputEvent('input',{bubbles:true,data:'c'}));__tabShareDOM.capture();return scans;}finally{Object.defineProperty(CSSStyleSheet.prototype,'cssRules',descriptor);}});
 assert.equal(cssScanCost,0,'typing must reuse unchanged stylesheet indexes');
 await placeholderSource.locator('#plain').fill('');await syncPlaceholders();assert.equal(await placeholderMirror.locator('#hint').evaluate(n=>getComputedStyle(n).opacity),'1','clearing restores the placeholder');
 await placeholderSource.locator('#rich').fill('hello');await syncPlaceholders();assert.equal(await placeholderMirror.locator('#rich-field').evaluate(n=>getComputedStyle(n,'::before').content),'none','typing removes an ancestor pseudo-element placeholder');
 await placeholderSource.locator('#rich').evaluate(n=>{n.replaceChildren();n.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));});await syncPlaceholders();assert.equal(await placeholderMirror.locator('#rich-field').evaluate(n=>getComputedStyle(n,'::before').content),'"请输入内容"','clearing restores the pseudo-element placeholder');
 await placeholderSource.locator('#hover').hover();await syncPlaceholders();assert.equal(await placeholderMirror.locator('#hover').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(10, 90, 160)');assert.equal(await placeholderMirror.locator('#hover-hint').evaluate(n=>getComputedStyle(n).opacity),'1','hover updates sibling styles outside the target');
 await placeholderSource.mouse.move(1200,700);await syncPlaceholders();assert.equal(await placeholderMirror.locator('#hover-hint').evaluate(n=>getComputedStyle(n).opacity),'0','leaving resets hover styles');
 await placeholderMirror.evaluate((await readFile(new URL('../web/pointer.js',import.meta.url),'utf8')).replace('export class PointerForwarder','globalThis.ReviewPointerForwarder=class PointerForwarder'));
 const pointerResult=await placeholderMirror.evaluate(async()=>{
   const frame=document.createElement('iframe');frame.style.cssText='position:fixed;left:40px;top:60px;width:600px;height:300px;transform:scale(.5);transform-origin:top left';document.body.append(frame);await new Promise(resolve=>{if(frame.contentDocument.readyState==='complete')resolve();else frame.onload=resolve;});
   const sent=[],doc=frame.contentDocument,pointer=new ReviewPointerForwarder(doc,frame,m=>sent.push(m));const node=doc.createElement('div');doc.body.append(node);
   const move=(x,y)=>node.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:x,clientY:y,pointerType:'mouse',buttons:0}));
   move(120,80);move(130,90);move(140,100);await new Promise(resolve=>setTimeout(resolve,60));const tail=sent.at(-1);
   node.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));const descendantLeave=sent.at(-1).action;
   move(150,110);frame.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));await new Promise(resolve=>setTimeout(resolve,60));const end=sent.at(-1),count=sent.length;
   pointer.dispose();move(200,200);frame.remove();return {tail,descendantLeave,end,count,disposed:sent.length===count};
 });
 assert.equal(pointerResult.tail.x,140);assert.equal(pointerResult.tail.y,100);assert.ok(!pointerResult.tail.nodeId,'movement uses viewport coordinates');assert.equal(pointerResult.descendantLeave,'mouseMoved');assert.equal(pointerResult.end.action,'mouseLeave');assert.ok(pointerResult.count<=4);assert.equal(pointerResult.disposed,true);
 for(const title of ['Dynamic title 标题','', 'Restored title']){
   await placeholderSource.evaluate(title=>{document.title=title;},title);const batches=await syncPlaceholders();assert.equal(await placeholderMirror.title(),title,'mirror title follows updates and clearing');assert.equal(batches.at(-1).meta.title,title);assert.ok(batches.every(d=>!d.reset&&!d.nodes.length&&!d.updates.length),'title-only changes never recapture the body');
 }
 const shadowCleanup=await placeholderSource.evaluate(async()=>{const host=document.createElement('div');document.body.append(host);const root=host.attachShadow({mode:'open'}),style=document.createElement('style');style.textContent='@keyframes detachedComponent {from{opacity:0}to{opacity:1}}';root.append(style,document.createElement('span'));await Promise.resolve();let d,added=false;do{d=__tabShareDOM.capture();added ||= !!d?.css?.includes('detachedComponent');}while(d?.meta.pending);host.remove();await Promise.resolve();const removed=__tabShareDOM.capture();return {added,changed:removed?.cssChanged,retained:!!removed?.css?.includes('detachedComponent')};});
 assert.equal(shadowCleanup.added,true);assert.equal(shadowCleanup.changed,true);assert.equal(shadowCleanup.retained,false,'unmounted Shadow DOM must release cached stylesheet rules');
 const wakes=await placeholderSource.evaluate(async()=>{const signals=[];globalThis.__tabShareWake=signal=>signals.push(JSON.parse(signal));const timer=globalThis.setTimeout;globalThis.setTimeout=()=>{throw Error('Wake must not depend on a throttled page timer');};try{const node=document.querySelector('#unrelated');node.textContent='One';node.textContent='Two';await Promise.resolve();await Promise.resolve();return signals;}finally{globalThis.setTimeout=timer;delete globalThis.__tabShareWake;}});
 assert.equal(wakes.length,1,'synchronous mutations share one wakeup');assert.equal(wakes[0].urgent,true);
 await placeholderMirror.evaluate((await readFile(new URL('../web/popups.js',import.meta.url),'utf8')).replace('export class PopupWindows','globalThis.ReviewPopupWindows=class PopupWindows'));
 const blockedPopup=await placeholderMirror.evaluate(()=>{const settings=document.createElement('aside');settings.id='share-settings';settings.hidden=true;const list=document.createElement('div');list.id='shared-pages';settings.append(list);document.body.append(settings);const popups=new ReviewPopupWindows(document,()=>null),id='a'.repeat(43),key='b'.repeat(43),popup={id,shareUrl:location.origin+'/s/'+id+'#'+key,title:'Child page'};popups.receive(popup);popups.receive(popup);popups.receive({id:'c'.repeat(43),shareUrl:'https://example.com/s/'+id+'#'+key});return {links:list.querySelectorAll('a').length,visible:!settings.hidden,url:list.querySelector('a').href};});
 assert.equal(blockedPopup.links,1);assert.equal(blockedPopup.visible,true);assert.ok(blockedPopup.url.includes('?popup=1#'),'blocked popups retain a native link without duplicates');
 await placeholderSource.close();await placeholderMirror.close();
 console.log('PASS: placeholders hide/restore, focus and sibling hover styles synchronize; ordinary typing updates one control without scanning 1000 unrelated elements');
 console.log('PASS: viewport pointer positions preserve the trailing move; leaving cancels pending moves and resets source hover');
 console.log('PASS: title updates and clearing carry metadata only; ordinary typing performs zero stylesheet scans');

}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
