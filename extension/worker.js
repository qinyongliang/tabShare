import {serverOrigin, targetURL, resolveTab, cdpInput} from './controller.js';
import {installDOM, captureDOM} from './dom-capture.js';

let config, socket, connecting, retryTimer;
const bindings = new Map();
const targets = new Map();
const opening = new Map();
let operationChain = Promise.resolve();
function schedule(task) { operationChain = operationChain.then(task).catch(() => {}); }
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
        if (message.type === 'input') {
          // Commands from all viewers execute in the same order on this browser.
          schedule(() => control(message).catch(error => status(message.sessionId, 'error', error.message)));
        }
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (!ready) reject(new Error('连接失败，请检查服务器地址和配对令牌'));
        if (socket !== ws) return;
        socket = null;
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
  return target.contextId;
}
async function evaluate(tabId, expression) {
  const target = targets.get(tabId);
  const result = await command(tabId, 'Runtime.evaluate', {expression, contextId: target.contextId, returnByValue: true, userGesture: true});
  if (result.exceptionDetails) throw new Error(result.result?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function snapshot(tabId) {
  const target = targets.get(tabId);
  if (!target || target.capturing || Date.now() < target.nextSend || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512000) return;
  target.capturing = true;
  try {
    await world(tabId);
    const delta = target.pending || await evaluate(tabId, captureDOM);
    if (!delta) return;
    let sent = true;
    for (const id of target.sessions) sent = transmit({type:'dom', sessionId:id, document:delta}) && sent;
    if (!sent) { target.pending = delta; return; }
    target.pending = null;
    // Coalesce mutations while paying down a byte budget. Initial state is sent only once.
    const bytes = new TextEncoder().encode(JSON.stringify(delta)).byteLength;
    target.nextSend = Date.now() + Math.max(200, delta.reset ? 200 : bytes / 131072 * 1000);
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
    const info=await evaluate(tabId,'globalThis.__tabShareDOM.fallback()');
    if(target.full!==info.full){target.full=info.full;for(const id of target.sessions)transmit({type:'mode',sessionId:id,full:info.full});}
    let bytes=0;
    const regions=info.full?[{id:'',width:info.width,height:info.height}]:info.regions;
    for(const region of regions){
      const options={format:'jpeg',quality:65,fromSurface:true,captureBeyondViewport:false};
      if(!info.full)options.clip={x:region.x,y:region.y,width:region.width,height:region.height,scale:1};
      const shot=await command(tabId,'Page.captureScreenshot',options);
      bytes+=shot.data.length;
      for(const id of target.sessions)transmit({type:'raster',sessionId:id,nodeId:region.id,full:info.full,data:shot.data,width:region.width,height:region.height});
    }
    // Fallback pixels are disposable and limited to two frames/s, with their own 64 KiB/s budget.
    target.nextRaster=Date.now()+Math.max(500,bytes/65536*1000);
  }catch{/* Navigation can temporarily destroy the isolated world. */}finally{target.rasterBusy=false;}
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
async function openSession(session) {
  if (opening.has(session.id)) return opening.get(session.id);
  const job = (async () => {
    try {
      const epoch = await boot;
      const stored = await chrome.storage.local.get('sessionTabs');
      const tab = await resolveTab(chrome.tabs, session, stored.sessionTabs?.[session.id], epoch);
      if (bindings.has(session.id) && bindings.get(session.id).tabId !== tab.id) await pause(session.id);
      let target = targets.get(tab.id);
      if (!target) {
        await chrome.debugger.attach({tabId: tab.id}, '1.3');
        target = {sessions: new Set(), contextId: null, capturing: false, nextSend: 0, nextRaster:0, full:false};
        targets.set(tab.id, target);
        await command(tab.id, 'Page.enable');
        target.timer = setInterval(() => void snapshot(tab.id), 200);
        target.rasterTimer = setInterval(() => void raster(tab.id), 500);
      }
      target.sessions.add(session.id);
      bindings.set(session.id, {tabId: tab.id, session});
      const sessionTabs = stored.sessionTabs || {};
      sessionTabs[session.id] = {tabId: tab.id, epoch};
      await chrome.storage.local.set({sessionTabs});
      status(session.id, 'connected', '', tab);
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
  clearInterval(target.timer);
  clearInterval(target.rasterTimer);
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
  if (input.nodeId) {
    await world(binding.tabId);
    const point = await evaluate(binding.tabId, 'globalThis.__tabShareDOM.act(' + JSON.stringify(input) + ')');
    if (action === 'scroll' || action === 'select') return;
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
  if (target && method === 'Page.frameNavigated' && !params.frame.parentId) {
    target.contextId = null; target.pending = null; target.nextSend = 0;
  }
});
function detached(tabId, reason) {
  const target = targets.get(tabId);
  if (!target) return;
  clearInterval(target.timer);
  clearInterval(target.rasterTimer);
  targets.delete(tabId);
  for (const id of target.sessions) {
    bindings.delete(id);
    status(id, 'closed', reason === 'target_closed' ? '原标签页已关闭；网址共享可以点击重新连接来打开新标签页' : '浏览器已停止调试；可关闭分享页面以结束访问');
  }
}
chrome.debugger.onDetach.addListener((source, reason) => detached(source.tabId, reason));
chrome.tabs.onRemoved.addListener(tabId => detached(tabId, 'target_closed'));
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
  const run = async () => {
    if (message.type === 'share') {
      await connect();
      const epoch = await boot;
      const body = {agentId: config.agentId, kind: message.kind, url: targetURL(message.url), title: message.title || ''};
      if (message.kind === 'tab') { body.tabId = message.tabId; body.tabEpoch = epoch; }
      const result = await api('/api/sessions', {method: 'POST', body: JSON.stringify(body)});
      const shares = (await chrome.storage.local.get('shares')).shares || {};
      shares[result.session.id] = {id: result.session.id, title: result.session.title || result.session.url, shareUrl: result.shareUrl, kind: result.session.kind};
      await chrome.storage.local.set({shares});
      return result;
    }
    if (message.type === 'revoke') {
      await api('/api/sessions/' + encodeURIComponent(message.id), {method: 'DELETE'});
      await pause(message.id);
      const {shares = {}, sessionTabs = {}} = await chrome.storage.local.get(['shares', 'sessionTabs']);
      delete shares[message.id]; delete sessionTabs[message.id];
      await chrome.storage.local.set({shares, sessionTabs});
      return {ok: true};
    }
    if (message.type === 'reconnect') {
      if (socket) { const old = socket; socket = null; old.close(); }
      await pauseAll(); await connect(); return {ok: true};
    }
    throw new Error('未知操作');
  };
  run().then(value => respond({ok: true, value}), error => respond({ok: false, error: error.message}));
  return true;
});
chrome.alarms.create('connect', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(() => void connect().catch(() => {}));
chrome.runtime.onStartup.addListener(() => void connect().catch(() => {}));
void connect().catch(() => {});
