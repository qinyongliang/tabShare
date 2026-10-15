import {InputQueue} from '../extension/input-queue.js';
import {DocumentState} from '../extension/document-state.js';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import {serverOrigin,targetURL,resolveTab,cdpInput,rasterFrame,validPeerInput} from '../extension/controller.js';
import {installDOM,captureDOM} from '../extension/dom-capture.js';
import {ResourceBridge} from '../extension/resources.js';
import {chromium} from 'playwright-core';

const rtcEnabled=process.env.TEST_RTC!=='0';
const realSites=process.argv.includes('--real-sites');
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'tabshare-e2e-'));
const browserPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
let source, server, visitors, cdp, fixture, assets, shutdownAgent,videoAnimation;
let turnPort;const useTURN=rtcEnabled&&(process.env.TEST_TURN==='1'||realSites);
let assetOrigin;const assetHits=[];
const timers=new Set();
let serverLog = '', sourceLog = '';
let resourceUploads=0,clipboardUploads=0,relayDocuments=0,relayInputs=0;
const originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{if(String(url).includes('/api/resources/')&&options?.method==='POST')resourceUploads++;return originalFetch(url,options);};
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
    this.ws.onmessage = event => { const m = JSON.parse(event.data); if (!m.id) {for(const listener of this.listeners)listener(m);return;} const call = this.pending.get(m.id); if (!call) return; this.pending.delete(m.id); clearTimeout(call.timer); if (m.error) call.reject(new Error(call.method+': '+m.error.message+(m.error.data?' ('+m.error.data+')':''))); else call.resolve(m.result); };
  }
  async call(method, params = {}, sessionId) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      this.pending.set(id, {resolve, reject, timer,method}); this.ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
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
  server = spawn(path.join(root, 'bin/tabshare'), ['-listen', `127.0.0.1:${listen}`, '-data', path.join(temporary, 'data'), '-public-url', origin,'-stun','',...(useTURN?['-turn-listen','127.0.0.1:'+turnPort,'-turn-allow-private-peers']:[])], {cwd: root,env:{...process.env,TABSHARE_TURN_URLS:'',TABSHARE_TURN_SECRET:'',TABSHARE_TURN_LISTEN:'',TABSHARE_TURN_PUBLIC_IP:''}, stdio: ['ignore', 'ignore', 'pipe']});
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
    if(req.url.startsWith('/extension/')){const name=req.url.split('/').pop();if(!['offscreen.html','offscreen.js','peer.js','video-layout.js','video-capture.js'].includes(name)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(path.join(root,'extension',name)));return;}
    if (req.url === '/event' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      Object.assign(state, JSON.parse(text)); res.end('ok'); return;
    }
    if(req.url==='/download'){let body='';for await(const chunk of req)body+=chunk;state.downloadRequests=(state.downloadRequests||0)+1;state.downloadMethod=req.method;state.downloadBody=body;res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''%E5%85%B1%E4%BA%AB%E6%8A%A5%E5%91%8A.bin");res.end(Buffer.from(Array.from({length:300001},(_,i)=>i%251)));return;}
    if(req.url==='/pixel-editor'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><body style="margin:0"><iframe id="remote-editor" src="/editor" style="position:absolute;left:40px;top:50px;width:600px;height:260px"></iframe></body>');return;}
    if(req.url==='/editor'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><body style="margin:0;font:20px monospace"><input id="remote-text" value="abcdef" style="position:absolute;left:20px;top:30px;width:300px;height:36px;padding:4px;font:20px monospace"><p style="position:absolute;left:20px;top:100px">Select this remote text</p></body>');return;}
    if(req.url==='/popup'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><h1>Shared induced popup</h1><input id="popup-text"><a id="popup-download" href="/download">Download in popup</a><button onclick="window.close()">Close popup</button></body></html>');return;}
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
      res.end(`<!doctype html><html><head><title>Shared test tab</title><style>body{margin:0;height:2500px;background:#eaf1fb;font:20px sans-serif}button{position:absolute;left:40px;top:60px;width:160px;height:40px}input{position:absolute;left:40px;top:130px;width:300px;height:40px}#check{left:390px;width:25px}#choice{position:absolute;left:450px;top:130px}#anim{position:absolute;left:40px;top:280px;animation:pulse 1s linear infinite}#canvas{position:absolute;left:40px;top:360px;display:none}@keyframes pulse{from{opacity:.4}to{opacity:1}}#responsive{position:absolute;left:20px;top:500px;width:400px;background:rgb(240,240,240)}@media(max-width:600px){#click{left:20px;width:130px}#responsive{width:calc(100% - 40px);background:rgb(210,240,220)}}h1{position:absolute;left:40px;top:200px}</style></head><body><button id="click">Increment</button><input id="text"><input id="check" type="checkbox"><select id="choice"><option value="a">A</option><option value="b">B</option></select><div id="anim">Local CSS animation</div><canvas id="canvas" width="200" height="90"></canvas><div id="responsive">Responsive layout</div><div id="image-paste" contenteditable style="position:absolute;left:40px;top:650px;width:400px;min-height:30px;border:1px solid">Paste image here</div><a id="download-get" href="/download" style="position:absolute;left:650px;top:200px">Download GET</a><form method="POST" action="/download" style="position:absolute;left:650px;top:250px"><input type="hidden" name="ticket" value="one-use-fixture"><button id="download-post" style="position:static">Download POST</button></form><button id="download-blob" style="left:650px;top:300px" onclick="globalThis.generatedClick=true;const u=window.URL.createObjectURL(new Blob(['generated file 中文'],{type:'text/plain'})),a=document.createElement('a');a.href=u;a.download='generated.txt';a.click();window.URL.revokeObjectURL(u)">Generate file</button><div id="context-zone" style="position:absolute;left:600px;top:60px;width:200px;height:40px">Custom context menu</div><h1>Shared real tab ${req.url}</h1><script>const post=data=>fetch('/event',{method:'POST',body:JSON.stringify(data)});let imagePastes=0;document.querySelector('#image-paste').onpaste=e=>{const file=e.clipboardData.files[0];if(file){e.preventDefault();post({imageMime:file.type,imageBytes:file.size,imageTrusted:e.isTrusted,imagePastes:++imagePastes});}};document.querySelector('#context-zone').oncontextmenu=e=>{e.preventDefault();const menu=document.createElement('button');menu.id='context-action';menu.textContent='Context action';menu.style.cssText='position:absolute;left:'+e.pageX+'px;top:'+e.pageY+'px;z-index:500';menu.onclick=()=>{post({contextClicked:true});menu.remove();};document.body.append(menu);};let clicks=${state.clicks};document.querySelector('#click').onclick=()=>post({clicks:++clicks});document.querySelector('#text').oninput=e=>post({text:e.target.value});document.querySelector('#check').onchange=e=>post({checked:e.target.checked});document.querySelector('#choice').onchange=e=>post({choice:e.target.value,choiceTrusted:e.isTrusted});document.querySelector('#canvas').onclick=()=>post({canvasClicks:1});addEventListener('scroll',()=>post({scroll:scrollY}));</script></body></html>`); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const sourceURL = `http://127.0.0.1:${fixture.address().port}/fixture`;
  if(useTURN)turnPort=await freePort();
  startServer(); await until(async () => (await fetch(origin + '/healthz')).ok, 'Go service');
  const token = (await readFile(path.join(temporary, 'data/admin-token'), 'utf8')).trim();
  const profile = path.join(temporary, 'chrome'); await mkdir(profile);
  // Enterprise policy blocks unpacked extensions here. Exercise the actual worker through a
  // Chrome-API test adapter connected to a real, isolated browser; never change that policy.
  const proxyArgs=realSites&&process.env.HTTPS_PROXY?['--proxy-server='+process.env.HTTPS_PROXY,'--proxy-bypass-list=localhost;127.0.0.1']:[];
  source = spawn(browserPath,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--window-size=1280,800','--remote-debugging-port=0',`--user-data-dir=${profile}`,...proxyArgs,'about:blank'],{stdio:['ignore','ignore','pipe']});
  source.stderr.on('data',data=>{sourceLog=(sourceLog+data.toString()).slice(-5000);});
  const info=await until(async()=>(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n'),'Chrome debugger');
  cdp=new CDP(`ws://127.0.0.1:${info[0]}${info[1]}`);
  await cdp.call('Target.setDiscoverTargets',{discover:true});
  const listeners=()=>({list:[],addListener(fn){this.list.push(fn);},fire(...args){for(const fn of this.list)fn(...args);}});
  const ids=new Map(),sessions=new Map(),actions=[],videoCommands=[],videoGeometries=[];let sourceFrames=0,offscreenFrames=0;let nextId=0,offscreenSession,offscreenTarget;
  const tabEvents={onCreated:listeners(),onRemoved:listeners(),onUpdated:listeners()},debugEvents={onEvent:listeners(),onDetach:listeners()};
  async function getTabs(){const targets=(await cdp.call('Target.getTargets')).targetInfos.filter(t=>t.type==='page'&&t.targetId!==offscreenTarget);return targets.map(t=>{if(!ids.has(t.targetId))ids.set(t.targetId,++nextId);return{id:ids.get(t.targetId),url:t.url,title:t.title,targetId:t.targetId};});}
  async function getTab(id){const tab=(await getTabs()).find(t=>t.id===id);if(!tab)throw new Error('tab closed');return tab;}
  const messages=listeners(),local={},sessionStorage={},packets=[],receivedInputs=[],commandFailures=[];
  const chrome={
    tabs:{...tabEvents,query:getTabs,get:getTab,remove:async id=>{const tab=await getTab(id);await cdp.call('Target.closeTarget',{targetId:tab.targetId});},create:async({url,active})=>{const created=await cdp.call('Target.createTarget',{url,background:!active});return until(async()=>(await getTabs()).find(t=>t.targetId===created.targetId),'new tab');},reload:async id=>{await cdp.call('Page.reload',{},sessions.get(id));}},
    debugger:{...debugEvents,attach:async({tabId})=>{const tab=await getTab(tabId);const r=await cdp.call('Target.attachToTarget',{targetId:tab.targetId,flatten:true});sessions.set(tabId,r.sessionId);},detach:async({tabId})=>{const sessionId=sessions.get(tabId);sessions.delete(tabId);if(sessionId)await cdp.call('Target.detachFromTarget',{sessionId});},sendCommand:async({tabId},method,params)=>{if(method.includes('Screencast'))videoCommands.push(method);if(method==='Runtime.evaluate'&&params.expression.includes('__tabShareDOM.act(')){actions.push(JSON.parse(params.expression.slice(params.expression.indexOf('.act(')+5,-1)).action);}try{const r=await cdp.call(method,params,sessions.get(tabId));if(realSites&&r.exceptionDetails&&commandFailures.length<100)commandFailures.push({tabId,method,error:String(r.result?.description||r.exceptionDetails.text).slice(0,500)});return r;}catch(error){if(realSites&&commandFailures.length<100)commandFailures.push({tabId,method,error:error.message.slice(0,500)});throw error;}}},
    storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(local[k])])),set:async values=>Object.assign(local,structuredClone(values))},session:{get:async key=>({[key]:sessionStorage[key]}),set:async values=>Object.assign(sessionStorage,values)}},
    runtime:{id:'test-profile',onMessage:messages,onStartup:listeners()},alarms:{create(){},onAlarm:listeners()}
  };
  cdp.listeners.push(m=>{
    if(m.method==='Target.targetCreated'&&m.params.targetInfo.type==='page'&&m.params.targetInfo.openerId){const t=m.params.targetInfo;void getTabs().then(()=>tabEvents.onCreated.fire({id:ids.get(t.targetId),openerTabId:ids.get(t.openerId),url:t.url}));}
    if(m.method==='Target.targetDestroyed'){const id=ids.get(m.params.targetId);if(id){tabEvents.onRemoved.fire(id);debugEvents.onDetach.fire({tabId:id},'target_closed');}}
    const tabId=[...sessions].find(([,session])=>session===m.sessionId)?.[0];
    if(m.method==='Page.screencastFrame')sourceFrames++;if(tabId)debugEvents.onEvent.fire({tabId},m.method,m.params);
  });
  class AgentSocket extends WebSocket{constructor(...args){super(...args);this.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.type==='input'){relayInputs++;receivedInputs.push(m.input);}});}send(text){const m=JSON.parse(text);if(m.type==='dom'){relayDocuments++;packets.push({at:Date.now(),document:m.document,bytes:Buffer.byteLength(text)});}return super.send(text);}}
  Object.assign(local,{server:origin,pairingToken:token,enabled:true});
  const workerSource=(await readFile(path.join(root,'extension/worker.js'),'utf8')).replace(/^import .*;$/gm,'');

  const resourceReads=[];class TestResources extends ResourceBridge {async read(url){try{const result=await super.read(url);resourceReads.push({kind:url.split('/').pop(),base64:result.base64Encoded,length:(result.content||result.body||'').length});return result;}catch(e){resourceReads.push({kind:url.split('/').pop(),error:e.message});throw e;}}}
  const sandbox={chrome,fetch,WebSocket:AgentSocket,crypto:globalThis.crypto,TextEncoder,TextDecoder,atob,btoa,ResourceBridge:TestResources,DocumentState,InputQueue,serverOrigin,targetURL,resolveTab,cdpInput,rasterFrame,validPeerInput,installDOM,captureDOM,console,
    setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout,setInterval:(fn,ms)=>{const t=setInterval(fn,ms);timers.add(t);return t;},clearInterval:t=>{clearInterval(t);timers.delete(t);}};

  if(rtcEnabled){
    chrome.runtime.getContexts=async()=>offscreenSession?[{contextType:'OFFSCREEN_DOCUMENT'}]:[];
    chrome.offscreen={createDocument:async()=>{
      const t=await cdp.call('Target.createTarget',{url:'about:blank',background:true});offscreenTarget=t.targetId;
      offscreenSession=(await cdp.call('Target.attachToTarget',{targetId:t.targetId,flatten:true})).sessionId;
      await cdp.call('Runtime.enable',{},offscreenSession);
      await cdp.call('Runtime.addBinding',{name:'tabshareRuntime'},offscreenSession);
      await cdp.call('Page.enable',{},offscreenSession);
      await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`
        globalThis.__rtc=[];const RealRTC=RTCPeerConnection;globalThis.RTCPeerConnection=class extends RealRTC{constructor(c){super(${useTURN}?{...c,iceTransportPolicy:'relay'}:c);__rtc.push(this);}};
        const receivers=[],pending=new Map();let serial=0;
        globalThis.chrome={runtime:{id:'test-profile',onMessage:{addListener:fn=>receivers.push(fn)},sendMessage:m=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);tabshareRuntime(JSON.stringify({id,message:m}));})}};
        globalThis.__resolve=(id,value)=>{pending.get(id)?.(value);pending.delete(id);};
        globalThis.__request=m=>new Promise(resolve=>{for(const fn of receivers)fn(m,{id:chrome.runtime.id},resolve);});
        globalThis.__ready=()=>receivers.length>0;
      `},offscreenSession);
      await cdp.call('Page.navigate',{url:new URL('/extension/offscreen.html',sourceURL).href},offscreenSession);
      await until(()=>cdp.evaluate(offscreenSession,'globalThis.__ready?.()'),'real WebRTC offscreen module loads');
    }};
    cdp.listeners.push(event=>{
      if(event.sessionId===offscreenSession&&event.method==='Runtime.consoleAPICalled')console.log('Offscreen console:',event.params.args.map(a=>a.value).join(' '));
      if(event.sessionId===offscreenSession&&event.method==='Runtime.bindingCalled'){
        const {id,message}=JSON.parse(event.params.payload);if(message.type==='peer-input'&&message.message?.type==='input')receivedInputs.push(message.message.input);
        messages.fire(message,{id:chrome.runtime.id},value=>void cdp.evaluate(offscreenSession,'globalThis.__resolve('+id+','+JSON.stringify(value??null)+')').catch(()=>{}));
      }
    });
    chrome.runtime.sendMessage=async m=>{
      if(m.target==='offscreen'){
        if(m.type==='frame')offscreenFrames++;if(m.type==='send'&&m.message.type==='video')videoGeometries.push(m.message.info);
        if(m.type==='send'&&m.message.type==='dom'&&!m.viewerId)packets.push({at:Date.now(),document:m.message.document,bytes:Buffer.byteLength(JSON.stringify(m.message))});
        return cdp.evaluate(offscreenSession,'globalThis.__request('+JSON.stringify(m)+')').catch(error=>{if(m.type==='frame')console.log('Frame bridge failure:',error.message);throw error;});
      }
      return new Promise(resolve=>messages.fire(m,{id:chrome.runtime.id},resolve));
    };
  }
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
  async function view(url,viewerContext=context) { const page = await viewerContext.newPage();if(rtcEnabled)await page.addInitScript(forceRelay=>{const RealRTC=RTCPeerConnection;globalThis.__rtc=[];globalThis.RTCPeerConnection=class extends RealRTC{constructor(c){super(forceRelay?{...c,iceTransportPolicy:'relay'}:c);__rtc.push(this);}};},useTURN); page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/clipboard/'))clipboardUploads++;});page.on('pageerror',e=>errors.push(e.message));if(rtcEnabled)page.on('console',m=>{if(m.text().includes('TabShare RTC'))console.log(m.text());});page.on('websocket',socket=>{socket.on('framesent',({payload})=>{try{const m=JSON.parse(String(payload));if(m.type==='input')viewerInputs.push(m.input);}catch{}});}); await page.goto(url); await page.locator('#surface').waitFor({state:'visible',timeout:20000}).catch(async error=>{console.log('Initial connection diagnostics:',{status:await page.locator('#status').textContent(),errors,failures:commandFailures.slice(-4),packets:packets.slice(-4).map(p=>({nodes:p.document.nodes.length,meta:p.document.meta})),targets:vm.runInContext('[...targets].map(([id,t])=>({id,context:t.contextId,history:t.navigation}))',sandbox)});throw error;}); await page.locator('#dot.live').waitFor({state:'attached'}); return page; }
  if(realSites){
    const {runRealSites}=await import('./real-sites.mjs');
    await runRealSites({root,request,view,cdp,chrome,getTabs,sessions,packets,videoGeometries,errors,commandFailures,resourceReads});
  }else{
  async function navigate(page,url){if(!await page.locator('#share-settings').isVisible())await page.locator('#share-settings-toggle').click();await page.locator('#address').fill(url);await page.locator('#address').press('Enter');await page.locator('#share-settings-toggle').click();}
  const one = await view(share.value.shareUrl);
  const two = await view(share.value.shareUrl);
  await until(()=>one.locator('#follow-viewport').isChecked(),'first viewer automatically drives full-window layout');
  const sourceViewport=()=>chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight})',returnByValue:true}).then(r=>r.result.value);
  async function noOuterScrollbars(page){return page.evaluate(()=>{const s=document.querySelector('#stage'),f=document.querySelector('#mirror'),root=f.contentDocument.scrollingElement;return getComputedStyle(s).overflow==='hidden'&&s.scrollHeight===s.clientHeight&&s.scrollWidth===s.clientWidth&&document.documentElement.scrollHeight===innerHeight&&root.scrollHeight>root.clientHeight;});}
  for(const size of [{width:800,height:700},{width:1440,height:1000}]){await one.setViewportSize(size);await until(async()=>{const m=await sourceViewport();return m.width===size.width&&m.height===size.height;},'source automatically follows current window resolution').catch(async e=>{console.log('Viewport mismatch:',{requested:size,actual:await sourceViewport(),inputs:receivedInputs.filter(i=>i.action==='viewport'),viewers:await Promise.all([one,two].map(p=>p.evaluate(()=>({checked:document.querySelector('#follow-viewport').checked,note:document.querySelector('#viewport-note').textContent,status:document.querySelector('#status').textContent,size:[innerWidth,innerHeight],visual:[visualViewport.width,visualViewport.height],stage:document.querySelector('#stage').getBoundingClientRect().toJSON()})))),failures:commandFailures});throw e;});await until(()=>noOuterScrollbars(one),'only shared document scrolls');await until(()=>noOuterScrollbars(two),'other viewer fits the same source without outer scrollbars');}
  await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:"(()=>{const style=document.createElement('style');style.textContent='#click:hover{outline:3px solid rgb(10,90,160)}#click:hover ~ #responsive{color:rgb(10,90,160)}';document.head.append(style);document.addEventListener('mousemove',e=>{globalThis.__mouseProbe={x:e.clientX,y:e.clientY,trusted:e.isTrusted};});})()"});
  await one.bringToFront();await one.frameLocator('#mirror').locator('#click').hover();
  await until(()=>one.frameLocator('#mirror').locator('#responsive').evaluate(n=>getComputedStyle(n).color==='rgb(10, 90, 160)'),'source hover styles reach a sibling in DOM mirror');
  const settingsBox=await one.locator('#share-settings-toggle').boundingBox();await one.mouse.move(settingsBox.x+10,settingsBox.y+10);
  await until(()=>one.frameLocator('#mirror').locator('#click').evaluate(n=>getComputedStyle(n).outlineStyle==='none'),'leaving mirror clears hover');
  assert.ok(receivedInputs.some(i=>i.action==='mouseLeave'),'source receives explicit mouse leave over both transports');
  console.log('PASS: automatic window reflow, one document scrollbar, trusted hover and mouse leave including sibling CSS');
  await one.locator('#surface').evaluate(e=>{const stage=document.querySelector('#stage').getBoundingClientRect();if(stage.x!==0||stage.y!==0||stage.width!==innerWidth||stage.height!==innerHeight)throw Error('outer chrome consumes shared viewport');});
  const handle=one.locator('#share-settings-toggle');assert.equal(await handle.textContent(),'共享设置');const beforeDrag=await handle.boundingBox();
  await one.mouse.move(beforeDrag.x+20,beforeDrag.y+20);await one.mouse.down();await one.mouse.move(beforeDrag.x-130,beforeDrag.y-130,{steps:8});await one.mouse.up();
  assert.equal(await one.locator('#share-settings').isVisible(),false,'dragging must not open settings');
  const afterDrag=await handle.boundingBox();assert.ok(afterDrag.x<beforeDrag.x-100&&afterDrag.y<beforeDrag.y-100);
  await handle.click();assert.equal(await one.locator('#share-settings').isVisible(),true);await handle.click();
  await until(() => two.locator('#viewers').textContent().then(text => text === '2 人'), 'two simultaneous viewers');
  const remoteOne=one.frameLocator('#mirror'),remoteTwo=two.frameLocator('#mirror');
  const rtcInspect=()=>chrome.runtime.sendMessage({target:'offscreen',type:'inspect'});
  if(rtcEnabled){await until(()=>one.locator('#status').textContent().then(t=>t.includes(useTURN?'TURN 中继':'P2P 直连')),'first viewer real P2P').catch(async error=>{console.log('RTC viewer status:',await one.locator('#status').textContent(),'page errors',errors,'rtc',await one.evaluate(()=>globalThis.__rtc?.map(p=>({state:p.connectionState,signal:p.signalingState,ice:p.iceGatheringState,local:p.localDescription?.type,remote:p.remoteDescription?.type}))));console.log('Offscreen:',offscreenSession?await cdp.evaluate(offscreenSession,'({ready:globalThis.__ready?.(),rtc:typeof RTCPeerConnection,connections:globalThis.__rtc?.map(p=>({state:p.connectionState,signal:p.signalingState,ice:p.iceGatheringState,local:p.localDescription?.type,remote:p.remoteDescription?.type}))})'):'not created');throw error;});await until(()=>two.locator('#status').textContent().then(t=>t.includes(useTURN?'TURN 中继':'P2P 直连')),'second viewer real P2P');console.log('PASS: two authenticated real WebRTC connections via',useTURN?'built-in Go TURN':'P2P',', DOM and input DataChannels');}
  if(rtcEnabled){
    await cdp.evaluate(offscreenSession,'__rtc[0].close()');
    await until(()=>one.locator('#status').textContent().then(t=>t.includes('WebSocket 兜底')),'RTC failure switches to WebSocket',12000);
    const before=state.clicks;await remoteOne.locator('#click').click();await until(()=>state.clicks===before+1,'fallback still controls same source tab');
    await until(()=>one.locator('#status').textContent().then(t=>t.includes(useTURN?'TURN 中继':'P2P 直连')),'RTC automatically recovers',18000);
    state.clicks=0;await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'clicks=0'});
    await until(async()=>(await rtcInspect()).peers.some(p=>p.stats.compressed>0&&p.stats.saved>1000),'real compressed DOM state');
    console.log('PASS: RTC failure, fresh fallback DOM, control continues, automatic WebRTC recovery');
  }
  await until(()=>one.locator('#surface').getAttribute('data-syncing').then(v=>v==='false'),'initial progressive DOM complete');
  const editStart=packets.length;const beforeDirectDOM=relayDocuments,beforeDirectInputs=relayInputs;
  const initial=packets.find(p=>p.document.reset);assert.ok(initial,'one initial DOM snapshot');
  await remoteOne.locator('#click').click();await until(()=>state.clicks===1,'first viewer real click');
  await remoteTwo.locator('#click').click();await until(()=>state.clicks===2,'second viewer real click');
  await remoteOne.locator('#text').click();await one.keyboard.type('hello');await one.keyboard.insertText('你好');
  await until(()=>state.text==='hello你好','real text and Chinese input');
  await remoteOne.locator('#text').evaluate(element=>{const data=new DataTransfer();data.setData('text/plain',' pasted');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true}));});
  await until(()=>state.text==='hello你好 pasted','remote paste').catch(async error=>{console.log('Paste diagnostic:',{text:state.text,inputs:receivedInputs.filter(i=>i.action==='text').slice(-5),local:await remoteOne.locator('#text').evaluate(e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd}))});throw error;});
  await one.keyboard.press('Backspace');await until(()=>state.text==='hello你好 paste','remote special key').catch(async error=>{console.log('Key diagnostic:',{text:state.text,inputs:receivedInputs.filter(i=>i.action==='keyDown').slice(-2),local:await remoteOne.locator('#text').evaluate(e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd}))});throw error;});
  await until(()=>packets.some(p=>!p.document.reset),'batched mutation delta arrives');
  const deltas=packets.slice(editStart).filter(p=>!p.document.reset);assert.ok(deltas.length,'mutation deltas emitted');
  assert.ok(deltas.every(p=>p.document.nodes.length===0),'typing uses node/property deltas, never full trees');
  assert.ok(Math.max(...deltas.map(p=>p.bytes))<initial.bytes/2,'edits use less bandwidth than a snapshot');
  await new Promise(resolve=>setTimeout(resolve,500));const idle=packets.length;
  await new Promise(resolve=>setTimeout(resolve,700));assert.equal(packets.length,idle,'idle page sends no DOM data');
  await remoteOne.locator('#check').click();await until(()=>state.checked,'native checkbox');
  await remoteOne.locator('#choice').selectOption('b');await until(()=>state.choice==='b','native select control').catch(async error=>{console.log('Select diagnostic:',{choice:state.choice,inputs:receivedInputs.filter(i=>i.action==='select').slice(-3),source:await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'({value:document.querySelector("#choice").value,active:document.activeElement?.id})',returnByValue:true}).then(r=>r.result.value),local:await remoteOne.locator('#choice').inputValue()});throw error;});assert.equal(state.choiceTrusted,true,'single select commits trusted keyboard input');
  assert.equal(await remoteOne.locator('#anim').evaluate(e=>getComputedStyle(e).animationName),'pulse','CSS animations play locally');
  await cdp.call('Target.activateTarget',{targetId:sourceTarget.targetId});
  const animationStart=packets.length;
  await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:"globalThis.animationTimer=setInterval(()=>{document.querySelector('#anim').style.transform='translateX('+(Date.now()%50)+'px)'},16)"});
  await new Promise(resolve=>setTimeout(resolve,2100));
  await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'clearInterval(globalThis.animationTimer)'});
  const animationPackets=packets.slice(animationStart).filter(p=>!p.document.reset);assert.ok(animationPackets.length<=12,'60 Hz DOM animation coalesced to at most 5 Hz batches');assert.ok(animationPackets.every(p=>p.bytes<2500),'animation sends small property deltas');
  console.log('Animation measurement:',animationPackets.length,'batches in 2.1s,',animationPackets.reduce((n,p)=>n+p.bytes,0),'bytes');
  await until(()=>remoteOne.locator('#text').inputValue().then(v=>v==='hello你好 paste'),'authoritative native input rendering');
  if(rtcEnabled){assert.equal(relayDocuments,beforeDirectDOM,'DOM edits bypass Go relay');assert.equal(relayInputs,beforeDirectInputs,'input bypasses Go relay');}
  console.log('PASS: native DOM rendering, two viewers, real input/Chinese/paste/keys, sparse deltas, no idle packets');
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});await one.bringToFront();
  await remoteOne.locator('#image-paste').click();
  await one.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);});
  await one.keyboard.press('Control+V');await until(()=>state.imageMime==='image/png'&&state.imageBytes>0,'real clipboard image reaches original page');
  await new Promise(r=>setTimeout(r,250));assert.equal(state.imagePastes,1,'one gesture must paste one image');
  if(rtcEnabled)assert.equal(clipboardUploads,0,'clipboard image bypasses HTTP when peer is ready');
  await remoteOne.locator('#context-zone').click({button:'right'});await remoteOne.locator('#context-action').waitFor();await until(()=>one.locator('#page-context-menu').isHidden(),'custom webpage context menu replaces viewer fallback menu');await remoteOne.locator('#context-action').click();await until(()=>state.contextClicked,'original webpage context action');
  console.log('Image paste event trusted:',state.imageTrusted);console.log('PASS: real Ctrl+V image paste through '+(rtcEnabled?'peer asset channel':'authenticated HTTP')+', webpage context menu and native input context handling');
  for(const [selector,method] of [['#download-get','GET'],['#download-post','POST']]){
    const before=state.downloadRequests||0,downloadPromise=one.waitForEvent('download');await remoteOne.locator(selector).click();const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),'共享报告.bin');assert.deepEqual(await readFile(await download.path()),Buffer.from(Array.from({length:300001},(_,i)=>i%251)));
    assert.equal(state.downloadRequests,before+1,'download response must not repeat the original HTTP request');assert.equal(state.downloadMethod,method);if(method==='POST')assert.equal(state.downloadBody,'ticket=one-use-fixture');
    assert.ok(await remoteOne.locator('#text').isVisible(),'download preserves the shared page');
    console.log('PASS: exact original '+method+' download response');
  }
  const blobDownload=one.waitForEvent('download',{timeout:10000}).catch(async error=>{console.log('Blob source:',await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'(()=>{const n=document.querySelector("#download-blob"),r=n?.getBoundingClientRect();return {path:location.pathname,node:!!n,handler:!!n?.onclick,generated:!!globalThis.generatedClick,rect:r?.toJSON(),hit:r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id}})()',returnByValue:true}).then(r=>r.result.value));console.log('Blob input:',receivedInputs.slice(-3),vm.runInContext('[...targets.values()].map(t=>({ready:t.documentReady,pending:!!t.pending,version:t.document.version,ctx:t.contextId,actorAgo:Date.now()-(t.lastActor?.time||0)}))',sandbox));console.log('Blob download diagnostic:',await one.locator('#status').textContent(),vm.runInContext('[...targets.values()].map(t=>({lastActor:!!t.lastActor,lastBlob:!!t.lastBlob,count:t.downloadCount}))',sandbox),commandFailures.map(f=>({method:f.method,error:f.error})),errors);throw error;});await remoteOne.locator('#download-blob').click();const generated=await blobDownload;assert.equal(generated.suggestedFilename(),'generated.txt');assert.equal(await readFile(await generated.path(),'utf8'),'generated file 中文');
  console.log('PASS: GET, POST and generated Blob binary downloads reach native visitor downloads without replaying requests');
  const sourceMetrics=()=>chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scroll:scrollY})',returnByValue:true}).then(r=>r.result.value);
  await one.locator('#share-settings-toggle').click();await one.locator('#restore-viewport').click();await one.locator('#share-settings-toggle').click();
  await until(()=>sourceMetrics().then(m=>m.width!==1440),'restore source before independent display checks');
  const nativeMetrics=await sourceMetrics();
  async function assertFits(page){await until(()=>page.evaluate(()=>{const stage=document.querySelector('#stage'),surface=document.querySelector('#surface'),style=getComputedStyle(stage),box=surface.getBoundingClientRect();return (box.width<=stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)+1&&box.height<=stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)+1)&&document.documentElement.scrollWidth<=innerWidth;}),'shared surface fits available window');}
  for(const size of [{width:390,height:844},{width:390,height:260},{width:844,height:390},{width:3840,height:2160}]){await one.setViewportSize(size);await assertFits(one);await until(()=>noOuterScrollbars(one),'scaled DOM has no outer scrollbar');const before=state.clicks;await remoteOne.locator('#click').click();await until(()=>state.clicks===before+1,'scaled DOM click at '+size.width+'x'+size.height);}
  const frameBox=await one.locator('#mirror').boundingBox(),scale=Number(await one.locator('#surface').getAttribute('data-scale'));
  for(const x of [210,211,212])await one.mouse.move(frameBox.x+x*scale,frameBox.y+100*scale);
  await until(()=>chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'globalThis.__mouseProbe',returnByValue:true}).then(r=>r.result.value).then(p=>p?.trusted&&Math.abs(p.x-212)<=1&&Math.abs(p.y-100)<=1),'last pointer coordinate reaches the source after scaled rapid moves');
  assert.equal((await sourceMetrics()).width,nativeMetrics.width,'independent fitting never changes source resolution');
  await one.setViewportSize({width:390,height:180});await assertFits(one);await one.locator('#share-settings-toggle').click();
  await one.locator('#display-sizing').selectOption('width');await until(()=>one.evaluate(()=>{const e=document.querySelector('#stage');return e.scrollHeight>e.clientHeight;}),'fit-width allows local vertical pan');
  await one.locator('#display-sizing').selectOption('actual');await until(()=>one.evaluate(()=>{const e=document.querySelector('#stage');return e.scrollWidth>e.clientWidth&&Number(document.querySelector('#surface').dataset.scale)===1;}),'original size allows horizontal and vertical pan');
  assert.notEqual(await one.locator('#surface').getAttribute('data-scale'),await two.locator('#surface').getAttribute('data-scale'),'visitors have independent display settings');
  await one.locator('#display-zoom').fill('150');assert.equal(await one.locator('#display-sizing').inputValue(),'custom');await until(()=>one.locator('#surface').getAttribute('data-scale').then(s=>s==='1.5'),'custom zoom');
  await one.locator('#display-sizing').selectOption('fit');await one.locator('#share-settings-toggle').click();await one.setViewportSize({width:390,height:844});await assertFits(one);
  await one.bringToFront();await one.locator('#share-settings-toggle').click();await one.locator('#fullscreen').click();await until(()=>one.evaluate(()=>!!document.fullscreenElement),'fullscreen enters').catch(async error=>{console.log('Fullscreen state:',await one.evaluate(()=>({enabled:document.fullscreenEnabled,visible:document.visibilityState,status:document.querySelector('#status').textContent})));throw error;});await assertFits(one);await one.locator('#fullscreen').click();await until(()=>one.evaluate(()=>!document.fullscreenElement),'fullscreen exits');
  await one.evaluate(()=>Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:false}));await one.locator('#fullscreen').click();await until(()=>one.evaluate(()=>document.body.classList.contains('immersive')&&!document.fullscreenElement),'browser without fullscreen uses immersive display');await assertFits(one);await one.locator('#fullscreen').click();await one.evaluate(()=>{delete document.fullscreenEnabled;});
  if(!await one.locator('#share-settings').isVisible())await one.locator('#share-settings-toggle').click();await one.locator('#follow-viewport').check();
  await until(async()=>{const m=await sourceMetrics();return m.width<600&&m.height>=240;},'shared viewport adapts source layout');
  await until(()=>remoteTwo.locator('#responsive').evaluate(e=>getComputedStyle(e).backgroundColor==='rgb(210, 240, 220)'),'responsive CSS is computed on source and shared with other viewers');
  const followedSize=await sourceMetrics();await one.locator('#display-zoom').fill('150');await new Promise(resolve=>setTimeout(resolve,650));assert.equal((await sourceMetrics()).width,followedSize.width,'local zoom does not resize shared layout');await one.locator('#display-sizing').selectOption('fit');
  const beforeSmall=state.clicks;await one.locator('#share-settings-toggle').click();await remoteOne.locator('#click').click();await until(()=>state.clicks===beforeSmall+1,'click after real source reflow');
  await two.locator('#share-settings-toggle').click();await two.locator('#follow-viewport').check();await until(async()=>(await sourceMetrics()).width>1000,'second viewer takes viewport control');
  await until(()=>one.locator('#follow-viewport').isChecked().then(v=>!v),'old driver stops following');
  const secondSize=await sourceMetrics();await one.setViewportSize({width:844,height:390});await new Promise(resolve=>setTimeout(resolve,800));assert.equal((await sourceMetrics()).width,secondSize.width,'old viewer resizing cannot overwrite new driver');
  await two.locator('#restore-viewport').click();await until(async()=>(await sourceMetrics()).width===nativeMetrics.width,'explicit source viewport restore');await two.locator('#share-settings-toggle').click();
  // Real mobile input and high DPI: bitmap coordinates remain source CSS pixels.
  const phoneContext=await visitors.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,hasTouch:true,isMobile:true});
  const phone=await view(share.value.shareUrl,phoneContext);await assertFits(phone);
  await phone.locator('#share-settings-toggle').click();await phone.locator('#follow-viewport').check();await until(async()=>{const m=await sourceMetrics();return m.width<600&&m.dpr===2;},'high-DPI source viewport');
  await phone.setViewportSize({width:844,height:390});await until(async()=>(await sourceMetrics()).width>600,'driving viewer rotation updates source width');
  await until(()=>chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:"screen.orientation.type==='landscape-primary'",returnByValue:true}).then(r=>r.result.value),'source orientation follows driving viewer');
  await phone.setViewportSize({width:390,height:844});await until(async()=>{const m=await sourceMetrics();return m.width<600&&m.dpr===2;},'driving viewer rotates back');
  await phone.locator('#share-settings-toggle').click();await phone.locator('#mirror').waitFor({state:'visible'});assert.equal(await phone.locator('#fallback').isVisible(),false);await assertFits(phone);
  const phoneButton=phone.frameLocator('#mirror').locator('#click'),pixels=await phoneButton.boundingBox();
  const beforeTouch=state.clicks;await phone.touchscreen.tap(pixels.x+pixels.width/2,pixels.y+pixels.height/2);await until(()=>state.clicks===beforeTouch+1,'DPR2 native DOM touch click');
  const gesture=await phoneContext.newCDPSession(phone);const x=250,startY=600,endY=300;
  await gesture.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:startY}]});
  for(let step=1;step<=5;step++){await gesture.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:startY+(endY-startY)*step/5}]});await new Promise(resolve=>setTimeout(resolve,60));}
  await gesture.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await until(async()=>(await sourceMetrics()).scroll>50,'native DOM touch swipe scrolls original page');assert.equal(state.clicks,beforeTouch+1,'swipe never becomes a source click');
  await phoneContext.close();
  await until(async()=>{const m=await sourceMetrics();return m.width===nativeMetrics.width&&m.height===nativeMetrics.height&&m.dpr===nativeMetrics.dpr;},'driver disconnect restores native source viewport');
  await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'scrollTo(0,0)'});await until(async()=>(await sourceMetrics()).scroll===0,'restore source scroll');
  await one.setViewportSize({width:1440,height:1000});await assertFits(one);await one.screenshot({path:path.join(root,'test-results/responsive-display.png')}).catch(async()=>{await mkdir(path.join(root,'test-results'),{recursive:true});await one.screenshot({path:path.join(root,'test-results/responsive-display.png')});});
  console.log('PASS: phone/landscape/4K fit, independent width/original/zoom, full screen, source responsive reflow, driver handoff/restoration, DPR2 native DOM tap and touch swipe');
  await navigate(one,sourceURL.replace('/fixture','/next'));
  await until(() => state.path === '/next', 'shared browser navigation');
  assert.ok(state.cookie.includes('shared-login=present'), 'shared browser preserves login cookies');
  await remoteOne.locator('h1').filter({hasText:'/next'}).waitFor({state:'visible'});
  await until(()=>one.evaluate(()=>decodeURIComponent(location.hash).includes('/next')),'source URL reflected in hash');
  await one.goBack();await remoteOne.locator('h1').filter({hasText:'/fixture'}).waitFor();await until(()=>two.evaluate(()=>decodeURIComponent(location.hash).includes('/fixture')),'other visitor follows native back');
  await one.goForward();await remoteOne.locator('h1').filter({hasText:'/next'}).waitFor();
  await one.reload();await remoteOne.locator('h1').filter({hasText:'/next'}).waitFor();await until(()=>one.locator('#dot').getAttribute('class').then(c=>c==='live'),'refresh keeps capability separate from hash route');
  await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:"const spa=document.createElement('button');spa.id='spa';spa.textContent='SPA';spa.style.cssText='left:250px;top:220px';spa.onclick=()=>history.pushState({},'',location.pathname+'?spa=1#section');document.body.append(spa)"});
  await remoteOne.locator('#spa').click();await until(()=>one.evaluate(()=>decodeURIComponent(location.hash).includes('?spa=1#section')),'SPA pushState updates shared hash');
  await one.goBack();await until(()=>chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'location.search',returnByValue:true}).then(r=>r.result.value===''),'native back traverses same-document source history');
  await one.goForward();await until(()=>two.evaluate(()=>decodeURIComponent(location.hash).includes('?spa=1#section')),'same-document forward synchronizes second visitor');
  await one.goBack();await until(()=>one.evaluate(()=>!decodeURIComponent(location.hash).includes('?spa=1')),'return from SPA route');
  console.log('PASS: full viewport without outer chrome, draggable settings, hash URL, native browser back/forward and reload');
  const box=await one.locator('#mirror').boundingBox();await one.mouse.move(box.x+box.width/2,box.y+box.height/2);await one.mouse.wheel(0,500);
  await new Promise(resolve=>setTimeout(resolve,1200));
  await until(()=>state.scroll>0,'real tab scrolling',6000).catch(async error=>{console.log('Scroll wire:',viewerInputs.filter(i=>i.action==='scroll'),receivedInputs.filter(i=>i.action==='scroll'),actions.slice(-5));console.log('Recent deltas:',packets.slice(-4).map(p=>({reset:p.document.reset,root:p.document.root,nodes:p.document.nodes.map(n=>({id:n.id,tag:n.tag})),updates:p.document.updates,removes:p.document.removes})));console.log('Frame:',await one.locator('#mirror').evaluate(f=>({url:f.contentWindow.location.href,body:!!f.contentDocument.body,html:f.contentDocument.documentElement.outerHTML.slice(0,500)})),errors);throw error;});
  await one.close(); await two.close();
  const reused = await view(share.value.shareUrl);
  const sources = (await cdp.call('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.targetId!==offscreenTarget && t.url.startsWith(`http://127.0.0.1:${fixture.address().port}/`));
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
  const mirroredCanvas=reopened.frameLocator('#mirror').locator('[data-unsupported=canvas]');await mirroredCanvas.locator('[data-raster]').waitFor().catch(async error=>{console.log('Source target states:',vm.runInContext('[...targets].map(([tabId,t])=>({tabId,streaming:t.streaming,frameBusy:t.frameBusy,lastFrame:t.lastFrame}))',sandbox));console.log('Offscreen capture bindings:',await chrome.runtime.sendMessage({target:'offscreen',type:'inspect'}));console.log('Capture frame counts:',sourceFrames,offscreenFrames,videoCommands);console.log('Region geometries:',videoGeometries.slice(-3));console.log('Region video:',await reopened.locator('#stream').evaluate(v=>({ready:v.readyState,width:v.videoWidth,paused:v.paused,track:v.srcObject?.getTracks().map(t=>({state:t.readyState,muted:t.muted}))})));console.log('Region DOM:',await mirroredCanvas.evaluate(n=>({id:n.dataset.nodeId,children:n.children.length,rect:{w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}})));console.log('Region errors:',errors.slice(-5));throw error;});await mirroredCanvas.click();await until(()=>state.canvasClicks===1,'canvas region input controls real tab');
  const newTab=(await getTabs()).find(t=>t.targetId===newSources[0].targetId);
  if(rtcEnabled)await until(async()=>{const capture=(await rtcInspect()).captures.find(c=>c.tabId===newTab.id);return capture?.width===200&&capture.height===90;},'source encodes only the canvas region, not the full viewport');
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"const overlay=document.createElement('div');overlay.id='overlay';overlay.style.cssText='position:absolute;left:45px;top:365px;width:150px;height:60px;background:red;z-index:99';document.body.append(overlay)"});
  await reopened.frameLocator('#mirror').locator('#overlay').waitFor({state:'visible'});assert.equal(await reopened.locator('#fallback').isVisible(),false);assert.equal(await reopened.locator('#mirror').isVisible(),true);
  if(rtcEnabled)await until(()=>mirroredCanvas.locator('canvas[data-raster]').evaluate(c=>c.getContext('2d').getImageData(20,20,1,1).data[3]===0),'DOM overlay masks regional video pixels');
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"document.querySelector('#overlay').remove()"});
  await reopened.locator('#mirror').waitFor({state:'visible'});
  await until(()=>mirroredCanvas.locator('[data-raster]').evaluate(image=>{const canvas=image.tagName==='CANVAS'?image:document.createElement('canvas');if(image.tagName!=='CANVAS'){if(!image.complete||!image.naturalWidth)return false;canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;}const ctx=canvas.getContext('2d');if(image.tagName!=='CANVAS')ctx.drawImage(image,0,0);const pixel=ctx.getImageData(20,20,1,1).data;return pixel[0]<10&&pixel[1]<10&&pixel[2]<10;}),'fresh region image after overlay removal').catch(async error=>{console.log('Source region diagnostic:',await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"(()=>{const c=document.querySelector('#canvas'),r=c.getBoundingClientRect();return {scrollY,rect:r.toJSON(),pixel:[...c.getContext('2d').getImageData(20,20,1,1).data],overlay:!!document.querySelector('#overlay')}})()",returnByValue:true}).then(r=>r.result.value));console.log('Region diagnostic:',await mirroredCanvas.locator('[data-raster]').evaluate(image=>({tag:image.tagName,ready:image.complete,width:image.naturalWidth,src:image.src?.slice(0,40),style:image.getAttribute('style'),pixel:(()=>{try{const c=document.createElement('canvas');c.width=image.naturalWidth||image.width;c.height=image.naturalHeight||image.height;const x=c.getContext('2d');x.drawImage(image,0,0);return [...x.getImageData(20,20,1,1).data];}catch(e){return e.message;}})()})),errors);throw error;});
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"document.querySelector('#canvas').style.left='-50px'"});
  await until(()=>mirroredCanvas.locator('[data-raster]').evaluate(n=>Math.abs(parseFloat(n.style.left)-50)<1&&Math.abs(parseFloat(n.style.width)-150)<1),'partially offscreen canvas is cropped without stretching');
  assert.equal(await reopened.locator('#fallback').isVisible(),false);
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"document.querySelector('#canvas').style.left='40px'"});
  await until(()=>mirroredCanvas.locator('[data-raster]').evaluate(n=>parseFloat(n.style.left)===0&&parseFloat(n.style.width)===200),'regional canvas returns to full visible width');
  if(rtcEnabled){
    await reopened.bringToFront();await until(async()=>(await rtcInspect()).peers.some(p=>p.tabId===newTab.id&&p.profile.visible&&p.video.maxFramerate>2),'foreground regional video budget');
    // CDP drives real canvas changes without relying on hidden-tab JS timer scheduling.
    let drawing=false,videoAnimationError;videoAnimation=setInterval(async()=>{if(drawing)return;drawing=true;try{await cdp.evaluate(sessions.get(newTab.id),"(()=>{const c=document.querySelector('#canvas'),ctx=c.getContext('2d');ctx.fillStyle='rgb('+Math.floor(Math.random()*255)+',0,0)';ctx.fillRect(0,0,200,90)})()");}catch(error){videoAnimationError=error;}finally{drawing=false;}},33);
    const sourceStart=sourceFrames,offscreenStart=offscreenFrames;const start=await reopened.locator('#stream').evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames);
    await new Promise(resolve=>setTimeout(resolve,2100));const end=await reopened.locator('#stream').evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames);
    clearInterval(videoAnimation);await until(()=>!drawing,'last canvas animation paint completed');if(videoAnimationError)throw videoAnimationError;assert.ok(end-start>12,'video exceeds emergency screenshot cap: '+JSON.stringify({frames:end-start,capture:await rtcInspect(),sourceFrames:sourceFrames-sourceStart,offscreenFrames:offscreenFrames-offscreenStart,source:vm.runInContext('[...targets].map(([id,t])=>({id,videoFPS:t.videoFPS,frameBusy:t.frameBusy,streaming:t.streaming}))',sandbox)}));console.log('PASS: continuous encoded WebRTC video:',end-start,'decoded frames in 2.1 s');
  }
  if(rtcEnabled){
    const samples=[];for(const color of [[0,210,40],[40,40,220],[220,190,0]]){
      const begin=performance.now();await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"(()=>{const c=document.querySelector('#canvas').getContext('2d');c.fillStyle='rgb("+color.join(',')+")';c.fillRect(0,0,200,90)})()"});
      const end=Date.now()+1500;let visible=false;while(Date.now()<end){visible=await mirroredCanvas.locator('canvas[data-raster]').evaluate((c,expected)=>{const p=c.getContext('2d').getImageData(20,20,1,1).data;return expected.every((v,i)=>Math.abs(v-p[i])<35);},color);if(visible)break;await new Promise(r=>setTimeout(r,10));}
      assert.ok(visible,'regional video must show a fresh source paint');samples.push(Math.round(performance.now()-begin));
    }
    console.log('Regional paint-to-visible latency (ms):',samples);
  }
  console.log('PASS: canvas region pixels and real input; overlapping overlay preserves DOM and only masks regional video');
  await reopened.screenshot({path:path.join(root,'test-results/shared-dom.png')});
  console.log('PASS: URL share reopens a closed tab; tab-only share never opens replacement');
  if(rtcEnabled){
    await reopened.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
    await until(async()=>(await rtcInspect()).peers.filter(p=>p.tabId===newTab.id&&p.track==='live').some(p=>p.profile.visible===false&&p.video.maxFramerate===2),'background visitor video budget');
    await reopened.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));});
    await until(async()=>(await rtcInspect()).peers.filter(p=>p.tabId===newTab.id&&p.track==='live').some(p=>p.profile.visible===true&&p.video.maxFramerate===30),'foreground video budget restored');
    console.log('PASS: source-side regional video encoding, compressed DOM and automatic background/foreground video budgets');
  }
  const beforeDirectResources=resourceUploads;
  await navigate(reopened,sourceURL.replace('/fixture','/compat'));
  const compatibility=reopened.frameLocator('#mirror');await compatibility.locator('#closed-button').waitFor({state:'visible'});
  assert.equal(await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"document.querySelector('#shadow-host').shadowRoot===null",returnByValue:true}).then(r=>r.result.value),true,'fixture uses a closed shadow root');
  await compatibility.locator('#closed-button').click();await until(()=>state.shadowClicked,'closed shadow control');
  await compatibility.locator('#closed-input').click();await reopened.keyboard.type('shadow');await until(()=>state.shadowText==='shadow','closed shadow text input');
  await until(()=>compatibility.locator('#remote-image').evaluate(e=>e.complete&&e.naturalWidth===80),'cross-origin authenticated image via relay',20000).catch(async error=>{console.log('Image diagnostic:',{reads:resourceReads,viewer:await compatibility.locator('#remote-image').evaluate(e=>({src:e.getAttribute('src'),complete:e.complete,width:e.naturalWidth})),transport:await reopened.locator('#status').textContent(),offscreen:rtcEnabled?await rtcInspect():null});throw error;});
  assert.ok(assetHits.find(hit=>hit.url==='/image.svg').cookie.includes('shared-login=present'),'source image used source cookie');
  assert.equal(await compatibility.locator('#remote-image').getAttribute('src').then(s=>s.startsWith('blob:')),true,'visitor uses relay blob, never original URL');
  assert.equal(await compatibility.locator('#badge').evaluate(e=>getComputedStyle(e,'::before').content),'"★"','pseudo element content');
  await until(()=>compatibility.locator('#badge').evaluate(e=>[...e.ownerDocument.fonts].some(f=>f.family==='SharedFont'&&f.status==='loaded')),'cross-origin font face loaded',20000).catch(async error=>{console.log('Resource reads:',resourceReads);console.log('Font styles:',await compatibility.locator('#badge').evaluate(e=>({fonts:[...e.ownerDocument.fonts].map(f=>({family:f.family,status:f.status})),styles:[...e.ownerDocument.styleSheets].flatMap(s=>[...s.cssRules].map(r=>r.cssText)).filter(r=>r.includes('font-face'))})));throw error;});
  assert.ok(await compatibility.locator('#background').evaluate(e=>getComputedStyle(e).backgroundImage.startsWith('url("blob:')),'CSS image forwarded');
  if(rtcEnabled)assert.equal(resourceUploads,beforeDirectResources,'cross-origin images and font bytes bypass Go relay');
  if(rtcEnabled){
    const emergency=await context.newPage();await emergency.addInitScript(()=>{globalThis.RTCPeerConnection=undefined;});emergency.on('pageerror',e=>errors.push(e.message));
    await emergency.goto(share.value.shareUrl);
    await until(()=>emergency.frameLocator('#mirror').locator('#remote-image').evaluate(e=>e.complete&&e.naturalWidth===80),'new fallback visitor receives resources after P2P navigation',35000);
    await until(()=>emergency.frameLocator('#mirror').locator('#badge').evaluate(e=>[...e.ownerDocument.fonts].some(f=>f.family==='SharedFont'&&f.status==='loaded')),'new fallback visitor receives font');
    assert.ok(resourceUploads>beforeDirectResources,'fallback restores resources through HTTP');await emergency.close();
    await until(async()=>{const r=await fetch(origin+'/api/stats',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());return r.resourceBytes===0&&r.domBytes===0;},'direct-only sessions release server resource and DOM caches');
    console.log('PASS: new fallback visitor after P2P navigation receives image/font; last fallback departure releases server caches');
  }
  // The rich editor has no source scripts in the mirror. Range replacement runs trusted input on the source.
  await compatibility.locator('#rich').evaluate(e=>{e.focus();const s=e.ownerDocument.getSelection();s.setBaseAndExtent(e.querySelector('strong').firstChild,2,e.querySelector('em').firstChild,3);});
  await reopened.keyboard.insertText('你好');await until(()=>state.richText==='al你好vo','rich text range spans nested elements');assert.equal(state.trusted,true,'rich text uses trusted CDP editing');
  await compatibility.locator('#js-prompt').click();await reopened.locator('#site-dialog').waitFor({state:'visible'});await reopened.locator('#dialog-value').fill('shared answer');await reopened.locator('#dialog-answer button[type=submit]').click();await until(()=>state.promptResult==='shared answer','shared JavaScript prompt');
  await compatibility.locator('#show-dialog').click();await until(()=>compatibility.locator('#native-dialog').evaluate(e=>e.matches(':modal')),'native modal top layer');await compatibility.locator('#close-dialog').click();await until(()=>compatibility.locator('#native-dialog').evaluate(e=>!e.open),'native modal close');
  await compatibility.locator('#show-popover').click();await until(()=>compatibility.locator('#native-popover').evaluate(e=>e.matches(':popover-open')),'native popover top layer');
  // The fixed control exists on the source, is isolated from site CSS, and is excluded from the DOM mirror.
  assert.equal(await compatibility.locator('[data-tabshare-owner-ui]').count(),0,'owner controls excluded from mirror');
  await chrome.debugger.sendCommand({tabId:newTab.id},'Page.bringToFront');
  const ownerRoot=(await chrome.debugger.sendCommand({tabId:newTab.id},'DOM.getDocument',{depth:-1,pierce:true})).root;
  const findOwner=n=>n.attributes?.includes('data-tabshare-owner-ui')?n:(n.children||[]).map(findOwner).find(Boolean);const owner=findOwner(ownerRoot);assert.ok(owner,'source fixed sharing button exists');
  const object=(await chrome.debugger.sendCommand({tabId:newTab.id},'DOM.resolveNode',{backendNodeId:owner.shadowRoots[0].backendNodeId})).object;
  const ownerButton=await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:"function(){const b=this.querySelector('button'),r=b.getBoundingClientRect();this.probe=[];for(const type of ['pointerdown','pointermove'])b.addEventListener(type,e=>this.probe.push({type:e.type,primary:e.isPrimary,id:e.pointerId,x:e.clientX,y:e.clientY}));return {label:b.textContent,x:r.x,y:r.y,width:r.width,height:r.height,hit:document.elementFromPoint(r.x+20,r.y+20)?.outerHTML.slice(0,180),inner:[innerWidth,innerHeight],outer:[outerWidth,outerHeight],modal:[...document.querySelectorAll(':modal')].map(n=>n.tagName)}}",returnByValue:true});
  const ob=ownerButton.result.value;assert.equal(ob.label,'共享设置');
  for(const [type,x,y] of [['mouseMoved',ob.x+20,ob.y+20],['mousePressed',ob.x+20,ob.y+20],['mouseMoved',100,100],['mouseReleased',100,100]])await chrome.debugger.sendCommand({tabId:newTab.id},'Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&x!==100?'none':'left',buttons:type==='mousePressed'||type==='mouseMoved'&&x===100?1:0,clickCount:1});
  const ownerPosition=await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:"function(){const r=this.querySelector('button').getBoundingClientRect();return {x:r.x,y:r.y,hidden:this.querySelector('section').hidden,events:this.probe}}",returnByValue:true});
  assert.ok(ownerPosition.result.value.x<150&&ownerPosition.result.value.y<150,JSON.stringify({before:ob,after:ownerPosition.result.value}));assert.equal(ownerPosition.result.value.hidden,true,'owner dragging does not open settings');
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:"function(){this.querySelector('button').click();this.querySelector('button').click()}"});
  await reopened.locator('#mirror').waitFor({state:'visible'});assert.equal(await compatibility.locator('[data-tabshare-owner-ui]').count(),0);
  // Move the owner UI away from controls before exercising the source popup.
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:"document.querySelector('[data-tabshare-owner-ui]').style.setProperty('left','1000px','important')"});
  await compatibility.locator('#open-popup').click();await compatibility.locator('h1').filter({hasText:'Shared induced popup'}).waitFor({state:'visible',timeout:20000});await compatibility.locator('#popup-text').click();await reopened.keyboard.insertText('popup input');await until(()=>compatibility.locator('#popup-text').inputValue().then(v=>v==='popup input'),'popup retains native mirrored input');const popupDownload=reopened.waitForEvent('download');await compatibility.locator('#popup-download').click();assert.equal((await popupDownload).suggestedFilename(),'共享报告.bin');assert.equal(await reopened.locator('#mirror').isVisible(),true);await compatibility.locator('button').click();await compatibility.locator('#closed-button').waitFor({state:'visible',timeout:20000});assert.equal((await getTabs()).find(t=>t.id===newTab.id).targetId,newSources[0].targetId,'popup closes back to original source');
  console.log('PASS: cookie-bound cross-origin image/CSS/font relay, closed Shadow DOM, pseudo content, trusted rich text selection, JS prompt, native modal/popover, owner and visitor draggable settings, induced popup and return');
  await navigate(reopened,sourceURL.replace('/fixture','/pixel-editor'));
  const pixelEditor=reopened.frameLocator('#mirror').locator('#remote-editor');await pixelEditor.waitFor();
  await pixelEditor.click({position:{x:50,y:48}});
  await until(()=>reopened.locator('#remote-input').evaluate(n=>document.activeElement===n&&!n.hidden),'video region focuses native IME proxy');
  await until(()=>packets.at(-1)?.document.meta?.caret?.x>60,'source iframe caret metadata');
  await until(async()=>{const sourceCaret=packets.at(-1)?.document.meta.caret;if(!sourceCaret)return false;const local=await reopened.evaluate(()=>{const frame=document.querySelector('#mirror'),proxy=document.querySelector('#remote-input'),r=frame.getBoundingClientRect(),p=proxy.getBoundingClientRect(),scale=r.width/frame.clientWidth;return {x:p.x,y:p.y,scale,frameX:r.x,frameY:r.y};});return Math.abs(local.x-local.frameX-sourceCaret.x*local.scale)<2&&Math.abs(local.y-local.frameY-sourceCaret.y*local.scale)<2;},'IME proxy follows the remote caret, including iframe offsets and zoom');
  await reopened.locator('#remote-input').evaluate(n=>{n.dispatchEvent(new CompositionEvent('compositionstart'));n.dispatchEvent(new CompositionEvent('compositionend',{data:'中文'}));});
  await until(()=>chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:'document.querySelector("iframe").contentDocument.querySelector("input").value',returnByValue:true}).then(r=>r.result.value.includes('中文')),'regional IME composition reaches original editor');
  await chrome.debugger.sendCommand({tabId:newTab.id},'Runtime.evaluate',{expression:'(()=>{const n=document.querySelector("iframe").contentDocument.querySelector("input");n.focus();n.setSelectionRange(0,3);})()'});
  await until(()=>reopened.frameLocator('#mirror').locator('#tabshare-selection').textContent().then(v=>v.length===3),'regional selection becomes native local copy selection');
  const expectedSelection=packets.at(-1).document.meta.selection.text;await reopened.keyboard.press('Control+C');assert.equal(await reopened.evaluate(()=>navigator.clipboard.readText()),expectedSelection);
  await pixelEditor.click({button:'right',position:{x:50,y:48}});assert.equal(await reopened.locator('#page-context-menu').isHidden(),true,'regional text uses browser native context menu');
  console.log('PASS: video-region iframe caret and IME alignment, composition input and native selected-text copy/context menu');
  await navigate(reopened,sourceURL);await reopened.frameLocator('#mirror').locator('#click').waitFor();
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
  }
} catch (error) {
  console.error(error.message);
  // Logs do not include pairing credentials or share capability URLs.
  console.error('Go service:', serverLog);
  console.error('Source browser:', sourceLog);
  process.exitCode = 1;
} finally {
  clearInterval(videoAnimation);
  await shutdownAgent?.().catch(()=>{});for(const timer of timers)clearInterval(timer);
  cdp?.close(); await visitors?.close(); await stop(source).catch(() => {}); await stop(server).catch(() => {});
  await new Promise(resolve => fixture ? fixture.close(resolve) : resolve());
  await new Promise(resolve=>assets?assets.close(resolve):resolve());
  await rm(temporary, {recursive: true, force: true});
}
