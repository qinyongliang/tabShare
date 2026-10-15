export function serverOrigin(raw) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('服务器地址只能包含协议、域名和端口');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('公网服务器必须使用 HTTPS；本机开发可使用 HTTP');
  return u.origin;
}
export function targetURL(raw,keepHash=false) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('只支持 HTTP(S) 网页');
  if(!keepHash)u.hash = '';
  return u.href;
}
export async function resolveTab(api, session, binding, epoch) {
  if (session.kind === 'tab' && session.tabEpoch !== epoch) throw new Error('原标签页所属的浏览器已关闭，请重新分享');
  const id = binding?.epoch === epoch ? binding.tabId : (session.kind === 'tab' ? session.tabId : null);
  if (id != null) {
    try {
      const tab = await api.get(id);
      if (!tab.discarded) return tab;
      if (session.kind === 'tab') return await api.reload(id).then(() => api.get(id));
    } catch { /* An URL share may reopen a closed tab. */ }
  }
  if (session.kind === 'tab') throw new Error('原标签页已关闭；此链接不再打开新的标签页');
  const tabs = await api.query({});
  const existing = tabs.find(t => {
    try { return targetURL(t.url || '') === session.url; } catch { return false; }
  });
  if (existing) {
    if (existing.discarded) await api.reload(existing.id);
    return existing;
  }
  return api.create({url: session.url, active: false});
}
export function cdpInput(input) {
  if(input.action==='mouseLeave')return ['Input.dispatchMouseEvent',{type:'mouseMoved',x:-1,y:-1,button:'none',buttons:0,modifiers:0}];
  const {action, ...rest} = input;
  if (['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(action)) {
    const params = {type: action, x: rest.x || 0, y: rest.y || 0, button: rest.button || 'none', buttons: rest.buttons || 0, modifiers: rest.modifiers || 0};
    if(action==='mouseMoved'&&params.buttons&&params.button==='none')params.button=params.buttons&1?'left':params.buttons&2?'right':'middle';
    if (action === 'mousePressed' || action === 'mouseReleased') params.clickCount = rest.clickCount || 1;
    if (action === 'mouseWheel') { params.deltaX = rest.deltaX || 0; params.deltaY = rest.deltaY || 0; }
    return ['Input.dispatchMouseEvent', params];
  }
  if (action === 'keyDown' || action === 'keyUp') return ['Input.dispatchKeyEvent', {type: action === 'keyDown' ? 'rawKeyDown' : 'keyUp', key: rest.key, code: rest.code, windowsVirtualKeyCode: rest.keyCode || 0, nativeVirtualKeyCode: rest.keyCode || 0, modifiers: rest.modifiers || 0}];
  if (action === 'text') return ['Input.insertText', {text: rest.text}];
  if (action === 'navigate') return ['Page.navigate', {url: targetURL(rest.url,true)}];
  if (action === 'reload') return ['Page.reload', {}];
  throw new Error('不支持的控制指令');
}

// Keep large/complex displays within the relay's 2 MiB encoded-frame limit.
export async function rasterFrame(capture,options) {
  for(const quality of [65,40,15,5]){
    const shot=await capture({...options,quality});
    if(shot.data?.length<2*1024*1024)return shot;
  }
  throw new Error('画面超过传输预算');
}

// Direct input has the same allowlist and bounds as relay input. Never accept CDP methods.
export function validPeerInput(i) {
  if(!i||typeof i!=='object'||new TextEncoder().encode(JSON.stringify(i)).length>16384)return false;
  const bounded=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  const short=(v,n)=>v==null||typeof v==='string'&&new TextEncoder().encode(v).length<=n;
  if(!short(i.version,80)||!short(i.text,8192)||!short(i.key,64)||!short(i.code,64)||!short(i.nodeId,32)||!bounded(i.modifiers??0,0,15))return false;
  if(i.selection){const s=i.selection;if(!short(s.anchor,32)||!short(s.focus,32)||['anchorOffset','focusOffset','start','end'].some(k=>!bounded(s[k]??0,0,100000)))return false;}
  switch(i.action){
    case 'mouseLeave':return !i.nodeId;
    case 'mouseMoved':case 'mousePressed':case 'mouseReleased':case 'mouseWheel':return ['','none','left','right','middle'].includes(i.button??'')&&bounded(i.x,0,16384)&&bounded(i.y,0,16384)&&bounded(i.buttons??0,0,7)&&bounded(i.clickCount??0,0,3)&&bounded(i.deltaX??0,-10000,10000)&&bounded(i.deltaY??0,-10000,10000);
    case 'keyDown':case 'keyUp':return bounded(i.keyCode??0,0,255);
    case 'text':return typeof i.text==='string'&&i.text.length>0;
    case 'scroll':return !!i.nodeId&&bounded(i.scrollTop??0,0,10000000)&&bounded(i.scrollLeft??0,0,10000000);
    case 'select':return !!i.nodeId&&Array.isArray(i.values)&&i.values.length<=128&&i.values.every(v=>typeof v==='string')&&new TextEncoder().encode(i.values.join('')).length<=8192;
    case 'mode':return i.mode==='dom';
    case 'selection':return !!i.nodeId&&!!i.selection;
    case 'dialog':return /^[A-Za-z0-9_-]{8,80}$/.test(i.dialogId||'');
    case 'viewport':return Number.isInteger(i.width)&&Number.isInteger(i.height)&&bounded(i.width,320,3840)&&bounded(i.height,240,2160)&&bounded(i.deviceScaleFactor,1,2)&&i.width*i.deviceScaleFactor<=4096&&i.height*i.deviceScaleFactor<=4096&&i.width*i.height*i.deviceScaleFactor**2<=8294400;
    case 'history':return Number.isInteger(i.entryId)&&i.entryId>0&&i.entryId<=2147483647;
    case 'navigate':try{return short(i.url,8192)&&!!targetURL(i.url);}catch{return false;}
    case 'restoreViewport':case 'closePopup':case 'reload':case 'back':case 'forward':return true;
    default:return false;
  }
}
