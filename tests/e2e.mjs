import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import {serverOrigin,targetURL,resolveTab,cdpInput} from '../extension/controller.js';
import {installDOM,captureDOM} from '../extension/dom-capture.js';
import {ResourceBridge} from '../extension/resources.js';
import {chromium} from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'tabshare-e2e-'));
const browserPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
let source, server, visitors, cdp, fixture, assets, shutdownAgent;
let assetOrigin;const assetHits=[];
const timers=new Set();
let serverLog = '', sourceLog = '';
const state = {clicks: 0, text: '', loads: 0, path: '', cookie: '', scroll: 0, choice:'a', checked:false, canvasClicks:0};
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const result = await check(); if (result) return result; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.pending = new Map(); this.id = 0; this.listeners=[];
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => { const m = JSON.parse(event.data); if (!m.id) {for(const listener of this.listeners)listener(m);return;} const call = this.pending.get(m.id); if (!call) return; this.pending.delete(m.id); clearTimeout(call.timer); if (m.error) call.reject(new Error(m.error.message)); else call.resolve(m.result); };
  }
  async call(method, params = {}, sessionId) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      this.pending.set(id, {resolve, reject, timer}); this.ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  async evaluate(session, expression) {
    const result = await this.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true}, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.result?.description);
    return result.result.value;
  }
  close() { this.ws.close(); }
}
async function stop(process) {
  if (!process || process.exitCode !== null) return;
  process.kill('SIGTERM'); await until(() => process.exitCode !== null || process.signalCode !== null, 'child exit', 5000);
}
const listen = await freePort();
const origin = `http://localhost:${listen}`;
function startServer() {
  server = spawn(path.join(root, 'bin/tabshare'), ['-listen', `127.0.0.1:${listen}`, '-data', path.join(temporary, 'data'), '-public-url', origin], {cwd: root, stdio: ['ignore', 'ignore', 'pipe']});
  server.stderr.on('data', data => { serverLog += data.toString(); });
}
try {
  const font=await readFile(process.env.TEST_FONT_PATH||'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  assets=http.createServer((req,res)=>{assetHits.push({url:req.url,cookie:req.headers.cookie||''});
    if(req.url==='/font.ttf'){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','font/ttf');res.end(font);return;}
    if(req.url==='/styles.css'){res.setHeader('Content-Type','text/css');res.end('@font-face{font-family:SharedFont;src:url("/font.ttf")}#badge{font-family:SharedFont}');return;}
    res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#ea5685"/></svg>');
  });await new Promise(resolve=>assets.listen(0,'127.0.0.1',resolve));assetOrigin=`http://127.0.0.1:${assets.address().port}`;
  fixture = http.createServer(async (req, res) => {
    if (req.url === '/event' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      Object.assign(state, JSON.parse(text)); res.end('ok'); return;
    }
    if(req.url==='/popup'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><h1>Shared induced popup</h1><button onclick="window.close()">Close popup</button></body></html>');return;}
    if(req.url==='/compat'){
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><title>Compatibility</title><link rel="stylesheet" href="${assetOrigin}/styles.css"><style>body{font:18px sans-serif;margin:20px}#badge::before{content:'★';color:rgb(15,140,80);margin-right:8px}#rich{border:1px solid #888;padding:12px;width:450px}dialog::backdrop{background:rgba(20,40,80,.4)}</style></head><body>
      <div id="badge">Shared font and pseudo</div><img id="remote-image" src="${assetOrigin}/image.svg"><div id="background" style="width:80px;height:40px;background-image:url('${assetOrigin}/image.svg')"></div>
      <div id="shadow-host"></div><div id="rich" contenteditable="true"><strong>alpha</strong><em>bravo</em></div><button id="js-prompt">Prompt</button><button id="open-popup">Popup</button><button id="show-dialog">Modal</button><button id="show-popover">Popover</button>
      <dialog id="native-dialog"><p>Native dialog</p><button id="close-dialog">Close modal</button></dialog><div id="native-popover" popover>Native popover</div>
      <script>const post=data=>fetch('/event',{method:'POST',body:JSON.stringify(data)});const host=document.querySelector('#shadow-host');const closed=host.attachShadow({mode:'closed'});closed.innerHTML='<style>button{color:rgb(10,90,160)}</style><button id="closed-button">Closed shadow button</button><input id="closed-input">';closed.querySelector('button').onclick=()=>post({shadowClicked:true});closed.querySelector('input').oninput=e=>post({shadowText:e.target.value});
      document.querySelector('#rich').addEventListener('input',e=>post({richText:e.target.innerText,trusted:e.isTrusted}));document.querySelector('#open-popup').onclick=()=>window.open('/popup','shared-popup','width=600,height=450');document.querySelector('#js-prompt').onclick=()=>post({promptResult:prompt('Type a shared answer','initial')});document.querySelector('#show-dialog').onclick=()=>document.querySelector('#native-dialog').showModal();document.querySelector('#close-dialog').onclick=()=>document.querySelector('#native-dialog').close();document.querySelector('#show-popover').onclick=()=>document.querySelector('#native-popover').showPopover();</script></body></html>`);return;
    }
    if (req.url === '/fixture'  || req.url === '/next') {
      state.loads++; state.path = req.url; state.cookie = req.headers.cookie || '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Set-Cookie', 'shared-login=present; SameSite=Lax; Path=/');
      res.end(`<!doctype html><html><head><title>Shared test tab</title><style>body{margin:0;height:2500px;background:#eaf1fb;font:20px sans-serif}button{position:absolute;left:40px;top:60px;width:160px;height:40px}input{position:absolute;left:40px;top:130px;width:300px;height:40px}#check{left:390px;width:25px}#choice{position:absolute;left:450px;top:130px}#anim{position:absolute;left:40px;top:280px;animation:pulse 1s linear infinite}#canvas{position:absolute;left:40px;top:360px;display:none}@keyframes pulse{from{opacity:.4}to{opacity:1}}h1{position:absolute;left:40px;top:200px}</style></head><body><button id="click">Increment</button><input id="text"><input id="check" type="checkbox"><select id="choice"><option value="a">A</option><option value="b">B</option></select><div id="anim">Local CSS animation</div><canvas id="canvas" width="200" height="90"></canvas><h1>Shared real tab ${req.url}</h1><script>const post=data=>fetch('/event',{method:'POST',body:JSON.stringify(data)});let clicks=${state.clicks};document.querySelector('#click').onclick=()=>post({clicks:++clicks});document.querySelector('#text').oninput=e=>post({text:e.target.value});document.querySelector('#check').onchange=e=>post({checked:e.target.checked});document.querySelector('#choice').onchange=e=>post({choice:e.target.value,choiceTrusted:e.isTrusted});document.querySelector('#canvas').onclick=()=>post({canvasClicks:1});addEventListener('scroll',()=>post({scroll:scrollY}));</script></body></html>`); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const sourceURL = `http://127.0.0.1:${fixture.address().port}/fixture`;
  startServer(); await until(async () => (await fetch(origin + '/healthz')).ok, 'Go service');
  const token = (await readFile(path.join(temporary, 'data/admin-token'), 'utf8')).trim();
  const profile = path.join(temporary, 'chrome'); await mkdir(profile);
  // Enterprise policy blocks unpacked extensions here. Exercise the actual worker through a
  // Chrome-API test adapter connected to a real, isolated browser; never change that policy.
  source = spawn(browserPath,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--window-size=1280,800','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  source.stderr.on('data',data=>{sourceLog=(sourceLog+data.toString()).slice(-5000);});
  const info=await until(async()=>(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n'),'Chrome debugger');
  cdp=new CDP(`ws://127.0.0.1:${info[0]}${info[1]}`);
  await cdp.call('Target.setDiscoverTargets',{discover:true});
  const listeners=()=>({list:[],addListener(fn){this.list.push(fn);},fire(...args){for(const fn of this.list)fn(...args);}});
  const ids=new Map(),sessions=new Map(),actions=[];let nextId=0;
  const tabEvents={onCreated:listeners(),onRemoved:listeners(),onUpdated:listeners()},debugEvents={onEvent:listeners(),onDetach:listeners()};
  async function getTabs(){const targets=(await cdp.call('Target.getTargets')).targetInfos.filter(t=>t.type==='page');return targets.map(t=>{if(!ids.has(t.targetId))ids.set(t.targetId,++nextId);return{id:ids.get(t.targetId),url:t.url,title:t.title,targetId:t.targetId};});}
  async function getTab(id){const tab=(await getTabs()).find(t=>t.id===id);if(!tab)throw new Error('tab closed');return tab;}
  const messages=listeners(),local={},sessionStorage={},packets=[],receivedInputs=[];
  const chrome={
    tabs:{...tabEvents,query:getTabs,get:getTab,remove:async id=>{const tab=await getTab(id);await cdp.call('Target.closeTarget',{targetId:tab.targetId});},create:async({url,active})=>{const created=await cdp.call('Target.createTarget',{url,background:!active});return until(async()=>(await getTabs()).find(t=>t.targetId===created.targetId),'new tab');},reload:async id=>{await cdp.call('Page.reload',{},sessions.get(id));}},
    debugger:{...debugEvents,attach:async({tabId})=>{const tab=await getTab(tabId);const r=await cdp.call('Target.attachToTarget',{targetId:tab.targetId,flatten:true});sessions.set(tabId,r.sessionId);},detach:async({tabId})=>{const sessionId=sessions.get(tabId);sessions.delete(tabId);if(sessionId)await cdp.call('Target.detachFromTarget',{sessionId});},sendCommand:async({tabId},method,params)=>{if(method==='Runtime.evaluate'&&params.expression.includes('__tabShareDOM.act(')){actions.push(JSON.parse(params.expression.slice(params.expression.indexOf('.act(')+5,-1)).action);}return cdp.call(method,params,sessions.get(tabId));}},
    storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(local[k])])),set:async values=>Object.assign(local,structuredClone(values))},session:{get:async key=>({[key]:sessionStorage[key]}),set:async values=>Object.assign(sessionStorage,values)}},
    runtime:{id:'test-profile',onMessage:messages,onStartup:listeners()},alarms:{create(){},onAlarm:listeners()}
  };
  cdp.listeners.push(m=>{
    if(m.method==='Target.targetCreated'&&m.params.targetInfo.type==='page'&&m.params.targetInfo.openerId){const t=m.params.targetInfo;void getTabs().then(()=>tabEvents.onCreated.fire({id:ids.get(t.targetId),openerTabId:ids.get(t.openerId),url:t.url}));}
    if(m.method==='Target.targetDestroyed'){const id=ids.get(m.params.targetId);if(id){tabEvents.onRemoved.fire(id);debugEvents.onDetach.fire({tabId:id},'target_closed');}}
    const tabId=[...sessions].find(([,session])=>session===m.sessionId)?.[0];
    if(tabId)debugEvents.onEvent.fire({tabId},m.method,m.params);
  });
  class AgentSocket extends WebSocket{constructor(...args){super(...args);this.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.type==='input')receivedInputs.push(m.input);});}send(text){const m=JSON.parse(text);if(m.type==='dom')packets.push({at:Date.now(),document:m.document,bytes:Buffer.byteLength(text)});return super.send(text);}}
  Object.assign(local,{server:origin,pairingToken:token,enabled:true});
  const workerSource=(await readFile(path.join(root,'extension/worker.js'),'utf8')).replace(/^import .*;$/gm,'');

  const resourceReads=[];class TestResources extends ResourceBridge {async read(url){try{const result=await super.read(url);resourceReads.push({kind:url.split('/').pop(),base64:result.base64Encoded,length:(result.content||result.body||'').length});return result;}catch(e){resourceReads.push({kind:url.split('/').pop(),error:e.message});throw e;}}}
  const sandbox={chrome,fetch,WebSocket:AgentSocket,crypto:globalThis.crypto,TextEncoder,TextDecoder,atob,btoa,ResourceBridge:TestResources,serverOrigin,targetURL,resolveTab,cdpInput,installDOM,captureDOM,console,
    setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout,setInterval:(fn,ms)=>{const t=setInterval(fn,ms);timers.add(t);return t;},clearInterval:t=>{clearInterval(t);timers.delete(t);}};
  vm.runInNewContext(workerSource,sandbox,{filename:'extension/worker.js'});
  async function request(message){return new Promise(resolve=>{messages.fire(message,{id:chrome.runtime.id},resolve);});}
  shutdownAgent=async()=>{local.enabled=false;await request({type:'reconnect'});for(const timer of timers)clearInterval(timer);};
  const connection=await request({type:'reconnect'});assert.equal(connection.ok,true,connection.error);
  const sourceTarget = await cdp.call('Target.createTarget', {url: sourceURL, background: true});
  await until(() => state.loads === 1, 'source page loaded');
  const tab=(await getTabs()).find(t=>t.url===sourceURL);
  assert.ok(tab?.id, 'Chrome source tab exists');
  const share=await request({type:'share',kind:'url',url:sourceURL});
  assert.equal(share.ok, true, share.error);
  const tabShare=await request({type:'share',kind:'tab',url:sourceURL,tabId:tab.id,title:'Source tab'});
  assert.equal(tabShare.ok, true, tabShare.error);
  visitors = await chromium.launch({executablePath: browserPath, headless: true, args: ['--no-sandbox']});
  const context = await visitors.newContext({viewport: {width: 1440, height: 1000}});
  const errors = [],viewerInputs=[];
  async function view(url) { const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));page.on('websocket',socket=>socket.on('framesent',({payload})=>{try{const m=JSON.parse(String(payload));if(m.type==='input')viewerInputs.push(m.input);}catch{}})); await page.goto(url); await page.locator('#surface').waitFor({state: 'visible', timeout: 20000}); await page.locator('#dot.live').waitFor(); return page; }
  const one = await view(share.value.shareUrl);
  const two = await view(share.value.shareUrl);
  await until(() => two.locator('#viewers').textContent().then(text => text === '2 人'), 'two simultaneous viewers');
  const remoteOne=one.frameLocator('#mirror'),remoteTwo=two.frameLocator('#mirror');
  const initial=packets.find(p=>p.document.reset);assert.ok(initial,'one initial DOM snapshot');
  await remoteOne.locator('button').click();await until(()=>state.clicks===1,'first viewer real click');
  await remoteTwo.locator('button').click();await until(()=>state.clicks===2,'second viewer real click');
  await remoteOne.locator('#text').click();await one.keyboard.type('hello');await one.keyboard.insertText('你好');
  await until(()=>state.text==='hello你好','real text and Chinese input');
  await remoteOne.locator('#text').evaluate(element=>{const data=new DataTransfer();data.setData('text/plain',' pasted');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true}));});
  await until(()=>state.text==='hello你好 pasted','remote paste').catch(async error=>{console.log('Paste diagnostic:',{text:state.text,inputs:receivedInputs.filter(i=>i.action==='text').slice(-5),local:await remoteOne.locator('#text').evaluate(e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd}))});throw error;});
  await one.keyboard.press('Backspace');await until(()=>state.text==='hello你好 paste','remote special key').catch(async error=>{console.log('Key diagnostic:',{text:state.text,inputs:receivedInputs.filter(i=>i.action==='keyDown').slice(-2),local:await remoteOne.locator('#text').evaluate(e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd}))});throw error;});
  const deltas=packets.filter(p=>!p.document.reset);assert.ok(deltas.length,'mutation deltas emitted');
  assert.ok(deltas.every(p=>p.document.nodes.length===0),'typing uses node/property deltas, never full trees');
  assert.ok(Math.max(...deltas.map(p=>p.bytes))<initial.bytes/2,'edits use less bandwidth than a snapshot');
  await new Promise(resolve=>setTimeout(resolve,500));const idle=packets.length;
  await new Promise(resolve=>setTimeout(resolve,700));assert.equal(packets.length,idle,'idle page sends no DOM data');
  await remoteOne.locator('#check').click();await until(()=>state.checked,'native checkbox');
  await remoteOne.locator('#choice').selectOption('b');await until(()=>state.choice==='b','native select control');assert.equal(state.choiceTrusted,true,'single select commits trusted keyboard input');
  assert.equal(await remoteOne.locator('#anim').evaluate(e=>getComputedStyle(e).animationName),'pulse','CSS animations play locally');
  await cdp.call('Target.activateTarget',{targetId:sourceTarget.targetId});
  const animationStart=packets.length;
  await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:"globalThis.animationTimer=setInterval(()=>{document.querySelector('#anim').style.transform='translateX('+(Date.now()%50)+'px)'},16)"});
  await new Promise(resolve=>setTimeout(resolve,2100));
  await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'clearInterval(globalThis.animationTimer)'});
  const animationPackets=packets.slice(animationStart).filter(p=>!p.document.reset);assert.ok(animationPackets.length<=12,'60 Hz DOM animation coalesced to at most 5 Hz batches');assert.ok(animationPackets.every(p=>p.bytes<2500),'animation sends small property deltas');
  console.log('Animation measurement:',animationPackets.length,'batches in 2.1s,',animationPackets.reduce((n,p)=>n+p.bytes,0),'bytes');
  await until(()=>remoteOne.locator('#text').inputValue().then(v=>v==='hello你好 paste'),'authoritative native input rendering');
  console.log('PASS: native DOM rendering, two viewers, real input/Chinese/paste/keys, sparse deltas, no idle packets');
  await one.locator('#address').fill(sourceURL.replace('/fixture', '/next')); await one.locator('#address').press('Enter');
  await until(() => state.path === '/next', 'shared browser navigation');
  assert.ok(state.cookie.includes('shared-login=present'), 'shared browser preserves login cookies');
  await remoteOne.locator('h1').filter({hasText:'/next'}).waitFor({state:'visible'});
  const box=await one.locator('#mirror').boundingBox();await one.mouse.move(box.x+box.width/2,box.y+box.height/2);await one.mouse.wheel(0,500);
  await new Promise(resolve=>setTimeout(resolve,1200));
  await until(()=>state.scroll>0,'real tab scrolling',6000).catch(async error=>{console.log('Scroll wire:',viewerInputs.filter(i=>i.action==='scroll'),receivedInputs.filter(i=>i.action==='scroll'),actions.slice(-5));console.log('Recent deltas:',packets.slice(-4).map(p=>({reset:p.document.reset,root:p.document.root,nodes:p.document.nodes.map(n=>({id:n.id,tag:n.tag})),updates:p.document.updates,removes:p.document.removes})));console.log('Frame:',await one.locator('#mirror').evaluate(f=>({url:f.contentWindow.location.href,body:!!f.contentDocument.body,html:f.contentDocument.documentElement.outerHTML.slice(0,500)})),errors);throw error;});
  await one.close(); await two.close();
  const reused = await view(share.value.shareUrl);
  const sources = (await cdp.call('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${fixture.address().port}/`));
  assert.equal(sources.length, 1); assert.equal(sources[0].targetId, sourceTarget.targetId, 'URL share reuses original tab after navigation');
  console.log('PASS: two real viewers, mouse, text/Chinese, paste, keys, scroll, navigation, shared cookies, URL reuse');
  await reused.close(); await cdp.call('Target.closeTarget', {targetId: sourceTarget.targetId});
  await mkdir(path.join(root,'test-results'),{recursive:true});
  const reopened = await view(share.value.shareUrl);
  const newSources = (await cdp.call('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.url === sourceURL);
  assert.equal(newSources.length, 1); assert.notEqual(newSources[0].targetId, sourceTarget.targetId, 'closed URL share opens one replacement');
  const closed = await context.newPage(); await closed.goto(tabShare.value.shareUrl);
  await until(() => closed.locator('#status').textContent().then(text => text.includes('已关闭')), 'closed tab share remains closed'); await closed.close();
  await chrome.debugger.sendCommand({tabId:(await getTabs()).find(t=>t.targetId===newSources[0].targetId).id},'Runtime.evaluate',{expression:"document.querySelector('#canvas').style.display='block';document.querySelector('#canvas').getContext('2d').fillRect(0,0,200,90)"});
  const mirroredCanvas=reopened.frameLocator('#mirror').locator('[data-unsupported=canvas]');await mirroredCanvas.locator('img[data-raster]').waitFor();await mirroredCanvas.click();await until(()=>state.canvasClicks===1,'canvas region input controls real tab');
  const newTab=(await getTabs()).find(t=>t.targetId===newSources[0].targetId);
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"const overlay=document.createElement('div');overlay.id='overlay';overlay.style.cssText='position:absolute;left:45px;top:365px;width:150px;height:60px;background:red;z-index:99';document.body.append(overlay)"});
  await reopened.locator('#fallback').waitFor({state:'visible'});
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"document.querySelector('#overlay').remove()"});
  await reopened.locator('#mirror').waitFor({state:'visible'});
  await until(()=>mirroredCanvas.locator('img[data-raster]').evaluate(image=>{if(!image.complete||!image.naturalWidth)return false;const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixel=ctx.getImageData(20,20,1,1).data;return pixel[0]<10&&pixel[1]<10&&pixel[2]<10;}),'fresh region image after overlay removal');
  console.log('PASS: canvas region pixels and real input; overlapping overlay switches to full frame then restores DOM');
  await reopened.screenshot({path:path.join(root,'test-results/shared-dom.png')});
  console.log('PASS: URL share reopens a closed tab; tab-only share never opens replacement');
  await reopened.locator('#address').fill(sourceURL.replace('/fixture','/compat'));await reopened.locator('#address').press('Enter');
  const compatibility=reopened.frameLocator('#mirror');await compatibility.locator('#closed-button').waitFor({state:'visible'});
  assert.equal(await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"document.querySelector('#shadow-host').shadowRoot===null",returnByValue:true}).then(r=>r.result.value),true,'fixture uses a closed shadow root');
  await compatibility.locator('#closed-button').click();await until(()=>state.shadowClicked,'closed shadow control');
  await compatibility.locator('#closed-input').click();await reopened.keyboard.type('shadow');await until(()=>state.shadowText==='shadow','closed shadow text input');
  await until(()=>compatibility.locator('#remote-image').evaluate(e=>e.complete&&e.naturalWidth===80),'cross-origin authenticated image via relay',20000);
  assert.ok(assetHits.find(hit=>hit.url==='/image.svg').cookie.includes('shared-login=present'),'source image used source cookie');
  assert.equal(await compatibility.locator('#remote-image').getAttribute('src').then(s=>s.startsWith('blob:')),true,'visitor uses relay blob, never original URL');
  assert.equal(await compatibility.locator('#badge').evaluate(e=>getComputedStyle(e,'::before').content),'"★"','pseudo element content');
  await until(()=>compatibility.locator('#badge').evaluate(e=>[...e.ownerDocument.fonts].some(f=>f.family==='SharedFont'&&f.status==='loaded')),'cross-origin font face loaded',20000).catch(async error=>{console.log('Resource reads:',resourceReads);console.log('Font styles:',await compatibility.locator('#badge').evaluate(e=>({fonts:[...e.ownerDocument.fonts].map(f=>({family:f.family,status:f.status})),styles:[...e.ownerDocument.styleSheets].flatMap(s=>[...s.cssRules].map(r=>r.cssText)).filter(r=>r.includes('font-face'))})));throw error;});
  assert.ok(await compatibility.locator('#background').evaluate(e=>getComputedStyle(e).backgroundImage.startsWith('url("blob:')),'CSS image forwarded');
  // The rich editor has no source scripts in the mirror. Range replacement runs trusted input on the source.
  await compatibility.locator('#rich').evaluate(e=>{e.focus();const s=e.ownerDocument.getSelection();s.setBaseAndExtent(e.querySelector('strong').firstChild,2,e.querySelector('em').firstChild,3);});
  await reopened.keyboard.insertText('你好');await until(()=>state.richText==='al你好vo','rich text range spans nested elements');assert.equal(state.trusted,true,'rich text uses trusted CDP editing');
  await compatibility.locator('#js-prompt').click();await reopened.locator('#site-dialog').waitFor({state:'visible'});await reopened.locator('#dialog-value').fill('shared answer');await reopened.locator('#dialog-answer button[type=submit]').click();await until(()=>state.promptResult==='shared answer','shared JavaScript prompt');
  await compatibility.locator('#show-dialog').click();await until(()=>compatibility.locator('#native-dialog').evaluate(e=>e.matches(':modal')),'native modal top layer');await compatibility.locator('#close-dialog').click();await until(()=>compatibility.locator('#native-dialog').evaluate(e=>!e.open),'native modal close');
  await compatibility.locator('#show-popover').click();await until(()=>compatibility.locator('#native-popover').evaluate(e=>e.matches(':popover-open')),'native popover top layer');
  // The fixed control exists on the source, is isolated from site CSS, and is excluded from the DOM mirror.
  assert.equal(await compatibility.locator('[data-tabshare-owner-ui]').count(),0,'owner controls excluded from mirror');
  const ownerRoot=(await chrome.debugger.sendCommand({tabId:newTab.id},'DOM.getDocument',{depth:-1,pierce:true})).root;
  const findOwner=n=>n.attributes?.includes('data-tabshare-owner-ui')?n:(n.children||[]).map(findOwner).find(Boolean);const owner=findOwner(ownerRoot);assert.ok(owner,'source fixed sharing button exists');
  const object=(await chrome.debugger.sendCommand({tabId:newTab.id},'DOM.resolveNode',{backendNodeId:owner.shadowRoots[0].backendNodeId})).object;
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:"function(){this.querySelector('button').click();this.querySelector('input[value=raster]').click()}"});
  await reopened.locator('#fallback').waitFor({state:'visible'});await until(()=>local.sessionModes?.[share.value.session.id]==='raster','owner choice persisted');
  await reopened.locator('#share-settings-toggle').click();await reopened.locator('[name=share-mode][value=dom]').check();await reopened.locator('#mirror').waitFor({state:'visible'});await compatibility.locator('#closed-button').waitFor();
  assert.equal((await getTabs()).find(t=>t.id===newTab.id).targetId,newSources[0].targetId,'mode switch keeps original source tab');
  await reopened.locator('#share-settings-toggle').click();
  await compatibility.locator('#open-popup').click();await compatibility.locator('h1').filter({hasText:'Shared induced popup'}).waitFor({state:'visible',timeout:20000});await compatibility.locator('button').click();await compatibility.locator('#closed-button').waitFor({state:'visible',timeout:20000});assert.equal((await getTabs()).find(t=>t.id===newTab.id).targetId,newSources[0].targetId,'popup closes back to original source');
  console.log('PASS: cookie-bound cross-origin image/CSS/font relay, closed Shadow DOM, pseudo content, trusted rich text selection, JS prompt, native modal/popover, owner and visitor mode controls, induced popup and return');
  await reopened.locator('#address').fill(sourceURL);await reopened.locator('#address').press('Enter');await reopened.frameLocator('#mirror').locator('#click').waitFor();
  await stop(server); startServer();
  await until(async () => (await fetch(origin + '/healthz')).ok, 'server restart');
  await until(() => reopened.locator('#dot').getAttribute('class').then(c => c === 'live'), 'agent and viewer reconnect after restart', 25000);
  const afterRestart = (await cdp.call('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.url === sourceURL);
  assert.equal(afterRestart[0].targetId, newSources[0].targetId, 'restart preserved original tab mapping');
  const revoke=await request({type:'revoke',id:share.value.session.id});
  assert.equal(revoke.ok, true, revoke.error);
  const revoked = await context.newPage(); await revoked.goto(share.value.shareUrl);
  await until(() => revoked.locator('#status').textContent().then(text => text.includes('撤销')), 'revoked share cannot join');
  assert.deepEqual(errors, [], 'viewer has no uncaught JS errors');
  await mkdir(path.join(root, 'test-results'), {recursive: true});
  for(const timer of timers)clearInterval(timer);
  await revoked.screenshot({path: path.join(root, 'test-results/revoked.png')});
  console.log('PASS: persistent links, unattended restart/reconnect, capability revocation, no browser JS errors');
} catch (error) {
  console.error(error.message);
  // Logs do not include pairing credentials or share capability URLs.
  console.error('Go service:', serverLog);
  console.error('Source browser:', sourceLog);
  process.exitCode = 1;
} finally {
  await shutdownAgent?.().catch(()=>{});for(const timer of timers)clearInterval(timer);
  cdp?.close(); await visitors?.close(); await stop(source).catch(() => {}); await stop(server).catch(() => {});
  await new Promise(resolve => fixture ? fixture.close(resolve) : resolve());
  await new Promise(resolve=>assets?assets.close(resolve):resolve());
  await rm(temporary, {recursive: true, force: true});
}
