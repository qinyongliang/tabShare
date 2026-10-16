import {DownloadAcks} from './download-flow.js';
import {GeolocationBroker,geolocationHook} from './geolocation.js';
import {InputQueue} from './input-queue.js';
import {DocumentState} from './document-state.js';
import {serverOrigin, targetURL, resolveTab, cdpInput, rasterFrame, validPeerInput} from './controller.js';
import {installDOM, captureDOM} from './dom-capture.js';
import {ResourceBridge} from './resources.js';
import {compressPacket} from './peer.js';

let config, socket, connecting, retryTimer;
function downloadClickHook(){const key=Symbol.for('tabshare.downloadHook');if(globalThis[key])return;const original=HTMLAnchorElement.prototype.click;function click(...args){if(this.hasAttribute('download')&&this.href.startsWith('blob:')&&!document.dispatchEvent(new CustomEvent('tabshare-download',{cancelable:true,detail:JSON.stringify({url:this.href,suggestedFilename:this.download})})))return;return original.apply(this,args);}globalThis[key]={original,click};HTMLAnchorElement.prototype.click=click;}
const bindings = new Map();
const targets = new Map();
const opening = new Map();
const peers = new Map(), nativeTabs = new Set();
let offscreenOpening,offscreenReady=false;
async function offscreen(message) {
  if(!chrome.offscreen)return false;
  if(!offscreenReady&&!offscreenOpening)offscreenOpening=(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
    if(!contexts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WEB_RTC','USER_MEDIA','CLIPBOARD'],justification:'Shared-tab WebRTC video and authenticated peer data channels'});
    offscreenReady=true;
  })().finally(()=>{offscreenOpening=null;});
  await offscreenOpening;
  try{return await chrome.runtime.sendMessage({target:'offscreen',...message});}catch(error){offscreenReady=false;throw error;}
}
function roomPeers(id){return [...peers.values()].filter(p=>p.sessionId===id);}
function publish(message) {
  const members=roomPeers(message.sessionId).filter(p=>!message.viewerId||p.viewerId===message.viewerId);
  if(members.some(p=>p.direct))void offscreen({type:'send',sessionId:message.sessionId,viewerId:message.viewerId,message}).catch(()=>{});
  if(members.some(p=>!p.direct)||!members.length)return transmit(message);
  return true;
}
function relayNeeded(id){const members=roomPeers(id);return !members.length||members.some(p=>!p.direct);}
function releaseRelayMarks(id){if(relayNeeded(id))return;const b=bindings.get(id),t=b&&targets.get(b.tabId);for(const item of t?.resources?.done.values()||[])item.sent?.delete(id);}
function resourceConfig(){return {server:serverOrigin(config.server),pairingToken:config.pairingToken,relayNeeded,deliver:async(id,asset,item)=>{
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
  const ownerBinding=bindings.get(m.sessionId);targets.get(ownerBinding?.tabId)?.geo?.leave(m);targets.get(ownerBinding?.tabId)?.downloadAcks?.leave(m);
  peers.delete(m.sessionId+':'+m.viewerId);
  await offscreen({...m,type:'peer-left'}).catch(()=>{});
  releaseRelayMarks(m.sessionId);
  const b=bindings.get(m.sessionId),t=b&&targets.get(b.tabId);
  for(const item of t?.resources?.done.values()||[])item.sent?.delete(m.sessionId+':'+m.viewerId);
  if(t?.viewport?.owner===m.viewerId)await resizeViewport(b.tabId,null);
}
async function peerState(m) {
  const p=peers.get(m.sessionId+':'+m.viewerId);if(!p||m.attempt&&p.attempt&&m.attempt!==p.attempt)return;
  if(m.status==='down')setTimeout(()=>{if(peers.get(m.sessionId+':'+m.viewerId)===p&&!p.direct)transmit({type:'peer-retry',sessionId:m.sessionId,viewerId:m.viewerId});},5000);
  p.direct=m.status==='up';transmit({type:'transport',sessionId:m.sessionId,viewerId:m.viewerId,status:p.direct?'p2p':'fallback'});
  releaseRelayMarks(m.sessionId);
  const b=bindings.get(m.sessionId),t=b&&targets.get(b.tabId);if(!t)return;
  await peerSnapshot(m.sessionId,m.viewerId);
  if(p.direct)await offscreen({type:'send',sessionId:m.sessionId,viewerId:m.viewerId,message:{type:'mode',mode:t.mode,full:!!t.full}});
  publish({type:'viewport',sessionId:m.sessionId,viewport:t.viewport});
  publish({type:'dialog',sessionId:m.sessionId,dialog:t.dialog||null});
  const requests=[...t.resources?.done||[]].filter(([,item])=>item.bytes).map(([id])=>({id}));void t.resources?.transfer(requests,t.sessions,resourceConfig());
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
// Wake on real page changes. An earlier deadline is never postponed by a stream
// of events, and interactive changes still pay the same sustained byte budget.
function requestSnapshot(tabId,urgent=false){
  const t=targets.get(tabId);if(!t)return;
  t.wakePending=true;t.wakeUrgent||=urgent;
  if(t.capturing||t.syncing)return;
  const now=Date.now(),due=Math.max(now+4,(t.lastSent||0)+(t.wakeUrgent?16:200),t.byteDelayUntil||0);
  if(t.wakeTimer&&t.wakeAt<=due)return;
  clearTimeout(t.wakeTimer);t.wakeAt=due;t.nextSend=Math.min(t.nextSend||due,due);
  t.wakeTimer=setTimeout(()=>{t.wakeTimer=null;void snapshot(tabId);},Math.max(0,due-now));
}
function enqueueInput(message){
  const binding=bindings.get(message.sessionId),target=binding&&targets.get(binding.tabId);if(!target)return;
  const member=peers.has(message.sessionId+':'+message.input.viewerId);
  if(message.input.action==='downloadAck'||message.input.action==='geolocationResult')return control(message);
  const run=async()=>{if(bindings.get(message.sessionId)!==binding||member&&!peers.has(message.sessionId+':'+message.input.viewerId))return;try{const result=await control(message);if(['mouseMoved','mouseLeave','mouseReleased','text','keyDown','scroll','select'].includes(message.input.action)){target.needsFrame=true;target.nextVideo=0;requestSnapshot(binding.tabId,true);}return result;}catch(error){if(contextChanged(error)){target.pending=null;target.nextSend=0;return;}if(bindings.get(message.sessionId)===binding)publish({type:'notice',sessionId:message.sessionId,detail:error.message});}};
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
  }finally{t.syncing=false;if(t.wakePending)requestSnapshot(b.tabId,t.wakeUrgent);}
}
async function backgroundVideo(tabId) {
  const t=targets.get(tabId);if(!t?.streaming||nativeTabs.has(tabId)||t.frameBusy||Date.now()<(t.nextVideo||0)||!t.needsFrame&&Date.now()-(t.lastFrame||0)<100)return;
  t.frameBusy=true;t.needsFrame=false;
  try{
    const {data}=await command(tabId,'Page.captureScreenshot',{format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:false});
    const changed=data!==t.lastShot;t.videoIdleDelay=changed?1000/(t.videoFPS||30):Math.min(t.videoFPS===2?1000:250,(t.videoIdleDelay||33)*1.5);t.lastShot=data;
    if(changed&&t.streaming)await offscreen({type:'frame',tabId,data});t.nextVideo=Date.now()+t.videoIdleDelay;
  }catch{/* An inactive/new tab can temporarily have no compositor surface. */}finally{t.frameBusy=false;}
}
function configureScreencast(tabId){
  const t=targets.get(tabId);if(!t)return Promise.resolve();
  const configure=async()=>{
    if(targets.get(tabId)!==t||nativeTabs.has(tabId))return;
    await command(tabId,'Page.stopScreencast');
    if(t.streaming)await command(tabId,'Page.startScreencast',{format:'jpeg',quality:80,maxWidth:3840,maxHeight:2160,everyNthFrame:Math.max(1,Math.round(30/(t.videoFPS||30)))});
  };
  return t.screencastTask=(t.screencastTask||Promise.resolve()).then(configure,configure);
}
async function videoState(tabId,active) {
  const t=targets.get(tabId);if(!t||t.streaming===active)return;
  t.streaming=active;
  if(nativeTabs.has(tabId)){await offscreen({type:'active-video',tabId,active});return;}
  if(active)try{
    await configureScreencast(tabId);
    // A newly opened background tab may not have produced its first compositor frame yet.
    if(!t.frameBusy){t.frameBusy=true;try{const seed=await command(tabId,'Page.captureScreenshot',{format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:false});if(t.streaming){t.lastShot=seed.data;await offscreen({type:'frame',tabId,data:seed.data});}}finally{t.frameBusy=false;}}
  }catch{t.streaming=false;}
  else {await configureScreencast(tabId).catch(()=>{});await offscreen({type:'stop-video',tabId}).catch(()=>{});}
}
let clipboardJobs=Promise.resolve();
let operationChain = Promise.resolve();
function schedule(task) { operationChain = operationChain.then(task).catch(error => {if(!contextChanged(error))console.warn('TabShare operation failed:',error.message);}); }
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
function downloadActor(tabId){const t=targets.get(tabId),a=t?.lastActor;return a&&Date.now()-a.time<15000&&bindings.get(a.sessionId)?.tabId===tabId?a:null;}
async function downloadChunk(tabId,actor,meta,bytes){
  const target=targets.get(tabId);
  if(!target||bindings.get(actor.sessionId)?.tabId!==tabId)throw Error('下载来源页面已关闭');
  const acks=target.downloadAcks??=new DownloadAcks();
  meta={kind:'download-chunk',...meta,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')};
  const acknowledged=acks.wait(meta.id,meta.offset+bytes.length,actor);
  try{
    let raw='';for(let i=0;i<bytes.length;i+=4096)raw+=String.fromCharCode(...bytes.subarray(i,i+4096));const data=btoa(raw),peer=peers.get(actor.sessionId+':'+actor.viewerId);
    if(actor.direct){
      if(!peer?.direct||!await offscreen({type:'download-chunk',sessionId:actor.sessionId,viewerId:actor.viewerId,meta,data}))throw Error('P2P 下载连接已中断，请重新下载');
    }else{
      const end=Date.now()+10000;while(socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount>262144&&Date.now()<end)await new Promise(r=>setTimeout(r,25));
      if(!transmit({type:'download',sessionId:actor.sessionId,viewerId:actor.viewerId,download:{...meta,data}}))throw Error('下载连接已中断');
    }
    await acknowledged;
  }catch(error){acks.cancel(meta.id,error.message);throw error;}
}
async function downloadResponse(tabId,p){
  const headers=Object.fromEntries((p.responseHeaders||[]).map(h=>[h.name.toLowerCase(),h.value])),t=targets.get(tabId),actor=t?.downloadActors?.get(p.networkId)||downloadActor(tabId);
  const hint=actor?.hint||t?.downloadHint,matched=hint&&(actor?.hint||Date.now()-hint.time<10000)&&hint.url===p.request.url;
  if(!actor||p.responseStatusCode<200||p.responseStatusCode>=300||!(/\battachment\b/i.test(headers['content-disposition']||'')||matched)){await command(tabId,'Fetch.continueRequest',{requestId:p.requestId}).catch(()=>{});return;}
  const recipient={...actor,direct:!!peers.get(actor.sessionId+':'+actor.viewerId)?.direct};
  const id=crypto.randomUUID(),disposition=headers['content-disposition']||'';let name=/filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if(name)try{name=decodeURIComponent(name);}catch{}name=name||/filename="([^"]+)"/i.exec(disposition)?.[1]||/filename=([^;]+)/i.exec(disposition)?.[1]||hint?.name||new URL(p.request.url).pathname.split('/').pop()||'download';
  const meta={id,name:name.slice(0,120),mime:(headers['content-type']||'application/octet-stream').split(';')[0].slice(0,100)};
  let stream,offset=0,reserved=false;
  try{
    if((t.downloadCount||0)>=2)throw Error('最多同时转发两个文件');t.downloadCount=(t.downloadCount||0)+1;reserved=true;
    await downloadChunk(tabId,recipient,{...meta,offset:0,done:false},new Uint8Array());
    ({stream}=await command(tabId,'Fetch.takeResponseBodyAsStream',{requestId:p.requestId}));
    for(;;){const chunk=await command(tabId,'IO.read',{handle:stream,size:262144}),bytes=chunk.base64Encoded?Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0)):new TextEncoder().encode(chunk.data);if(!Number.isSafeInteger(offset+bytes.length))throw Error('下载偏移超出协议范围');await downloadChunk(tabId,recipient,{...meta,offset,done:!!chunk.eof},bytes);offset+=bytes.length;if(chunk.eof)break;}
  }catch(error){transmit({type:'download',sessionId:actor.sessionId,viewerId:actor.viewerId,download:{id,offset:0,error:error.message.slice(0,500)}});}
  finally{if(reserved)t.downloadCount--;if(stream){await command(tabId,'IO.close',{handle:stream}).catch(()=>{});await command(tabId,'Fetch.failRequest',{requestId:p.requestId,errorReason:'Aborted'}).catch(()=>{});}else await command(tabId,'Fetch.failRequest',{requestId:p.requestId,errorReason:'Aborted'}).catch(()=>{});}
}
async function downloadBlob(tabId,p){
  const actor=downloadActor(tabId),t=targets.get(tabId);if(!actor||!p.url.startsWith('blob:'))return;
  if(t.lastBlob?.url===p.url&&t.lastBlob?.actorTime===actor.time)return;t.lastBlob={url:p.url,actorTime:actor.time};
  const recipient={...actor,direct:!!peers.get(actor.sessionId+':'+actor.viewerId)?.direct},id=crypto.randomUUID();let reserved=false;
  try{if((t.downloadCount||0)>=2)throw Error('同时下载数量超过上限');t.downloadCount=(t.downloadCount||0)+1;reserved=true;await world(tabId);
    await downloadChunk(tabId,recipient,{id,name:String(p.suggestedFilename||'download').slice(0,120),mime:'application/octet-stream',offset:0,done:false},new Uint8Array());
    for(let offset=0;;){const part=await evaluate(tabId,'globalThis.__tabShareDOM.downloadPart('+JSON.stringify(p.url)+','+offset+')'),bytes=Uint8Array.from(atob(part.data),c=>c.charCodeAt(0));if(offset===0&&p.guid)await command(tabId,'Browser.cancelDownload',{guid:p.guid}).catch(()=>{});await downloadChunk(tabId,recipient,{id,name:String(p.suggestedFilename||'download').slice(0,120),mime:part.mime||'application/octet-stream',offset,done:part.done===true},bytes);offset+=bytes.length;if(part.done)break;}
  }catch(error){transmit({type:'download',sessionId:actor.sessionId,viewerId:actor.viewerId,download:{id,offset:0,error:error.message.slice(0,500)}});}
  finally{if(reserved)t.downloadCount--;await evaluate(tabId,'globalThis.__tabShareDOM.downloadDone('+JSON.stringify(p.url)+')').catch(()=>{});}
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
        if(message.type==='clipboard')void enqueueInput({sessionId:message.sessionId,input:{...message.image,action:'pasteImage'}});
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
function contextChanged(error){return /Cannot find context|Execution context was destroyed|Inspected target navigated|Session with given id not found|No session with given id|No frame with given id|Frame with the given id|共享页面正在切换/i.test(error?.message||'');}
async function command(tabId, method, params = {}) { return chrome.debugger.sendCommand({tabId}, method, params); }
async function world(tabId) {
  const target = targets.get(tabId);
  if(!target)throw new Error('共享标签页已关闭');
  if(target.worldTask)return target.worldTask;
  if (target.contextId) return target.contextId;
  const epoch=target.contextEpoch||0;
  const valid=()=>{if(targets.get(tabId)!==target||(target.contextEpoch||0)!==epoch)throw new Error('共享页面正在切换，请稍后重试');};
  const task=(async()=>{
  const tree = await command(tabId, 'Page.getFrameTree');
  const result = await command(tabId, 'Page.createIsolatedWorld', {frameId: tree.frameTree.frame.id, worldName: 'TabShareDOM'});
  valid();
  target.contextId = result.executionContextId;
  const contextId=target.contextId;
  try{await command(tabId,'Runtime.addBinding',{name:'__tabShareWake',executionContextId:contextId});target.wakeEnabled=true;}catch{target.wakeEnabled=false;}
  await evaluate(tabId, installDOM,contextId);
  target.frameId=tree.frameTree.frame.id;await installGeolocation(tabId,target);
  await command(tabId,'Runtime.evaluate',{expression:'('+downloadClickHook.toString()+')()',returnByValue:true}).catch(()=>{});
  await evaluate(tabId, 'globalThis.__tabShareDOM.reset()',contextId);
  if(target.nativeViewport)await evaluate(tabId,'globalThis.__tabShareDOM.ownerViewport('+JSON.stringify(target.nativeViewport)+')',contextId);
  await evaluate(tabId, 'globalThis.__tabShareDOM.setMode('+JSON.stringify(target.mode||'dom')+')',contextId);
  valid();
  target.resources?.dispose();
  target.resources=new ResourceBridge((method,params)=>command(tabId,method,params),expression=>evaluate(tabId,expression,contextId));
  await target.resources.scan().catch(()=>{});
  await shadows(tabId).catch(()=>{});
  valid();return contextId;
  })().catch(error=>{if((target.contextEpoch||0)===epoch){target.contextId=null;target.resources?.dispose();target.resources=null;}throw error;}).finally(()=>{if(target.worldTask===task)target.worldTask=null;});
  target.worldTask=task;return task;
}
function invalidateWorld(target){target.downloadAcks?.dispose();target.geo?.dispose();target.geo=null;clearTimeout(target.wakeTimer);target.wakeTimer=null;target.wakePending=false;target.wakeUrgent=false;target.wakeEnabled=false;target.contextEpoch=(target.contextEpoch||0)+1;target.contextId=null;target.resources?.dispose();target.resources=null;target.captureLimited=false;target.navigation=null;target.historyURL=null;target.documentReady=false;}
async function installGeolocation(tabId,target){
  if(target.geo)return;
  const main=[...target.contexts?.values()||[]].find(c=>c.auxData?.isDefault&&c.auxData.frameId===target.frameId);
  if(!main||!/^https?:\/\//.test(main.origin))return;
  const contextId=main.id,generation=target.contextEpoch||0;
  const existing=await command(tabId,'Runtime.evaluate',{contextId,expression:'globalThis.__tabShareGeolocation&&!globalThis.__tabShareGeolocation.disposed?globalThis.__tabShareGeolocation.epoch:null',returnByValue:true});
  const oldEpoch=existing.result?.value,epoch=typeof oldEpoch==='string'&&/^[-A-Za-z0-9_]{8,80}$/.test(oldEpoch)?oldEpoch:crypto.randomUUID();
  const broker=new GeolocationBroker({epoch,origin:new URL(main.origin).origin,
    send:(owner,request)=>publish({type:'geolocation',sessionId:owner.sessionId,viewerId:owner.viewerId,data:JSON.stringify(request)}),
    deliver:result=>{void command(tabId,'Runtime.evaluate',{contextId,expression:'globalThis.__tabShareGeolocation?.resolve('+JSON.stringify(result)+')',returnByValue:true}).catch(()=>{});}
  });
  await command(tabId,'Runtime.addBinding',{name:'__tabShareGeolocationRequest',executionContextId:contextId});
  if((target.contextEpoch||0)!==generation||targets.get(tabId)!==target){broker.dispose();throw Error('共享页面正在切换');}
  target.geo=broker;target.geoMainContext=contextId;
  try{
    const expression=oldEpoch===epoch?'globalThis.__tabShareGeolocation.attach()':'('+geolocationHook.toString()+')('+JSON.stringify(epoch)+',"__tabShareGeolocationRequest")';
    await command(tabId,'Runtime.evaluate',{contextId,expression,returnByValue:true});
    if((target.contextEpoch||0)!==generation){broker.dispose();if(target.geo===broker)target.geo=null;throw Error('共享页面正在切换');}
  }catch(error){broker.dispose();if(target.geo===broker)target.geo=null;throw error;}
}
function geolocationOwner(tabId,target){
  const actor=target.lastActor;
  if(actor&&Date.now()-actor.time<15000&&peers.has(actor.sessionId+':'+actor.viewerId)&&bindings.get(actor.sessionId)?.tabId===tabId)return actor;
  const members=[...target.sessions].flatMap(sessionId=>roomPeers(sessionId).map(p=>({sessionId,viewerId:p.viewerId})));
  return members.length===1?members[0]:null;
}
async function evaluate(tabId, expression,expectedContext) {
  const target = targets.get(tabId);
  const contextId=expectedContext??target?.contextId;
  if(!Number.isInteger(contextId)||contextId<=0||target?.contextId!==contextId)throw new Error('共享页面正在切换，请稍后重试');
  let result;try{result=await command(tabId, 'Runtime.evaluate', {expression, contextId, returnByValue: true, awaitPromise:true, userGesture: true, timeout:2000});}catch(error){if(contextChanged(error)&&target.contextId===contextId){invalidateWorld(target);target.pending=null;target.nextSend=0;}throw error;}
  if(targets.get(tabId)!==target||target.contextId!==contextId)throw new Error('共享页面正在切换，请稍后重试');
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
  clearTimeout(target.wakeTimer);target.wakeTimer=null;target.wakePending=false;target.wakeUrgent=false;target.lastPoll=Date.now();
  target.capturing = true;
  let contextId,capturingDOM=false;
  try {
    contextId=await world(tabId);capturingDOM=true;
    const delta = target.pending || await evaluate(tabId, captureDOM,contextId);
    capturingDOM=false;
    if (!delta) return;
    if(delta.meta?.url){
      if(target.historyDirty||target.historyURL!==delta.meta.url||!target.navigation){
        const history=await command(tabId,'Page.getNavigationHistory'),entry=history.entries?.[history.currentIndex];
        if(contextId!==target.contextId)return;
        target.navigation=entry?{entryId:entry.id,entries:history.entries.slice(Math.max(0,history.currentIndex-1000),history.currentIndex+1001).map(e=>e.id)}:null;target.historyURL=entry?.url||delta.meta.url;
        if(entry?.url)delta.meta.url=entry.url;target.historyDirty=false;
      }
      delta.meta.navigation=target.navigation;
    }
    target.captureLimited=!!delta.meta?.truncated;
    if(delta.meta?.mode!==target.mode)await rememberMode(target,delta.meta.mode);
    const requests=delta.resources;delete delta.resources;const downloads=delta.downloads;delete delta.downloads;if(downloads?.length)for(const request of downloads)void downloadBlob(tabId,request);
    if(!target.pending){target.document.apply(delta);target.documentReady=true;}
    if(requests?.length)void target.resources.transfer(requests,target.sessions,resourceConfig());
    const json=new TextEncoder().encode(JSON.stringify({type:'dom',document:delta})),raw=new Uint8Array(json.length+1);raw[0]=1;raw.set(json,1);
    const packed=await compressPacket(raw);
    let encoded;
    if(typeof btoa==='function'){let binary='';for(let i=0;i<packed.length;i+=4096)binary+=String.fromCharCode(...packed.subarray(i,i+4096));encoded=btoa(binary);}
    let sent = true;
    for(const id of target.sessions){
      if(!encoded){sent=publish({type:'dom',sessionId:id,document:delta})&&sent;continue;}
      const members=roomPeers(id);if(members.some(p=>p.direct))void offscreen({type:'send-packet',sessionId:id,data:encoded}).catch(()=>{});
      if(!members.length||members.some(p=>!p.direct))sent=transmit({type:'dom',sessionId:id,document:delta})&&sent;
    }
    if (!sent) { target.pending = delta; return; }
    target.pending = null;
    const wasBuilding=delta.reset||target.building;
    const building=wasBuilding&&delta.meta?.pending;target.building=building;
    // Coalesce mutations while paying down a byte budget. Initial state is sent only once.
    const bytes=packed.length,now=Date.now();
    target.byteCredit=Math.min(32768,(target.byteCredit??32768)+(now-(target.budgetAt||now))*131072/1000)-bytes;
    target.budgetAt=target.lastSent=now;target.byteDelayUntil=now+Math.max(0,-target.byteCredit)/131072*1000;
    target.nextSend=Math.max(now+16,target.byteDelayUntil);
    if(delta.meta?.pending){clearTimeout(target.progressTimer);target.progressTimer=setTimeout(()=>void snapshot(tabId),Math.max(16,target.nextSend-Date.now()+1));}
  } catch (error) {
    if(contextChanged(error)){if(target.contextId===contextId)invalidateWorld(target);target.pending=null;target.nextSend=0;return;}
    if(capturingDOM&&contextId===target.contextId&&/Execution was terminated|timed out/i.test(error.message)){
      try{await evaluate(tabId,'globalThis.__tabShareDOM.limit()',contextId);target.captureLimited=true;target.pending=null;target.nextSend=0;return;}catch{}
    }
    if(contextId===target.contextId)invalidateWorld(target);
    if (targets.has(tabId)) for (const id of target.sessions) status(id,'error',error.message);
  } finally { target.capturing = false;if(targets.get(tabId)===target&&target.wakePending)requestSnapshot(tabId,target.wakeUrgent); }
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
    if(info.regions.length){
      // Clipped Page.captureScreenshot calls can leave stale surfaces in background tabs.
      // Capture once locally, then crop before any image bytes leave the browser.
      const shot=await rasterFrame(params=>command(tabId,'Page.captureScreenshot',params),{format:'jpeg',fromSurface:true,captureBeyondViewport:false});
      const images=await evaluate(tabId,'globalThis.__tabShareDOM.cropFrame('+JSON.stringify(shot.data)+','+JSON.stringify(info)+')');
      for(const image of images){const region=info.regions.find(r=>r.id===image.id);if(!region)continue;bytes+=image.data.length;
        for(const id of target.sessions)transmit({type:'raster',sessionId:id,nodeId:region.id,full:false,data:image.data,width:region.width,height:region.height,region:{offsetX:region.offsetX,offsetY:region.offsetY,styleWidth:region.styleWidth,styleHeight:region.styleHeight,cuts:region.cuts}});
      }
    }
    // Only disconnected WebRTC peers use this bounded emergency screenshot transport.
    target.nextRaster=Date.now()+Math.max(500,bytes/65536*1000);
  }catch{/* Navigation can temporarily destroy the isolated world. */}finally{target.rasterBusy=false;}
}
async function resizeViewport(tabId,viewport) {
  const target=targets.get(tabId);if(!target)return;
  if(viewport&&!target.nativeViewport){const metrics=await command(tabId,'Page.getLayoutMetrics');const native=metrics.cssLayoutViewport||metrics.layoutViewport;target.nativeViewport={width:native.clientWidth,height:native.clientHeight};}
  if(viewport)await command(tabId,'Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:viewport.deviceScaleFactor,mobile:false,screenWidth:viewport.width,screenHeight:viewport.height,screenOrientation:{type:viewport.width>viewport.height?'landscapePrimary':'portraitPrimary',angle:viewport.width>viewport.height?90:0}});
  else if(target.viewport)await command(tabId,'Emulation.clearDeviceMetricsOverride');
  target.viewport=viewport;
  for(const id of target.sessions)transmit({type:'viewport',sessionId:id,viewport});
  await world(tabId);if(target.nativeViewport)await evaluate(tabId,'globalThis.__tabShareDOM.ownerViewport('+JSON.stringify(target.nativeViewport)+')');await evaluate(tabId,'globalThis.__tabShareDOM.invalidate()');
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
  target={sessions:new Set(),contextId:null,capturing:false,nextSend:0,nextRaster:0,full:null,mode:'dom',document:new DocumentState()};targets.set(tab.id,target);
  try{await command(tab.id,'Emulation.setFocusEmulationEnabled',{enabled:true});await command(tab.id,'Runtime.enable');await command(tab.id,'Page.enable');await command(tab.id,'DOM.enable');await command(tab.id,'CSS.enable');await command(tab.id,'Network.enable',{maxTotalBufferSize:32*1024*1024,maxResourceBufferSize:8*1024*1024});await command(tab.id,'Fetch.enable',{patterns:[{resourceType:'Document',requestStage:'Response'}]});}
  catch(error){targets.delete(tab.id);await chrome.debugger.detach({tabId:tab.id}).catch(()=>{});throw error;}
  const geoScript=await command(tab.id,'Page.addScriptToEvaluateOnNewDocument',{source:'('+geolocationHook.toString()+')(crypto.randomUUID(),"__tabShareGeolocationRequest")'});target.geoScriptId=geoScript.identifier;
  target.timer=setInterval(()=>{if(!target.wakeEnabled||Date.now()-(target.lastPoll||0)>=1000)void snapshot(tab.id);},200);target.rasterTimer=setInterval(()=>void raster(tab.id),500);target.videoTimer=setInterval(()=>void backgroundVideo(tab.id),33);return target;
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
      const parent=bindings.get(session.parentId);bindings.set(session.id,{tabId:tab.id,rootTabId:parent?.rootTabId||tab.id,popups:[],depth:parent?(parent.depth||0)+1:0,session});
      if(roomPeers(session.id).length)await offscreen({type:'bind',sessionId:session.id,tabId:tab.id}).catch(()=>{});
      const sessionTabs = stored.sessionTabs || {};
      sessionTabs[session.id] = {tabId: tab.id, epoch};
      await chrome.storage.local.set({sessionTabs});
      status(session.id, 'connected', '', tab);
      if(alreadyRunning&&target.contextId){await evaluate(tab.id,'globalThis.__tabShareDOM.reset()');target.nextSend=0;const requests=[...target.resources.done].filter(([,item])=>item.bytes).map(([id])=>({id}));void target.resources.transfer(requests,target.sessions,resourceConfig());}
      await snapshot(tab.id);
    } catch (error) {if(!contextChanged(error))status(session.id,'error',error.message);}
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
  target.inputs?.clear();clearInterval(target.timer);clearTimeout(target.progressTimer);clearTimeout(target.wakeTimer);clearTimeout(target.styleRefresh);
  clearInterval(target.rasterTimer);clearInterval(target.videoTimer);
  await videoState(binding.tabId,false);nativeTabs.delete(binding.tabId);await offscreen({type:'stop-video',tabId:binding.tabId}).catch(()=>{});
  target.resources?.dispose();
  if(target.viewport)try{await command(binding.tabId,'Emulation.clearDeviceMetricsOverride');}catch{}
  if(target.contextId)try{await command(binding.tabId,'Runtime.evaluate',{expression:'globalThis.__tabShareDOM?.dispose()',contextId:target.contextId,returnByValue:true});}catch{}
  await command(binding.tabId,'Runtime.evaluate',{expression:"(()=>{const key=Symbol.for('tabshare.downloadHook'),hook=globalThis[key];if(hook){if(HTMLAnchorElement.prototype.click===hook.click)HTMLAnchorElement.prototype.click=hook.original;delete globalThis[key];}})()",returnByValue:true}).catch(()=>{});
  targets.delete(binding.tabId);
  target.downloadAcks?.dispose();target.geo?.dispose();
  if(target.geoScriptId)await command(binding.tabId,'Page.removeScriptToEvaluateOnNewDocument',{identifier:target.geoScriptId}).catch(()=>{});
  if(target.geoMainContext)await command(binding.tabId,'Runtime.evaluate',{contextId:target.geoMainContext,expression:'globalThis.__tabShareGeolocation?.dispose()',returnByValue:true}).catch(()=>{});
  await command(binding.tabId,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});
  try { await chrome.debugger.detach({tabId: binding.tabId}); } catch { /* Already closed/detached. */ }
}
async function pauseAll() { for (const id of [...bindings.keys()]) await pause(id); }
async function control(message) {
  const binding = bindings.get(message.sessionId);
  if (!binding) return;
  let input = message.input;
  const {action} = input;
  const target=targets.get(binding.tabId);
  if(action==='downloadAck'){try{target?.downloadAcks?.accept({sessionId:message.sessionId,viewerId:input.viewerId},JSON.parse(input.text));}catch{}return;}
  if(action==='geolocationResult'){try{target?.geo?.respond({sessionId:message.sessionId,viewerId:input.viewerId},JSON.parse(input.text));}catch{}return;}
  if(input.version&&(!target.documentReady||input.version!==target.document.version))return;
  if(input.viewerId&&['mousePressed','mouseReleased','keyDown','text'].includes(action))target.lastActor={sessionId:message.sessionId,viewerId:input.viewerId,time:Date.now()};
  if(action==='pasteImage'){const paste=async()=>{
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(input.mime)||typeof input.data!=='string'||input.data.length>Math.ceil(4*1024*1024/3)*4||!/^[-A-Za-z0-9+/=]+$/.test(input.data))return;
    await world(binding.tabId);
    const focus=await evaluate(binding.tabId,'globalThis.__tabShareDOM.act('+JSON.stringify({...input,action:'focus',data:undefined})+')');if(focus?.stale)return;
    let native=await offscreen({type:'clipboard-image',data:input.data,mime:input.mime});
    if(!native)native=await evaluate(binding.tabId,'globalThis.__tabShareDOM.writeClipboardImage('+JSON.stringify({data:input.data,mime:input.mime})+')');
    if(native){for(const action of ['keyDown','keyUp']){const [method,params]=cdpInput({action,key:'v',code:'KeyV',keyCode:86,modifiers:focus?.mac?4:2});await command(binding.tabId,method,params);}}
    if(!native){const result=await evaluate(binding.tabId,'globalThis.__tabShareDOM.act('+JSON.stringify(input)+')');if(!result?.accepted)publish({type:'notice',sessionId:message.sessionId,detail:'当前控件未接收图片；该网站可能要求原生剪贴板授权。'});}
    target.nextSend=0;await snapshot(binding.tabId);
  };const job=clipboardJobs.then(paste,paste);clipboardJobs=job.catch(()=>{});return job;
  }
  if(action==='viewport'){await resizeViewport(binding.tabId,{width:input.width,height:input.height,deviceScaleFactor:input.deviceScaleFactor,owner:input.viewerId});return;}
  if(action==='restoreViewport'||action==='viewportRelease'){if(action==='viewportRelease'&&target.viewport?.owner!==input.viewerId)return;await resizeViewport(binding.tabId,null);return;}
  if(action==='closePopup'){if(binding.session.parentId||binding.popups?.length)await chrome.tabs.remove(binding.tabId);return;}
  if(action==='dialog'){if(target?.dialog?.id!==input.dialogId)return;await command(binding.tabId,'Page.handleJavaScriptDialog',{accept:!!input.accept,promptText:input.text||''});return;}
  if(action==='mode'){if(input.mode!=='dom')return;await world(binding.tabId);await evaluate(binding.tabId,'globalThis.__tabShareDOM.setMode('+JSON.stringify(input.mode)+')');await rememberMode(target,input.mode);target.nextSend=0;await snapshot(binding.tabId);return;}
  if (input.nodeId) {
    await world(binding.tabId);
    const point = await evaluate(binding.tabId, 'globalThis.__tabShareDOM.act(' + JSON.stringify(input) + ')');
    if(point?.stale){target.nextSend=0;return;}
    if(point?.download)target.downloadHint={...point.download,time:Date.now()};
    if(action==='select'){if(point?.key){for(const key of [point,{key:'Enter',code:'Enter',keyCode:13}])for(const action of ['keyDown','keyUp']){const [method,params]=cdpInput({action,...key});await command(binding.tabId,method,params);}await evaluate(binding.tabId,'globalThis.__tabShareDOM.act('+JSON.stringify({...input,action:'selectFinish'})+')');}return;}
    if (action === 'scroll' || action === 'selection') return;
    input = {...input, ...point};
  }
  if (action === 'back' || action === 'forward' || action==='history') {
    const history = await command(binding.tabId, 'Page.getNavigationHistory');
    const entry = action==='history'?history.entries.find(e=>e.id===input.entryId):history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
    if (entry) await command(binding.tabId, 'Page.navigateToHistoryEntry', {entryId: entry.id});
  } else { const pointer=action.startsWith('mouse');if(pointer){await world(binding.tabId);await evaluate(binding.tabId,'globalThis.__tabShareDOM.ownerInput(true)');}try{const [method,params]=cdpInput(input);await command(binding.tabId,method,params);}finally{if(pointer)await evaluate(binding.tabId,'globalThis.__tabShareDOM.ownerInput(false)').catch(()=>{});} }
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  const target = targets.get(source.tabId);
  if(!target)return;
  if(method==='Runtime.executionContextCreated'){(target.contexts??=new Map()).set(params.context.id,params.context);return;}
  if(method==='Runtime.executionContextDestroyed')target.contexts?.delete(params.executionContextId);
  if(method==='Runtime.executionContextsCleared')target.contexts?.clear();
  if(method==='Runtime.bindingCalled'&&params.name==='__tabShareGeolocationRequest'){
    if(params.executionContextId!==target.geoMainContext||typeof params.payload!=='string'||params.payload.length>2048)return;
    try{target.geo?.request(JSON.parse(params.payload),geolocationOwner(source.tabId,target));}catch{}return;
  }
  if(method==='Runtime.bindingCalled'&&params.name==='__tabShareWake'){
    if(params.executionContextId!==target.contextId||typeof params.payload!=='string'||params.payload.length>200)return;
    try{const signal=JSON.parse(params.payload);if(signal.version===target.document.version||!target.documentReady)requestSnapshot(source.tabId,signal.urgent===true);}catch{}return;
  }
  if(method==='Network.requestWillBeSent'&&params.type==='Document'){const actor=downloadActor(source.tabId);if(actor){target.downloadActors||=new Map();if(!target.downloadActors.has(params.requestId)){if(target.downloadActors.size>=32)target.downloadActors.delete(target.downloadActors.keys().next().value);target.downloadActors.set(params.requestId,{...actor,hint:target.downloadHint?.url===params.request.url?target.downloadHint:null});}}}
  if(method==='Network.loadingFinished'||method==='Network.loadingFailed')target.downloadActors?.delete(params.requestId);
  if(method==='Fetch.requestPaused'){void downloadResponse(source.tabId,params);return;}
  if(method==='Page.downloadWillBegin'){void downloadBlob(source.tabId,params);return;}
  if(method==='Page.screencastFrame'){
    const ack=()=>command(source.tabId,'Page.screencastFrameAck',{sessionId:params.sessionId}).catch(()=>{});
    if(!target.streaming||target.frameBusy||Date.now()-(target.lastFrame||0)<1000/(target.videoFPS||30)){void ack();return;}
    target.frameBusy=true;target.lastFrame=Date.now();
    void offscreen({type:'frame',tabId:source.tabId,data:params.data}).catch(()=>{}).finally(()=>{target.frameBusy=false;void ack();});
  }
  if(method==='Runtime.executionContextsCleared'||method==='Runtime.executionContextDestroyed'&&params.executionContextId===target.contextId){invalidateWorld(target);target.pending=null;target.nextSend=0;return;}
  target.resources?.event(method,params);
  if(method==='CSS.styleSheetChanged'){clearTimeout(target.styleRefresh);target.styleRefresh=setTimeout(()=>void world(source.tabId).then(()=>evaluate(source.tabId,'globalThis.__tabShareDOM.invalidate()')).catch(()=>{}),100);}
  if(method==='Page.navigatedWithinDocument'){target.historyDirty=true;target.nextSend=0;void world(source.tabId).then(()=>evaluate(source.tabId,'globalThis.__tabShareDOM.invalidate()')).catch(()=>{});}
  if(method==='DOM.shadowRootPushed'&&params.root.shadowRootType==='closed')void shadows(source.tabId).catch(()=>{});
  if(method==='Page.javascriptDialogOpening'){target.dialog={id:crypto.randomUUID(),kind:params.type,message:params.message.slice(0,8192),default:(params.defaultPrompt||'').slice(0,8192)};for(const id of target.sessions)publish({type:'dialog',sessionId:id,dialog:target.dialog});}
  if(method==='Page.javascriptDialogClosed'){target.dialog=null;for(const id of target.sessions)publish({type:'dialog',sessionId:id,dialog:null});}
  if (target && method === 'Page.frameNavigated' && !params.frame.parentId) {
    invalidateWorld(target);target.historyDirty=true;target.pending = null; target.nextSend = 0;
  }
});
function detached(tabId, reason) {
  const target = targets.get(tabId);
  if (!target) return;
  target.downloadAcks?.dispose();target.geo?.dispose();
  target.inputs?.clear();clearInterval(target.timer);clearTimeout(target.progressTimer);clearTimeout(target.wakeTimer);clearTimeout(target.styleRefresh);
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
const popupTasks=new Map();
let popupWrites=Promise.resolve();
function popupRegistry(update){const run=async()=>{const {popupSessions={}}=await chrome.storage.local.get('popupSessions');await update(popupSessions);await chrome.storage.local.set({popupSessions});};const job=popupWrites.then(run,run);popupWrites=job.catch(()=>{});return job;}
function openedTab(parentTabId,tabId){
  for(const [id,binding] of bindings){
    if(binding.tabId!==parentTabId||(binding.depth||0)>=4)continue;
    const key=id+':'+tabId;if(popupTasks.has(key))continue;
    if([...popupTasks.keys()].filter(k=>k.startsWith(id+':')).length>=32){publish({type:'notice',sessionId:id,detail:'此共享页同时打开的新页面已达 32 个，请先关闭部分页面。'});continue;}
    const task=(async()=>{
      const tab=await chrome.tabs.get(tabId);if(bindings.get(id)!==binding)return;
      const epoch=await boot;
      const result=await api('/api/sessions',{method:'POST',body:JSON.stringify({agentId:config.agentId,parentId:id,kind:'tab',tabId,tabEpoch:epoch,url:/^https?:/.test(tab.url||'')?tab.url:binding.session.url,title:tab.title||'新页面'})});
      await popupRegistry(registry=>{registry[result.session.id]={tabId,parentId:id};});
      if(bindings.get(id)===binding)publish({type:'popup',sessionId:id,popup:{id:result.session.id,shareUrl:result.shareUrl,title:result.session.title}});
    })().catch(error=>{popupTasks.delete(key);if(bindings.get(id)===binding)publish({type:'notice',sessionId:id,detail:'新页面共享失败：'+error.message});});
    popupTasks.set(key,task);
  }
}
chrome.tabs.onCreated.addListener(tab=>{if(tab.openerTabId)openedTab(tab.openerTabId,tab.id);});
chrome.webNavigation?.onCreatedNavigationTarget.addListener(details=>openedTab(details.sourceTabId,details.tabId));
chrome.tabs.onRemoved.addListener(tabId=>{schedule(async()=>{await popupRegistry(async registry=>{for(const [id,popup] of Object.entries(registry))if(popup.tabId===tabId){await api('/api/sessions/'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{});delete registry[id];}});for(const key of popupTasks.keys())if(key.endsWith(':'+tabId))popupTasks.delete(key);});});

chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  const target = targets.get(tabId);
  if(target&&('url' in changes||'title' in changes)){for(const id of target.sessions)status(id,'connected','',tab);requestSnapshot(tabId,true);}
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
    if(message.type==='peer-clipboard'){const p=peers.get(message.sessionId+':'+message.viewerId),image=message.image;if(p&&p.attempt===message.attempt&&image&&Date.now()-(p.lastClipboard||0)>1000&&typeof image.nodeId==='string'&&image.nodeId.length<=32&&typeof image.version==='string'&&image.version.length<=80){p.lastClipboard=Date.now();void enqueueInput({sessionId:message.sessionId,input:{...image,action:'pasteImage',viewerId:message.viewerId}});}}
    if(message.type==='video-budget'){
      const t=targets.get(message.tabId),fps=message.fps===2?2:30;
      if(t&&t.videoFPS!==fps){void command(message.tabId,'Emulation.setFocusEmulationEnabled',{enabled:fps>2}).catch(()=>{});t.videoFPS=fps;t.nextVideo=0;t.nextSend=0;
        if(t.streaming&&!nativeTabs.has(message.tabId))void configureScreencast(message.tabId).catch(()=>{});
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
