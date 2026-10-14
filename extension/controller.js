export function serverOrigin(raw) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('服务器地址只能包含协议、域名和端口');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('公网服务器必须使用 HTTPS；本机开发可使用 HTTP');
  return u.origin;
}
export function targetURL(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('只支持 HTTP(S) 网页');
  u.hash = '';
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
  const {action, ...rest} = input;
  if (['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(action)) {
    const params = {type: action, x: rest.x || 0, y: rest.y || 0, button: rest.button || 'none', buttons: rest.buttons || 0, modifiers: rest.modifiers || 0};
    if (action === 'mousePressed' || action === 'mouseReleased') params.clickCount = rest.clickCount || 1;
    if (action === 'mouseWheel') { params.deltaX = rest.deltaX || 0; params.deltaY = rest.deltaY || 0; }
    return ['Input.dispatchMouseEvent', params];
  }
  if (action === 'keyDown' || action === 'keyUp') return ['Input.dispatchKeyEvent', {type: action === 'keyDown' ? 'rawKeyDown' : 'keyUp', key: rest.key, code: rest.code, windowsVirtualKeyCode: rest.keyCode || 0, nativeVirtualKeyCode: rest.keyCode || 0, modifiers: rest.modifiers || 0}];
  if (action === 'text') return ['Input.insertText', {text: rest.text}];
  if (action === 'navigate') return ['Page.navigate', {url: targetURL(rest.url)}];
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
