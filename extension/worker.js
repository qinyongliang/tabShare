import {InputQueue} from './input-queue.js';
import {DocumentState} from './document-state.js';
import {serverOrigin, targetURL, resolveTab, cdpInput, rasterFrame, validPeerInput} from './controller.js';
import {installDOM, captureDOM} from './dom-capture.js';
import {ResourceBridge} from './resources.js';

let config, socket, connecting, retryTimer;
const bindings = new Map();
const targets = new Map();
const opening = new Map();
const peers = new Map(), nativeTabs = new Set();
let offscreenOpening,offscreenReady=false;
async function offscreen(message) {
  if(!chrome.offscreen)return false;
  if(!offscreenReady&&!offscreenOpening)offscreenOpening=(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
    if(!contexts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WEB_RTC','USER_MEDIA'],justification:'Shared-tab WebRTC video and authenticated peer data channels'});
    offscreenReady=true;
  })().finally(()=>{offscreenOpening=null;});
  await offscreenOpening;
  try{return await chrome.runtime.sendMessage({target:'offscreen',...message});}catch(error){offscreenReady=false;throw error;}
}
function roomPeers(id){return [...peers.values()].filter(p=>p.sessionId===id);}
function publish(message) {
  const members=roomPeers(message.sessionId);
  if(members.some(p=>p.direct))void offscreen({type:'send',sessionId:message.sessionId,message}).catch(()=>{});
  if(members.some(p=>!p.direct)||!members.length)return transmit(message);
  return true;
}
function resourceConfig(){return {server:serverOrigin(config.server),pairingToken:config.pairingToken,deliver:async(id,asset,item)=>{
  const members=roomPeers(id),recipients=members.filter(p=>p.direct&&!item.sent.has(id+':'+p.viewerId));
  let sentBytes=0;
  if(recipients.length){
    if(!item.sha256)item.sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',item.bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    let raw='';for(let n=0;n<item.bytes.length;n+=4096)raw+=String.fromCharCode(...item.bytes.subarray(n,n+4096));
    const delivered=await offscreen({type:'asset',sessionId:id,viewerIds:recipients.map(p=>p.viewerId),meta:{id:asset,mime:item.mime,size:item.bytes.length,sha256:item.sha256},data:btoa(raw)});
    for(const viewerId of Array.isArray(delivered)?delivered:[]){item.sent.add(id+':'+viewerId);sentBytes+=item.bytes.length;}
  }
  return {relay:!members.length||members.some(p=>!p.direct),sentBytes};
}};}
async function peerJoined(m) {
  const binding=bindings.get(m.sessionId);if(!binding)return;
  peers.set(m.sessionId+':'+m.viewerId,{...m,direct:false});
  const ok=await offscreen({...m,tabId:binding.tabId}).catch(()=>false);
  if(chrome.offscreen&&!ok)await peerState({...m,status:'down'});
}
async function peerLeft(m) {
  peers.delete(m.sessionId+':'+m.viewerId);
  await offscreen({...m,type:'peer-left'}).catch(()=>{});
  const b=bindings.get(m.sessionId),t=b&&targets.get(b.tabId);
  for(const item of t?.resources?.done.values()||[])item.sent?.delete(m.sessionId+':'+m.viewerId);
  if(t?.viewport?.owner===m.viewerId)await resizeViewport(b.tabId,null);
}
async function peerState(m) {
  const p=peers.get(m.sessionId+':'+m.viewerId);if(!p||m.attempt&&p.attempt&&m.attempt!==p.attempt)return;
  if(m.status==='down')setTimeout(()=>{if(peers.get(m.sessionId+':'+m.viewerId)===p&&!p.direct)transmit({type:'peer-retry',sessionId:m.sessionId,viewerId:m.viewerId});},5000);
  p.direct=m.status==='up';transmit({type:'transport',sessionId:m.sessionId,viewerId:m.viewerId,status:p.direct?'p2p':'fallback'});
  const b=bindings.get(m.sessionId),t=b&&targets.get(b.tabId);if(!t)return;
  await peerSnapshot(m.sessionId,m.viewerId);
  if(p.direct)await offscreen({type:'send',sessionId:m.sessionId,viewerId:m.viewerId,message:{type:'mode',mode:t.mode,full:!!t.full}});
  publish({type:'viewport',sessionId:m.sessionId,viewport:t.viewport});
  publish({type:'dialog',sessionId:m.sessionId,dialog:t.dialog||null});
  if(p.direct){const requests=[...t.resources?.done||[]].filter(([,item])=>item.bytes).map(([id])=>({id}));void t.resources?.transfer(requests,t.sessions,resourceConfig());}
  t.videoGeometry=null;t.nextRaster=0;await raster(b.tabId);
}
function peerInput(m) {
  const p=peers.get(m.sessionId+':'+m.viewerId);if(!p||m.attempt&&p.attempt&&m.attempt!==p.attempt)return;
  const now=Date.now();p.tokens=Math.min(200,(p.tokens??200)+(now-(p.last??now))*.12);p.last=now;
  if(--p.tokens<0){void peerLeft(m);return;}
  if(m.message?.type==='resync'){if(now-(p.lastResync||0)>1000){p.lastResync=now;schedule(()=>peerSnapshot(m.sessionId,m.viewerId));}return;}
  if(m.message?.type!=='input'||!validPeerInput(m.message.input))return;
  const input={...m.message.input,viewerId:m.viewerId};
  void enqueueInput({sessionId:m.sessionId,input});
}
function enqueueInput(message){
  const binding=bindings.get(message.sessionId),target=binding&&targets.get(binding.tabId);if(!target)return;
  const member=peers.has(message.sessionId+':'+message.input.viewerId);
  const run=async()=>{if(bindings.get(message.sessionId)!==binding||member&&!peers.has(message.sessionId+':'+message.input.viewerId))return;try{return await control(message);}catch(error){if(bindings.get(message.sessionId)===binding)status(message.sessionId,'error',error.message);}};
  if(message.input.action==='dialog')return run();
  target.inputs??=new InputQueue();
  const key=message.input.action==='mouseMoved'?'move:'+message.input.viewerId:null;
  const coalesced=key&&target.inputs.pending.at(-1)?.key===key,job=target.inputs.push(run,key);
  if(coalesced)return job;
  return job.catch(()=>{
    const viewerId=message.input.viewerId;if(!viewerId)return;
    transmit({type:'peer-drop',sessionId:message.sessionId,viewerId});void peerLeft({sessionId:message.sessionId,viewerId});
  });
}
async function peerSnapshot(sessionId,viewerId) {
  const b=bindings.get(sessionId),t=b&&targets.get(b.tabId),p=peers.get(sessionId+':'+viewerId);if(!t||!p)return;
  // Freeze only DOM collection while enqueuing an initial snapshot before future deltas.
  t.syncing=true;
  try{while(t.capturing)await new Promise(resolve=>setTimeout(resolve,10));const document=t.document?.snapshot();
    if(document){if(p.direct)await offscreen({type:'send',sessionId,viewerId,message:{type:'dom',document}});else transmit({type:'dom',sessionId,document});}
    else {t.syncing=false;await resync(sessionId);}
  }finally{t.syncing=false;}
}
async function backgroundVideo(tabId) {
  const t=targets.get(tabId);if(!t?.streaming||nativeTabs.has(tabId)||t.frameBusy||Date.now()<(t.nextVideo||0)||Date.now()-(t.lastFrame||0)<500)return;
  t.frameBusy=true;
  try{
    const {data}=await command(tabId,'Page.captureScreenshot',{format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:false});
    const changed=data!==t.lastShot;t.videoIdleDelay=changed?1000/(t.videoFPS||30):Math.min(1000,(t.videoIdleDelay||33)*1.5);t.lastShot=data;
    if(changed&&t.streaming)await offscreen({type:'frame',tabId,data});t.nextVideo=Date.now()+t.videoIdleDelay;
  }catch{/* An inactive/new tab can temporarily have no compositor surface. */}finally{t.frameBusy=false;}
}
async function videoState(tabId,active) {
  const t=targets.get(tabId);if(!t||t.streaming===active)return;
  t.streaming=active;
  if(nativeTabs.has(tabId)){await offscreen({type:'active-video',tabId,active});return;}
  if(active)try{
    await command(tabId,'Page.startScreencast',{format:'jpeg',quality:80,maxWidth:3840,maxHeight:2160,everyNthFrame:Math.max(1,Math.round(30/(t.videoFPS||30)))});
    // A newly opened background tab may not have produced its first compositor frame yet.
    if(!t.frameBusy){t.frameBusy=true;try{const seed=await command(tabId,'Page.captureScreenshot',{format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:false});if(t.streaming){t.lastShot=seed.data;await offscreen({type:'frame',tabId,data:seed.data});}}finally{t.frameBusy=false;}}
  }catch{t.streaming=false;}
  else {await command(tabId,'Page.stopScreencast').catch(()=>{});await offscreen({type:'stop-video',tabId}).catch(()=>{});}
}
let operationChain = Promise.resolve();
function schedule(task) { operationChain = operationChain.then(task).catch(error => console.warn('TabShare operation failed:',error.message)); }
const boot = (async () => {
  let {epoch} = await chrome.storage.session.get('epoch');
  if (!epoch) { epoch = crypto.randomUUID(); await chrome.storage.session.set({epoch}); }
  return epoch;
})();

