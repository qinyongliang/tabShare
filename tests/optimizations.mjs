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
const server=http.createServer((req,res)=>{
 hits.push(req.url);
 if(req.url==='/font.ttf'){res.setHeader('Content-Type','font/ttf');res.end(font);return;}
 if(req.url==='/image.png'){res.setHeader('Content-Type','image/png');res.end(png);return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.end('<!doctype html><html><head><style>@font-face{font-family:UsedFont;src:url("/font.ttf") format("truetype"),url("/unused-alternative.woff2") format("woff2")}@font-face{font-family:UnusedFont;src:url("/unused-font.woff2")}#font{font-family:UsedFont}#background{width:40px;height:40px;background-image:url("/image.png")}</style></head><body><div id="font">Loaded font</div><input id="field"><img id="photo" src="/image.png"><div id="background"></div>'+Array.from({length:200},(_,i)=>'<div><span>row '+i+'</span></div>').join('')+'</body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const source=await browser.newPage();await source.goto('http://127.0.0.1:'+server.address().port);await source.evaluate(()=>document.fonts.ready);
 await source.evaluate(installDOM);const cdp=await source.context().newCDPSession(source);
 const bridge=new ResourceBridge((m,p)=>cdp.send(m,p),expression=>source.evaluate(expression));await bridge.scan();
 const initial=await source.evaluate(()=>__tabShareDOM.capture());
 assert.equal(initial.meta.truncated,false);
 assert.ok(initial.resources.some(r=>r.url.endsWith('/font.ttf')),'used, loaded font is forwarded');
 assert.ok(initial.resources.every(r=>!r.url.includes('unused-')),'unused faces and alternative sources are not requested');
 assert.ok(!hits.some(url=>url.includes('unused-')),'unused fonts are not fetched from the website');
 await bridge.transfer(initial.resources,[],{});assert.equal(await source.evaluate(()=>__tabShareDOM.fallback().full),false);
 console.log('PASS: used fonts are shared; unused fonts do not trigger video or extra network requests');
 const changed=await source.evaluate(async()=>{const style=document.createElement('style');style.id='dynamic';style.textContent='@keyframes added{from{opacity:.1}to{opacity:1}}';document.head.append(style);await Promise.resolve();return __tabShareDOM.capture();});
 assert.ok(changed.cssChanged&&changed.css.includes('@keyframes added'));
 const removed=await source.evaluate(async()=>{document.querySelector('#dynamic').remove();await Promise.resolve();return __tabShareDOM.capture();});
 const state=new DocumentState();state.apply(initial);state.apply(changed);state.apply(removed);assert.ok(!state.snapshot().css.includes('@keyframes added'));
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
   return {nodes:mirror.nodes.size,writes,ms,intact,photo,background,pruned};
 },{initial,png:png.toString('base64')});
 assert.ok(result.writes<=3,'resource arrival must not rewrite unrelated styles');assert.equal(result.intact,true);assert.ok(result.photo.startsWith('blob:'));assert.ok(result.background.includes('blob:'));assert.equal(result.pruned,true);
 console.log('PASS: targeted resource refresh:',result.nodes,'nodes,',result.writes,'style writes,',result.ms.toFixed(2),'ms; local input preserved');
 bridge.dispose();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
