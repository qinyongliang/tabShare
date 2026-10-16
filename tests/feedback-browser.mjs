import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {installDOM} from '../extension/dom-capture.js';
const sourceHTML='<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><h1>Chart dashboard</h1><svg id="chart" width="1000" height="600" viewBox="0 0 1000 600"><g transform="translate(10,20)">'+Array.from({length:3000},(_,i)=>'<rect x="'+(i%200)*4+'" y="'+Math.floor(i/200)*8+'" width="3" height="6" fill="'+(i%2?'#335fea':'#ea5685')+'"/>').join('')+'<text id="chart-label" x="20" y="200" fill="#17233a" font-size="18">Weekly Retention</text></g></svg><p id="after">All chart content loaded</p></body></html>';
const shell="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'";
const mirrorCSP="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin";
const server=http.createServer(async(req,res)=>{
 try{
  const path=req.url.split('?')[0];
  res.setHeader('Content-Security-Policy',path==='/mirror.html'?mirrorCSP:shell);
  if(path.startsWith('/web/')&&/^[a-z-]+\.(js|css)$/.test(path.slice(5))){res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(new URL('..'+path,import.meta.url)));return;}
  if(path==='/feedback-fixture.css'){res.setHeader('Content-Type','text/css');res.end('#display-area{position:relative;margin-top:30px;width:1000px;height:800px;overflow:hidden}#mirror{position:relative;width:1000px;height:800px}');return;}
  if(path==='/fixture.css'){res.setHeader('Content-Type','text/css');res.end('body{margin:0;color:#17233a;font:16px sans-serif}svg{display:block}');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(path==='/source'){res.end(sourceHTML);return;}
  if(path==='/mirror.html'){res.end('<!doctype html><html><head></head><body></body></html>');return;}
  res.end('<!doctype html><html><head><link rel="stylesheet" href="/web/style.css"><link rel="stylesheet" href="/feedback-fixture.css"></head><body><button id="click">Action</button><div id="sync-feedback" role="status" hidden><span class="sync-spinner"></span></div><div id="display-area"><iframe id="mirror" sandbox="allow-same-origin" src="/mirror.html" width="1000" height="800"></iframe></div></body></html>');
 }catch(error){res.statusCode=500;res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const origin='http://127.0.0.1:'+server.address().port,viewer=await browser.newPage({viewport:{width:1200,height:900}}),source=await browser.newPage({viewport:{width:1200,height:900}});
 const errors=[];viewer.on('pageerror',error=>errors.push(error.message));viewer.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await viewer.goto(origin);await viewer.frameLocator('#mirror').locator('body').waitFor({state:'attached'});
 const asset=await viewer.evaluate(async()=>{
  const {Resources}=await import('/web/resources.js');const frame=document.querySelector('#mirror');
  const resources=new Resources('test','test',()=>{});resources.setDocument(frame.contentDocument);resources.keepVersion('doc');
  const bytes=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><style>.paint{fill:rgb(234,86,133)}</style><rect class="paint" width="20" height="20"/></svg>');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  await resources.add({id:'doc_0',size:bytes.length,mime:'image/svg+xml',sha256},bytes);
  const image=frame.contentDocument.createElement('img');image.src=resources.resolve('ts-asset:doc_0');frame.contentDocument.body.append(image);await image.decode();
  const canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;const context=canvas.getContext('2d');context.drawImage(image,0,0);
  const result={pixel:[...context.getImageData(5,5,1,1).data],sandbox:frame.getAttribute('sandbox')};resources.dispose();return result;
 });
 assert.deepEqual(asset.pixel,[234,86,133,255],'SVG style survives parsing without weakening shell CSP');assert.equal(asset.sandbox,'allow-same-origin');
 assert.ok(!errors.some(message=>/Applying inline style|style-src/.test(message)),errors.join('\n'));
 console.log('PASS: SVG stylesheet pixels render under strict viewer CSP and script-disabled mirror');
 await viewer.evaluate(async()=>{
  const {SyncFeedback}=await import('/web/feedback.js');globalThis.feedback=new SyncFeedback(document.querySelector('#sync-feedback'),document.documentElement);
  document.querySelector('#click').onclick=()=>{globalThis.requestId=feedback.begin();};
 });
 await viewer.locator('#click').click();
 const immediate=await viewer.locator('#sync-feedback').evaluate(element=>({visible:!element.hidden,text:element.textContent,animation:getComputedStyle(element.querySelector('.sync-spinner')).animationName,transform:getComputedStyle(element.querySelector('.sync-spinner')).transform}));
 assert.deepEqual(errors,[]);assert.equal(immediate.visible,true);assert.equal(immediate.text,'');assert.equal(immediate.animation,'ts-spin');
 await viewer.waitForTimeout(100);const transform=await viewer.locator('.sync-spinner').evaluate(element=>getComputedStyle(element).transform);assert.notEqual(transform,immediate.transform);
 await viewer.evaluate(()=>feedback.acknowledge(requestId,'accepted'));await viewer.locator('#sync-feedback').waitFor({state:'hidden',timeout:2000});
 await viewer.evaluate(()=>feedback.progress({version:'building',meta:{pending:true}}));assert.equal(await viewer.locator('#display-area').evaluate(element=>getComputedStyle(element).visibility),'hidden');
 await viewer.evaluate(()=>feedback.progress({version:'building',meta:{pending:false}}));assert.equal(await viewer.locator('#display-area').evaluate(element=>getComputedStyle(element).visibility),'visible');
 console.log('PASS: immediate native CSS animation, correlated ACK, coherent initial reveal');
 await source.goto(origin+'/source');await source.evaluate(installDOM);
 const start=Date.now(),chunks=[];let chunk;
 do{chunk=await source.evaluate(()=>__tabShareDOM.capture());if(chunk)chunks.push(chunk);}while(chunk?.meta.pending&&chunks.length<500);
 assert.equal(chunk.meta.pending,false);assert.equal(chunk.meta.truncated,false);
 const nodes=chunks.flatMap(chunk=>chunk.nodes);assert.equal(nodes.filter(node=>node.tag==='rect').length,3000);assert.ok(nodes.some(node=>node.text==='Weekly Retention'));
 await viewer.evaluate(async chunks=>{const {Mirror}=await import('/web/mirror.js');const frame=document.querySelector('#mirror'),meta=chunks[0].meta;frame.style.width=meta.width+'px';frame.style.height=meta.height+'px';frame.style.transform='scale('+(1000/meta.width)+')';const mirror=new Mirror(frame.contentDocument,{resolve:value=>value});for(const chunk of chunks)mirror.apply(chunk);},chunks);
 const actual=viewer.frameLocator('#mirror');assert.equal(await actual.locator('#chart rect').count(),3000);assert.equal(await actual.locator('#chart-label').textContent(),'Weekly Retention');
 const viewportOf=locator=>locator.evaluate(node=>({width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,scrollHeight:node.scrollHeight}));
 const viewport=await viewportOf(actual.locator('html')),sourceViewport=await viewportOf(source.locator('html'));assert.deepEqual(viewport,sourceViewport,'mirror keeps the source CSS viewport; fit is applied outside the iframe');
 const geometry=async locator=>locator.evaluate(node=>{const r=node.getBBox(),s=getComputedStyle(node);return{x:r.x,y:r.y,width:r.width,height:r.height,fill:s.fill,fontSize:s.fontSize};});
 assert.deepEqual(await geometry(actual.locator('#chart-label')),await geometry(source.locator('#chart-label')));
 assert.equal(await actual.locator('#after').textContent(),'All chart content loaded');
 console.log('PASS: 3000 native SVG nodes + labels, no truncation; capture',JSON.stringify({frames:chunks.length,wireBytes:Buffer.byteLength(JSON.stringify(chunks)),wallMs:Date.now()-start}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