async function loadConfig() {
  config = await chrome.storage.local.get(['server', 'pairingToken', 'agentId', 'enabled']);
  if (!config.agentId) { config.agentId = crypto.randomUUID(); await chrome.storage.local.set({agentId: config.agentId}); }
  return config;
}
function transmit(message) {
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 2 * 1024 * 1024) { socket.send(JSON.stringify(message)); return true; }
  return false;
}
function status(sessionId, value, detail = '', tab = {}) {
  transmit({type: 'status', sessionId, status: value, detail, url: tab.url, title: tab.title});
}
async function connect() {
  if (connecting) return connecting;
  if (socket?.readyState === WebSocket.OPEN) return;
  connecting = (async () => {
    await loadConfig();
    if (!config.enabled || !config.server || !config.pairingToken) return;
    const origin = serverOrigin(config.server);
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws/agent');
    socket = ws;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { ws.close(); reject(new Error('连接超时')); }, 10000);
      let ready = false;
      ws.onopen = () => ws.send(JSON.stringify({type: 'hello', token: config.pairingToken, agentId: config.agentId}));
      ws.onmessage = event => {
        if (socket !== ws) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready') { ready = true; clearTimeout(timeout); resolve(); }
        if (message.type === 'ping') { ws.send(JSON.stringify({type: 'pong'})); }
        if (message.type === 'open') schedule(() => openSession(message.session));
        if (message.type === 'pause') schedule(() => pause(message.sessionId));
        if (message.type === 'resync') schedule(() => resync(message.sessionId));
 if(message.type==='peer')schedule(()=>peerJoined(message));
 if(message.type==='peer-left')schedule(()=>peerLeft(message));
 if(message.type==='signal')void offscreen(message).catch(()=>{});
        if (message.type === 'input') {
          // Commands from all viewers execute in the same order on this browser.
          void enqueueInput(message);
        }
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (!ready) reject(new Error('连接失败，请检查服务器地址和配对令牌'));
        if (socket !== ws) return;
        socket = null;peers.clear();nativeTabs.clear();void offscreen({type:'stop'}).catch(()=>{});
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void connect().catch(() => {}), 5000);
        // No viewers can reach this connection; release capture and debugger permissions.
        schedule(pauseAll);
      };
      ws.onerror = () => {};
    });
  })().finally(() => { connecting = null; });
  return connecting;
}
async function command(tabId, method, params = {}) { return chrome.debugger.sendCommand({tabId}, method, params); }
async function world(tabId) {
  const target = targets.get(tabId);
  if (target.contextId) return target.contextId;
  const tree = await command(tabId, 'Page.getFrameTree');
  const result = await command(tabId, 'Page.createIsolatedWorld', {frameId: tree.frameTree.frame.id, worldName: 'TabShareDOM'});
  target.contextId = result.executionContextId;
  await evaluate(tabId, installDOM);
  await evaluate(tabId, 'globalThis.__tabShareDOM.reset()');
  await evaluate(tabId, 'globalThis.__tabShareDOM.setMode('+JSON.stringify(target.mode||'dom')+')');
  target.resources=new ResourceBridge((method,params)=>command(tabId,method,params),expression=>evaluate(tabId,expression));
  await target.resources.scan().catch(()=>{});
  await shadows(tabId).catch(()=>{});
  return target.contextId;
}
async function evaluate(tabId, expression) {
  const target = targets.get(tabId);
  const result = await command(tabId, 'Runtime.evaluate', {expression, contextId: target.contextId, returnByValue: true, userGesture: true, timeout:2000});
  if (result.exceptionDetails) throw new Error(result.result?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function shadows(tabId) {
  const target=targets.get(tabId);if(!target?.contextId||target.shadowBusy)return;
  target.shadowBusy=true;
  try{
    const {root}=await command(tabId,'DOM.getDocument',{depth:-1,pierce:true});
    const closed=[];const walk=node=>{if(node.shadowRootType==='closed')closed.push(node);for(const c of [...node.children||[],...node.shadowRoots||[]])walk(c);};walk(root);
    for(const node of closed){
      const {object}=await command(tabId,'DOM.resolveNode',{backendNodeId:node.backendNodeId,executionContextId:target.contextId});
      if(!object.objectId)continue;
      try{await command(tabId,'Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){globalThis.__tabShareDOM?.registerShadow(this.host,this)}',returnByValue:true});}finally{await command(tabId,'Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}
    }
  }finally{target.shadowBusy=false;}
}
let modeWrites=Promise.resolve();
function writeModes(update){
  const run=async()=>{const {sessionModes={}}=await chrome.storage.local.get('sessionModes');update(sessionModes);await chrome.storage.local.set({sessionModes});};
  const job=modeWrites.then(run,run);modeWrites=job.catch(()=>{});return job;
}
async function rememberMode(target,mode){
  target.mode=mode;
  await writeModes(modes=>{for(const id of target.sessions)modes[id]=mode;});
  for(const id of target.sessions)publish({type:'mode',sessionId:id,mode,full:mode==='raster'?true:!!target.full});
  target.nextRaster=0;
}

async function snapshot(tabId) {
  const target = targets.get(tabId);
  if (!target || target.capturing || target.syncing || Date.now() < target.nextSend || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512000) return;
  target.capturing = true;
  try {
    await world(tabId);
    const delta = target.pending || await evaluate(tabId, target.mode==='raster'? 'globalThis.__tabShareDOM.capture(true)':captureDOM);
    if (!delta) return;
    if(delta.meta?.mode!==target.mode)await rememberMode(target,delta.meta.mode);
    const requests=delta.resources;delete delta.resources;
    if(!target.pending)target.document.apply(delta);
    if(requests?.length)void target.resources.transfer(requests,target.sessions,resourceConfig());
    let sent = true;
    for (const id of target.sessions) sent = publish({type:'dom', sessionId:id, document:delta}) && sent;
    if (!sent) { target.pending = delta; return; }
    target.pending = null;
    // Coalesce mutations while paying down a byte budget. Initial state is sent only once.
    const bytes = new TextEncoder().encode(JSON.stringify(delta)).byteLength;
    target.nextSend = Date.now() + Math.max(target.videoFPS===2?1000:200, delta.reset ? 200 : bytes / 131072 * 1000);
  } catch (error) {
    target.contextId = null;
    if (targets.has(tabId)) for (const id of target.sessions) status(id,'error',error.message);
  } finally { target.capturing = false; }
}
async function raster(tabId) {
  const target=targets.get(tabId);
  if(!target||target.rasterBusy||Date.now()<target.nextRaster||socket?.readyState!==WebSocket.OPEN||socket.bufferedAmount>256000)return;
  target.rasterBusy=true;
  try{
    await world(tabId);
    let info=await evaluate(tabId,'({...globalThis.__tabShareDOM.fallback(),scrollX,scrollY})');
    info.version=target.document.version;
    if(target.full!==info.full){target.full=info.full;for(const id of target.sessions)publish({type:'mode',sessionId:id,full:info.full,mode:target.mode});}
    const direct=[...target.sessions].some(id=>roomPeers(id).some(p=>p.direct));
    if(direct)info=await offscreen({type:'layout',tabId,info})||info;
    await videoState(tabId,direct&&(info.full||info.regions.length>0));
    const geometry=JSON.stringify(info);
    if(target.videoGeometry!==geometry){target.videoGeometry=geometry;for(const id of target.sessions)publish({type:'video',sessionId:id,info});}
    if(direct&&! [...target.sessions].some(id=>roomPeers(id).some(p=>!p.direct))){target.nextRaster=Date.now()+200;return;}
    let bytes=0;
    const regions=info.full?[{id:'',width:info.width,height:info.height}]:info.regions;
    for(const region of regions){
      const options={format:'jpeg',quality:65,fromSurface:true,captureBeyondViewport:false};
      if(!info.full)options.clip={x:region.x,y:region.y,width:region.width,height:region.height,scale:1};
      const shot=await rasterFrame(params=>command(tabId,'Page.captureScreenshot',params),options);
      bytes+=shot.data.length;
      for(const id of target.sessions)transmit({type:'raster',sessionId:id,nodeId:region.id,full:info.full,data:shot.data,width:region.width,height:region.height});
    }
    // Only disconnected WebRTC peers use this bounded emergency screenshot transport.
    target.nextRaster=Date.now()+Math.max(500,bytes/65536*1000);
  }catch{/* Navigation can temporarily destroy the isolated world. */}finally{target.rasterBusy=false;}
}
async function resizeViewport(tabId,viewport) {
  const target=targets.get(tabId);if(!target)return;
  if(viewport)await command(tabId,'Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:viewport.deviceScaleFactor,mobile:false,screenWidth:viewport.width,screenHeight:viewport.height,screenOrientation:{type:viewport.width>viewport.height?'landscapePrimary':'portraitPrimary',angle:viewport.width>viewport.height?90:0}});
  else if(target.viewport)await command(tabId,'Emulation.clearDeviceMetricsOverride');
  target.viewport=viewport;
  for(const id of target.sessions)transmit({type:'viewport',sessionId:id,viewport});
  await world(tabId);await evaluate(tabId,'globalThis.__tabShareDOM.invalidate()');
  target.pending=null;target.nextSend=0;target.nextRaster=0;await snapshot(tabId);
}
async function resync(sessionId) {
  const binding = bindings.get(sessionId);
  if (!binding) return;
  const target = targets.get(binding.tabId);
  if (!target) return;
  await evaluate(binding.tabId, 'globalThis.__tabShareDOM.reset()');
  target.pending = null; target.nextSend = 0;
  await snapshot(binding.tabId);
}
async function targetFor(tab,mode='dom') {
  let target=targets.get(tab.id);if(target)return target;
  await chrome.debugger.attach({tabId:tab.id},'1.3');
  target={sessions:new Set(),contextId:null,capturing:false,nextSend:0,nextRaster:0,full:null,mode,document:new DocumentState()};targets.set(tab.id,target);
  try{await command(tab.id,'Page.enable');await command(tab.id,'DOM.enable');await command(tab.id,'Network.enable',{maxTotalBufferSize:32*1024*1024,maxResourceBufferSize:8*1024*1024});}
  catch(error){targets.delete(tab.id);await chrome.debugger.detach({tabId:tab.id}).catch(()=>{});throw error;}
  target.timer=setInterval(()=>void snapshot(tab.id),200);target.rasterTimer=setInterval(()=>void raster(tab.id),500);target.videoTimer=setInterval(()=>void backgroundVideo(tab.id),33);return target;
}
async function switchTab(id,tab,binding) {
  const viewport=targets.get(binding.tabId)?.viewport;
  const mode=targets.get(binding.tabId)?.mode||(await chrome.storage.local.get('sessionModes')).sessionModes?.[id]||'dom';
  await pause(id);
  const target=await targetFor(tab,mode);target.sessions.add(id);bindings.set(id,{...binding,tabId:tab.id});
  await offscreen({type:'bind',sessionId:id,tabId:tab.id}).catch(()=>{});
  if(viewport)await resizeViewport(tab.id,viewport);
  if(target.contextId){await evaluate(tab.id,'globalThis.__tabShareDOM.reset()');target.nextSend=0;}
  status(id,'connected','',tab);await snapshot(tab.id);
}
async function openSession(session) {
  if (opening.has(session.id)) return opening.get(session.id);
  const job = (async () => {
    try {
      if(bindings.has(session.id)&&targets.has(bindings.get(session.id).tabId))return;
      const epoch = await boot;
      const stored = await chrome.storage.local.get(['sessionTabs','sessionModes']);
      const tab = await resolveTab(chrome.tabs, session, stored.sessionTabs?.[session.id], epoch);
      if (bindings.has(session.id) && bindings.get(session.id).tabId !== tab.id) await pause(session.id);
      const target=await targetFor(tab,stored.sessionModes?.[session.id]||'dom');
      const alreadyRunning=target.sessions.size>0;
      target.sessions.add(session.id);
      bindings.set(session.id, {tabId: tab.id,rootTabId:tab.id,popups:[], session});
      if(roomPeers(session.id).length)await offscreen({type:'bind',sessionId:session.id,tabId:tab.id}).catch(()=>{});
      const sessionTabs = stored.sessionTabs || {};
      sessionTabs[session.id] = {tabId: tab.id, epoch};
      await chrome.storage.local.set({sessionTabs});
      status(session.id, 'connected', '', tab);
      if(alreadyRunning&&target.contextId){await evaluate(tab.id,'globalThis.__tabShareDOM.reset()');target.nextSend=0;const requests=[...target.resources.done].filter(([,item])=>item.bytes).map(([id])=>({id}));void target.resources.transfer(requests,target.sessions,resourceConfig());}
      await snapshot(tab.id);
    } catch (error) { status(session.id, 'error', error.message); }
  })().finally(() => opening.delete(session.id));
  opening.set(session.id, job);
  return job;
}
async function pause(sessionId) {
  const binding = bindings.get(sessionId);
  if (!binding) return;
  bindings.delete(sessionId);
  const target = targets.get(binding.tabId);
  if (!target) return;
  target.sessions.delete(sessionId);
  if (target.sessions.size) return;
  target.inputs?.clear();clearInterval(target.timer);
  clearInterval(target.rasterTimer);clearInterval(target.videoTimer);
  await videoState(binding.tabId,false);nativeTabs.delete(binding.tabId);await offscreen({type:'stop-video',tabId:binding.tabId}).catch(()=>{});
  target.resources?.dispose();
  if(target.viewport)try{await command(binding.tabId,'Emulation.clearDeviceMetricsOverride');}catch{}
  if(target.contextId)try{await command(binding.tabId,'Runtime.evaluate',{expression:'globalThis.__tabShareDOM?.dispose()',contextId:target.contextId,returnByValue:true});}catch{}
  targets.delete(binding.tabId);
  try { await chrome.debugger.detach({tabId: binding.tabId}); } catch { /* Already closed/detached. */ }
}
async function pauseAll() { for (const id of [...bindings.keys()]) await pause(id); }
async function control(message) {
  const binding = bindings.get(message.sessionId);
  if (!binding) return;
  let input = message.input;
  const {action} = input;
  const target=targets.get(binding.tabId);
  if(action==='viewport'){await resizeViewport(binding.tabId,{width:input.width,height:input.height,deviceScaleFactor:input.deviceScaleFactor,owner:input.viewerId});return;}
  if(action==='restoreViewport'||action==='viewportRelease'){if(action==='viewportRelease'&&target.viewport?.owner!==input.viewerId)return;await resizeViewport(binding.tabId,null);return;}
  if(action==='closePopup'){if(binding.popups?.length)await chrome.tabs.remove(binding.tabId);return;}
  if(action==='dialog'){if(target?.dialog?.id!==input.dialogId)return;await command(binding.tabId,'Page.handleJavaScriptDialog',{accept:!!input.accept,promptText:input.text||''});return;}
  if(action==='mode'){await world(binding.tabId);await evaluate(binding.tabId,'globalThis.__tabShareDOM.setMode('+JSON.stringify(input.mode)+')');await rememberMode(target,input.mode);target.nextSend=0;await snapshot(binding.tabId);return;}
  if (input.nodeId) {
    await world(binding.tabId);
    const point = await evaluate(binding.tabId, 'globalThis.__tabShareDOM.act(' + JSON.stringify(input) + ')');
    if(action==='select'){if(point?.key){for(const key of [point,{key:'Enter',code:'Enter',keyCode:13}])for(const action of ['keyDown','keyUp']){const [method,params]=cdpInput({action,...key});await command(binding.tabId,method,params);}await evaluate(binding.tabId,'globalThis.__tabShareDOM.act('+JSON.stringify({...input,action:'selectFinish'})+')');}return;}
    if (action === 'scroll' || action === 'selection') return;
    input = {...input, ...point};
  }
  if (action === 'back' || action === 'forward') {
    const history = await command(binding.tabId, 'Page.getNavigationHistory');
    const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
    if (entry) await command(binding.tabId, 'Page.navigateToHistoryEntry', {entryId: entry.id});
  } else { const [method, params] = cdpInput(input); await command(binding.tabId, method, params); }
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  const target = targets.get(source.tabId);
  if(!target)return;
  if(method==='Page.screencastFrame'){
    const ack=()=>command(source.tabId,'Page.screencastFrameAck',{sessionId:params.sessionId}).catch(()=>{});
    if(!target.streaming||target.frameBusy||Date.now()-(target.lastFrame||0)<1000/(target.videoFPS||30)){void ack();return;}
    target.frameBusy=true;target.lastFrame=Date.now();
    void offscreen({type:'frame',tabId:source.tabId,data:params.data}).catch(()=>{}).finally(()=>{target.frameBusy=false;void ack();});
  }
  target.resources?.event(method,params);
  if(method==='DOM.shadowRootPushed'&&params.root.shadowRootType==='closed')void shadows(source.tabId).catch(()=>{});
  if(method==='Page.javascriptDialogOpening'){target.dialog={id:crypto.randomUUID(),kind:params.type,message:params.message.slice(0,8192),default:(params.defaultPrompt||'').slice(0,8192)};for(const id of target.sessions)publish({type:'dialog',sessionId:id,dialog:target.dialog});}
  if(method==='Page.javascriptDialogClosed'){target.dialog=null;for(const id of target.sessions)publish({type:'dialog',sessionId:id,dialog:null});}
  if (target && method === 'Page.frameNavigated' && !params.frame.parentId) {
    target.resources?.dispose();target.contextId = null; target.pending = null; target.nextSend = 0;
  }
});
function detached(tabId, reason) {
  const target = targets.get(tabId);
  if (!target) return;
  target.inputs?.clear();clearInterval(target.timer);
  clearInterval(target.rasterTimer);clearInterval(target.videoTimer);
  target.resources?.dispose();nativeTabs.delete(tabId);void offscreen({type:'stop-video',tabId}).catch(()=>{});targets.delete(tabId);
  for (const id of target.sessions) {
    const binding=bindings.get(id);
    if(reason==='target_closed'&&binding?.popups.length){const parentId=binding.popups.pop();schedule(async()=>{try{const tab=await chrome.tabs.get(parentId);await switchTab(id,tab,binding);}catch{bindings.delete(id);status(id,'closed','弹出页的来源标签页已关闭');}});continue;}
    bindings.delete(id);
    status(id, 'closed', reason === 'target_closed' ? '原标签页已关闭；网址共享可以点击重新连接来打开新标签页' : '浏览器已停止调试；可关闭分享页面以结束访问');
  }
}
chrome.debugger.onDetach.addListener((source, reason) => detached(source.tabId, reason));
chrome.tabs.onRemoved.addListener(tabId => {detached(tabId,'target_closed');for(const [id,binding] of bindings)if(binding.rootTabId===tabId&&binding.tabId!==tabId)schedule(async()=>{await pause(id);status(id,'closed','原共享标签页已关闭');});});
chrome.tabs.onCreated.addListener(tab=>{if(!tab.openerTabId)return;for(const [id,binding] of bindings)if(binding.tabId===tab.openerTabId&&binding.popups.length<4)schedule(async()=>{if(bindings.get(id)!==binding)return;try{status(id,'connecting','正在连接共享网页打开的弹出页');const fresh=await chrome.tabs.get(tab.id);await switchTab(id,fresh,{...binding,popups:[...binding.popups,binding.tabId]});}catch(error){status(id,'error',error.message);}});});
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  const target = targets.get(tabId);
  if (target && (changes.url || changes.title)) for (const id of target.sessions) status(id, 'connected', '', tab);
});

async function api(path, options = {}) {
  await loadConfig();
  if (!config.server || !config.pairingToken || !config.enabled) throw new Error('请先配置服务器，并开启共享连接');
  const response = await fetch(serverOrigin(config.server) + path, {...options, headers: {'Authorization': `Bearer ${config.pairingToken}`, 'Content-Type': 'application/json'}});
  if (!response.ok) throw new Error(`服务器返回 ${response.status}，请检查配对令牌和网络`);
  return response.status === 204 ? null : response.json();
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if(message.target==='offscreen')return false;
  if(message.target==='worker'){
    if(message.type==='signal'){const p=peers.get(message.sessionId+':'+message.viewerId);if(p){if(message.signal?.description?.type==='offer')p.attempt=message.signal.attempt;transmit(message);}}
    if(message.type==='peer-state')schedule(()=>peerState(message));
    if(message.type==='peer-input')peerInput(message);
    if(message.type==='video-budget'){
      const t=targets.get(message.tabId),fps=message.fps===2?2:30;
      if(t&&t.videoFPS!==fps){t.videoFPS=fps;t.nextVideo=0;t.nextSend=0;
        if(t.streaming&&!nativeTabs.has(message.tabId))void command(message.tabId,'Page.startScreencast',{format:'jpeg',quality:80,maxWidth:3840,maxHeight:2160,everyNthFrame:Math.round(30/fps)}).catch(()=>{});
      }
    }
    if(message.type==='native-ended'){nativeTabs.delete(message.tabId);const t=targets.get(message.tabId);if(t){t.streaming=false;t.nextRaster=0;}}
    respond(true);return false;
  }
  let capturedNow=false;
  const run = async () => {
    if (message.type === 'share') {
      if(message.kind==='tab'&&chrome.tabCapture&&!nativeTabs.has(message.tabId)){try{
        const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:message.tabId});
        if(await offscreen({type:'capture-native',tabId:message.tabId,streamId})){nativeTabs.add(message.tabId);capturedNow=true;const t=targets.get(message.tabId);if(t){if(t.streaming)await command(message.tabId,'Page.stopScreencast').catch(()=>{});t.streaming=false;t.nextRaster=0;}}
      }catch{/* Automated/reopened tabs use the continuous CDP video source. */}}
      await connect();
      const epoch = await boot;
      const body = {agentId: config.agentId, kind: message.kind, url: targetURL(message.url), title: message.title || ''};
      if (message.kind === 'tab') { body.tabId = message.tabId; body.tabEpoch = epoch; }
      const result = await api('/api/sessions', {method: 'POST', body: JSON.stringify(body)});
      const shares = (await chrome.storage.local.get('shares')).shares || {};
      shares[result.session.id] = {id: result.session.id, title: result.session.title || result.session.url, shareUrl: result.shareUrl, kind: result.session.kind,tabId:result.session.tabId};
      await chrome.storage.local.set({shares});
      return result;
    }
    if (message.type === 'revoke') {
      await api('/api/sessions/' + encodeURIComponent(message.id), {method: 'DELETE'});
      await pause(message.id);
      const {shares = {}, sessionTabs = {}} = await chrome.storage.local.get(['shares', 'sessionTabs']);
      const nativeTab=shares[message.id]?.tabId;
      delete shares[message.id]; delete sessionTabs[message.id];
      if(nativeTab&&nativeTabs.has(nativeTab)&&!targets.has(nativeTab)&&!Object.values(shares).some(s=>s.tabId===nativeTab)){nativeTabs.delete(nativeTab);await offscreen({type:'stop-video',tabId:nativeTab}).catch(()=>{});}
      await writeModes(modes=>{delete modes[message.id];});
      await chrome.storage.local.set({shares, sessionTabs});
      return {ok: true};
    }
    if (message.type === 'reconnect') {
      if (socket) { const old = socket; socket = null; old.close(); }
      peers.clear();nativeTabs.clear();await offscreen({type:'stop'}).catch(()=>{});await pauseAll(); await connect(); return {ok: true};
    }
    throw new Error('未知操作');
  };
  run().then(value => respond({ok: true, value}), async error => {if(capturedNow&&!targets.has(message.tabId)){nativeTabs.delete(message.tabId);await offscreen({type:'stop-video',tabId:message.tabId}).catch(()=>{});}respond({ok:false,error:error.message});});
  return true;
});
chrome.alarms.create('connect', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(() => void connect().catch(() => {}));
chrome.runtime.onStartup.addListener(() => void connect().catch(() => {}));
void connect().catch(() => {});
