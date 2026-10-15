import {PeerLink} from './peer.js';
import {Mirror} from './mirror.js';
import {Resources} from './resources.js';
import {displayLayout,sourcePoint,viewportSize,wheelPixels} from './display.js';
const $ = id => document.getElementById(id);
const id=location.pathname.split('/')[2], key=location.hash.slice(1);
let ws,retry,stopped=false,connected=false,mirror,pending=[],scrollTimer,scrollNode,scrollRoot=false,full=false,modeKnown=false;
const frame=$('mirror');
let peer,peerReady=false,videoInfo,route='WebSocket 兜底',videoTick,regionTimer,lastRegionFrame;
const video=document.getElementById('stream');
const resources=new Resources(id,key,ids=>mirror?.refreshResources(ids));
let sourceMode='dom',activeDialog,viewerId,following=false,viewportTimer,lastViewport,queuedViewport,fitFrame,layout;
let display={mode:'fit',zoom:1};
try{const saved=JSON.parse(localStorage.getItem('tabshare-display:'+id));if(saved&&['fit','width','actual','custom'].includes(saved.mode)&&Number.isFinite(saved.zoom))display={mode:saved.mode,zoom:Math.max(.25,Math.min(2,saved.zoom))};}catch{}
$('display-sizing').value=display.mode;
function displaySettings(){display.mode=$('display-sizing').value;display.zoom=Number($('display-zoom').value)/100;try{localStorage.setItem('tabshare-display:'+id,JSON.stringify(display));}catch{}$('stage').scrollTo(0,0);requestFit();}
$('display-sizing').onchange=displaySettings;
$('display-zoom').oninput=()=>{$('display-sizing').value='custom';displaySettings();};
$('follow-viewport').onchange=()=>{following=$('follow-viewport').checked;lastViewport=null;if(!following)input({action:'restoreViewport'});queueViewport();};
$('restore-viewport').onclick=()=>{following=false;$('follow-viewport').checked=false;clearTimeout(viewportTimer);input({action:'restoreViewport'});};
function exitImmersive(){document.body.classList.remove('immersive');$('fullscreen').textContent='⛶';$('fullscreen').setAttribute('aria-label','全屏显示共享页面');requestFit();}
$('fullscreen').onclick=async()=>{
  if(document.fullscreenElement){await document.exitFullscreen();return;}
  if(document.body.classList.contains('immersive')){exitImmersive();return;}
  document.body.classList.add('immersive');$('fullscreen').textContent='退出全屏';$('fullscreen').setAttribute('aria-label','退出全屏显示');requestFit();
  try{if(document.fullscreenEnabled)await document.documentElement.requestFullscreen();}catch{$('fullscreen').textContent='退出沉浸';}
};
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)exitImmersive();else requestFit();});
$('close-popup').onclick=()=>input({action:'closePopup'});
$('share-settings-toggle').onclick=()=>{const panel=$('share-settings');panel.hidden=!panel.hidden;$('share-settings-toggle').setAttribute('aria-expanded',String(!panel.hidden));};
for(const radio of document.querySelectorAll('[name=share-mode]'))radio.onchange=()=>input({action:'mode',mode:radio.value});
function modeSettings(mode){if(!['dom','raster'].includes(mode))return;sourceMode=mode;for(const r of document.querySelectorAll('[name=share-mode]'))r.checked=r.value===mode;}
function dialogAnswer(accept){if(activeDialog)input({action:'dialog',dialogId:activeDialog.id,accept,text:$('dialog-value').value.slice(0,8192)});}
$('dialog-answer').onsubmit=e=>{e.preventDefault();dialogAnswer(true);};$('dialog-cancel').onclick=()=>dialogAnswer(false);
$('site-dialog').addEventListener('cancel',e=>{e.preventDefault();dialogAnswer(false);});
function siteDialog(value){activeDialog=value;if(!value){$('site-dialog').close();return;}$('dialog-message').textContent=value.message;$('dialog-title').textContent=({alert:'网页提示',confirm:'网页确认',prompt:'网页输入',beforeunload:'离开页面确认'})[value.kind]||'网页提示';$('dialog-value').hidden=value.kind!=='prompt';$('dialog-value').value=value.default||'';$('dialog-cancel').hidden=value.kind==='alert';if(!$('site-dialog').open)$('site-dialog').showModal();}
const modifiers=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
function send(m){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));}
function input(m){if(connected){if(peerReady)void peer.send({type:'input',input:m},'input');else send({type:'input',input:m});}}
function resync(){if(peerReady)void peer.send({type:'resync'},'input');else send({type:'resync'});}
function updateVideo(){
  const live=peerReady&&video.readyState>=2&&!video.paused;
  video.hidden=!full||!live;$('fallback').style.opacity=full&&live?'0':'1';
  const note=full?(live?'WebRTC 画面 · 点击、输入和滚动作用于源标签页':'应急画面 · 点击、输入和滚动作用于源标签页'):'DOM 差异同步 · 可选择文字、复制和操作表单';
  if($('render-note').textContent!==note)$('render-note').textContent=note;
}
function drawRegions(){
  updateVideo();if(!peerReady||!videoInfo||video.readyState<2)return;
  if(!full&&mirror&&videoInfo.version===mirror.version){
    const signature=video.getVideoPlaybackQuality().totalVideoFrames+':'+JSON.stringify(videoInfo)+':'+mirror.sequence;
    if(signature===lastRegionFrame)return;lastRegionFrame=signature;
    const info=videoInfo,sx=video.videoWidth/(info.frameWidth||info.width),sy=video.videoHeight/(info.frameHeight||info.height);
    for(const region of info.regions||[]){const node=mirror.nodes.get(region.id);if(!node)continue;
      let canvas=node.querySelector('canvas[data-raster]');if(!canvas){node.replaceChildren();canvas=mirror.doc.createElement('canvas');canvas.dataset.raster='true';canvas.style.cssText='display:block;width:100%;height:100%;object-fit:fill';node.append(canvas);}
      const w=Math.max(1,Math.round(region.width*sx)),h=Math.max(1,Math.round(region.height*sy));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      canvas.getContext('2d',{alpha:false}).drawImage(video,(region.videoX??region.x-info.scrollX)*sx,(region.videoY??region.y-info.scrollY)*sy,(region.videoWidth??region.width)*sx,(region.videoHeight??region.height)*sy,0,0,w,h);
    }
  }
}
function videoLoop(){drawRegions();if(!stopped)videoTick=video.requestVideoFrameCallback(videoLoop);}
video.addEventListener('playing',()=>{updateVideo();if(videoTick===undefined&&video.requestVideoFrameCallback)videoTick=video.requestVideoFrameCallback(videoLoop);});
async function signaling(s){
  if(s.description?.type==='offer'&&s.attempt!==peer?.attempt){
    peer?.close();peerReady=false;route='WebRTC 协商中';
    const link=new PeerLink({attempt:s.attempt,iceServers:rtcServers,signal:value=>send({type:'signal',signal:value}),
      message:(m,channel)=>{if(channel==='state')receive(m,true);},asset:(meta,bytes)=>void resources.add(meta,bytes),
      track:stream=>{video.srcObject=stream;void video.play().catch(()=>{});},
      state:status=>{if(peer!==link)return;peerReady=status==='up';if(peerReady){void link.route().then(value=>{route=value;notify('已连接 · '+route,true);});resync();sendProfile();}else{route='WebSocket 兜底';updateVideo();send({type:'resync'});}}
    });peer=link;
  }
  if(peer?.attempt===s.attempt)await peer.accept(s);
}
let rtcServers=[],viewportOwner,lastProfile;
function sendProfile(){
  if(!peerReady||!peer)return;
  const box=$('surface').getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  const profile={width:Math.max(1,Math.min(4096,Math.ceil((videoInfo?.frameWidth&&layout?videoInfo.frameWidth*layout.scale:box.width)*dpr))),height:Math.max(1,Math.min(4096,Math.ceil((videoInfo?.frameHeight&&layout?videoInfo.frameHeight*layout.scale:box.height)*dpr))),visible:document.visibilityState!=='hidden'};
  const signature=peer.attempt+JSON.stringify(profile);if(signature===lastProfile)return;lastProfile=signature;void peer.send({type:'peer-profile',profile},'input');
}
document.addEventListener('visibilitychange',sendProfile);
function receive(m,direct=false){
  if(!direct&&peerReady&&['dom','raster','resource','resources'].includes(m.type))return;
  if(m.type==='signal'){if(typeof RTCPeerConnection==='function')void signaling(m.signal).catch(()=>{route='WebSocket 兜底';});return;}
  if(m.type==='video'){videoInfo=m.info;full=!!m.info.full;frame.hidden=full;$('fallback').hidden=!full;clearInterval(regionTimer);lastRegionFrame=null;if(!m.info.full&&m.info.regions?.length)regionTimer=setInterval(drawRegions,33);updateVideo();drawRegions();sendProfile();return;}
  if(m.type==='ice')rtcServers=m.iceServers||[];
  if(m.type==='joined'){viewerId=m.viewerId;rtcServers=m.iceServers||[];lastViewport=null;queueViewport();}
  if(m.type==='viewport')sharedViewport(m.viewport);
  if(m.type==='ping')send({type:'pong'});
  if(m.type==='viewers')$('viewers').textContent=m.viewers+' 人';
  if(m.type==='resource')void resources.add(m.asset);
  if(m.type==='resources')for(const asset of m.assets||[])void resources.add(asset);
  if(m.type==='dialog')siteDialog(m.dialog);
  if(m.type==='dom')render(m.document);
  if(m.type==='mode'){modeSettings(m.mode);modeKnown=true;full=!!m.full;frame.hidden=full;$('fallback').hidden=!full;updateVideo();notify('已连接 · '+(full?'WebRTC 画面 · ':'DOM 差异 · ')+route,true);}
  if(m.type==='raster'){
    if(m.full&&(!modeKnown||full)){full=true;frame.hidden=true;$('fallback').hidden=false;$('fallback').src='data:image/jpeg;base64,'+m.data;updateVideo();notify('已连接 · 应急截图 · '+route,true);}
    else{const node=mirror?.nodes.get(m.nodeId);if(node){let image=node.querySelector('img[data-raster]');if(!image){node.replaceChildren();image=mirror.doc.createElement('img');image.dataset.raster='true';image.style.cssText='display:block;width:100%;height:100%;object-fit:fill';node.append(image);}image.src='data:image/jpeg;base64,'+m.data;}}
  }
  if(m.type==='status'&&m.status!=='connected'){connected=false;notify(m.detail||'等待共享页面');$('detail').textContent=m.detail||'等待共享浏览器连接。';$('empty').hidden=false;$('surface').hidden=true;$('display-area').hidden=true;}
}

function notify(text,live=false){$('status').textContent=text;$('dot').className=live?'live':'';}
function availableSize(shared=false){
  const stage=$('stage'),style=getComputedStyle(stage),rect=stage.getBoundingClientRect();
  const paddingX=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight),paddingY=parseFloat(style.paddingTop)+parseFloat(style.paddingBottom);
  let height=(shared?rect.height:stage.clientHeight)-paddingY;
  const visual=window.visualViewport;
  if(visual&&Math.abs(visual.scale-1)<.01)height=Math.min(height,visual.offsetTop+visual.height-rect.top-paddingY);
  return {width:Math.max(1,(shared?rect.width:stage.clientWidth)-paddingX),height:Math.max(1,height)};
}
function requestFit(){if(!fitFrame)fitFrame=requestAnimationFrame(()=>{fitFrame=null;fit();});}
function queueViewport(){
  if(!following||!connected||!viewerId){clearTimeout(viewportTimer);queuedViewport=null;return;}
  const size=viewportSize(availableSize(true),window.devicePixelRatio),signature=JSON.stringify(size);
  if(signature===lastViewport||signature===queuedViewport)return;
  clearTimeout(viewportTimer);queuedViewport=signature;
  viewportTimer=setTimeout(()=>{
    queuedViewport=null;if(!following||!connected)return;
    lastViewport=signature;input({action:'viewport',...size});
  },450);
}
function sharedViewport(viewport){
  if(viewport&&viewport.owner!==viewerId||!viewport&&viewportOwner===viewerId){following=false;$('follow-viewport').checked=false;clearTimeout(viewportTimer);queuedViewport=null;lastViewport=null;}
  viewportOwner=viewport?.owner;
  $('viewport-note').textContent=viewport?viewport.owner===viewerId?'共享视口跟随我的窗口，其他访客共用此布局。':'共享视口已由另一位访客调整；勾选可切换为我的窗口。':'此项会调整源网页布局，所有访客共同使用。';
}
function fit(){
  const available=availableSize();
  layout=displayLayout(mirror?.meta,available,display.mode,display.zoom);if(!layout)return;
  const {width,height}=mirror.meta;
  frame.style.width=width+'px';frame.style.height=height+'px';frame.style.transform='scale('+layout.scale+')';frame.style.transformOrigin='top left';
  $('fallback').style.width=video.style.width=layout.width+'px';$('fallback').style.height=video.style.height=layout.height+'px';
  $('surface').style.width=layout.width+'px';$('surface').style.height=layout.height+'px';
  $('display-area').style.width=layout.areaWidth+'px';$('display-area').style.height=layout.areaHeight+'px';
  $('surface').dataset.scale=String(layout.scale);
  const percent=Math.round(layout.scale*100);$('display-percent').value=percent+'%';
  $('display-zoom').value=String(Math.max(25,Math.min(200,percent)));
  const text='共享视口 '+width+' × '+height+' · 显示 '+percent+'%';if($('display-info').textContent!==text)$('display-info').textContent=text;
  queueViewport();sendProfile();
}
function render(delta){
  if(!mirror){pending.push(delta);return;}
  if(delta.reset&&delta.version!==mirror.version)resources.keepVersion(delta.version);
  const oldMeta=mirror.meta;
  if(!mirror.apply(delta)){resync();return;}
  connected=true;$('display-area').hidden=false;$('surface').hidden=false;$('empty').hidden=true;fit();
  const meta=delta.meta||{};modeSettings(meta.mode);
  if(meta.url&&document.activeElement!==$('address'))$('address').value=meta.url;
  if(meta.title)document.title=meta.title+' · TabShare';
  if(delta.reset||meta.scrollX!==oldMeta?.scrollX||meta.scrollY!==oldMeta?.scrollY)frame.contentWindow.scrollTo(meta.scrollX||0,meta.scrollY||0);
  notify('已连接 · '+(full?'WebRTC 画面 · ':'DOM 差异 · ')+route,true);
}
function connect(){
  if(stopped)return;
  if(!id||!key){notify('分享链接不完整');$('detail').textContent='请使用包含 # 后面密钥的完整分享链接。';return;}
  const connection=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws/view/'+encodeURIComponent(id));ws=connection;
  connection.onopen=()=>connection.send(JSON.stringify({type:'join',key}));
  connection.onmessage=event=>{
    if(ws!==connection)return;
    receive(JSON.parse(event.data));
  };
  connection.onclose=event=>{
    if(ws!==connection)return;peer?.close();peer=null;peerReady=false;video.srcObject=null;if(stopped)return;connected=false;
    if(event.code===1008){stopped=true;notify('分享已撤销，或链接密钥不正确');return;}
    notify('连接已断开，正在重连…');retry=setTimeout(connect,3000);
  };connection.onerror=()=>{};
}
$('retry').onclick=()=>{if(stopped){stopped=false;connect();}else if(ws?.readyState===WebSocket.OPEN)send({type:'retry'});else{clearTimeout(retry);const old=ws;ws=null;old?.close();connect();}};
$('leave').onclick=()=>{stopped=true;connected=false;clearInterval(regionTimer);peer?.close();peer=null;peerReady=false;clearTimeout(retry);ws?.close();$('surface').hidden=true;$('display-area').hidden=true;$('empty').hidden=false;$('detail').textContent='已断开此访客。';notify('访问已断开');};
for(const action of ['back','forward','reload'])$(action).onclick=()=>input({action});
$('navigation').onsubmit=e=>{e.preventDefault();try{const u=new URL($('address').value);if(!['http:','https:'].includes(u.protocol))throw new Error();input({action:'navigate',url:u.href});}catch{notify('请输入完整的 HTTP(S) 网址');}};
function attach(){
  const doc=frame.contentDocument;mirror=new Mirror(doc,resources);
  const pointer=e=>{const node=e.target.closest?.('[data-node-id]');if(!node)return null;const r=node.getBoundingClientRect();return{nodeId:node.dataset.nodeId,x:Math.max(0,Math.min(1,(e.clientX-r.left)/(r.width||1))),y:Math.max(0,Math.min(1,(e.clientY-r.top)/(r.height||1))),modifiers:modifiers(e),buttons:e.buttons,button:['left','middle','right'][e.button]||'none'};};
  let lastMove=0,touch;
  const clearTouch=()=>{touch=null;};doc.addEventListener('pointercancel',clearTouch,true);
  doc.addEventListener('pointerdown',e=>{if(e.target.closest?.('select'))return;const p=pointer(e);if(e.pointerType==='touch'){if(!e.isPrimary)return;touch={id:e.pointerId,x:e.clientX,y:e.clientY,point:p};return;}if(p)input({action:'mousePressed',...p,clickCount:Math.min(e.detail||1,3)});},true);
  doc.addEventListener('pointerup',e=>{if(e.pointerType==='touch'){if(touch?.id===e.pointerId&&Math.hypot(e.clientX-touch.x,e.clientY-touch.y)<8&&touch.point){const p=pointer(e)||touch.point;input({action:'mousePressed',...p,button:'left',buttons:1,clickCount:1});input({action:'mouseReleased',...p,button:'left',buttons:0,clickCount:1});}clearTouch();return;}if(e.target.closest?.('select'))return;const p=pointer(e);if(p)input({action:'mouseReleased',...p,clickCount:Math.min(e.detail||1,3)});},true);
  doc.addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;if(performance.now()-lastMove<80)return;lastMove=performance.now();const p=pointer(e);if(p)input({action:'mouseMoved',...p});},true);
  doc.addEventListener('click',e=>{if(e.target.closest?.('a'))e.preventDefault();},true);
  doc.addEventListener('submit',e=>e.preventDefault(),true);
  doc.addEventListener('contextmenu',e=>e.preventDefault(),true);
  // Text uses native controls in the visitor browser. Trusted CDP input updates the original.
  doc.addEventListener('input',e=>mirror.localEdit(e.target),true);
  let composing=false,compositionSelection;
  const selection=target=>{const element=target.closest?.('[contenteditable=true]')||target;if(!element?.dataset?.nodeId)return {};const nodeId=element.dataset.nodeId;if(['INPUT','TEXTAREA'].includes(element.tagName)&&typeof element.selectionStart==='number'&&element.selectionStart!==element.selectionEnd)return {nodeId,selection:{start:element.selectionStart,end:element.selectionEnd}};if(element.isContentEditable){const v=doc.getSelection(),find=n=>[...mirror.nodes].find(([,node])=>node===n)?.[0];if(v?.anchorNode&&element.contains(v.anchorNode)&&element.contains(v.focusNode))return{nodeId,selection:{anchor:find(v.anchorNode),focus:find(v.focusNode),anchorOffset:v.anchorOffset,focusOffset:v.focusOffset}};}return {};};
  doc.addEventListener('compositionstart',e=>{composing=true;compositionSelection=selection(e.target);},true);
  doc.addEventListener('compositionend',e=>{composing=false;if(e.data)input({action:'text',text:e.data,...compositionSelection});},true);
  doc.addEventListener('beforeinput',e=>{if(composing||e.isComposing)return;if(e.data){input({action:'text',text:e.data,...selection(e.target)});if(typeof e.target.setRangeText==='function'&&typeof e.target.selectionStart==='number'){e.preventDefault();e.target.setRangeText(e.data,e.target.selectionStart,e.target.selectionEnd,'end');mirror.localEdit(e.target);}}},true);
  doc.addEventListener('keydown',e=>{
    if(composing||e.isComposing||e.keyCode===229)return;
    if((e.ctrlKey||e.metaKey)&&['c','v'].includes(e.key.toLowerCase()))return;
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;
    input({action:'keyDown',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e),...selection(e.target)});
  },true);
  doc.addEventListener('keyup',e=>{if(composing||e.isComposing||e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;input({action:'keyUp',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e)});},true);
  doc.addEventListener('paste',e=>{e.preventDefault();const text=e.clipboardData.getData('text/plain').slice(0,8192);if(text){const selected=selection(e.target),element=e.target;if(typeof element.setRangeText==='function'){element.setRangeText(text,element.selectionStart,element.selectionEnd,'end');mirror.localEdit(element);}input({action:'text',text,...selected});}},true);
  doc.addEventListener('change',e=>{if(e.target.tagName==='SELECT')input({action:'select',nodeId:e.target.dataset.nodeId,text:e.target.value,values:[...e.target.selectedOptions].map(o=>o.value)});},true);
  doc.addEventListener('scroll',e=>{
    const root=e.target===doc;scrollNode=root?doc.scrollingElement:e.target;scrollRoot=root;clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>{if(scrollRoot&&scrollNode.scrollTop===(mirror.meta.scrollY||0)&&scrollNode.scrollLeft===(mirror.meta.scrollX||0))return;input({action:'scroll',nodeId:scrollRoot?'root':scrollNode.dataset.nodeId,scrollTop:scrollNode.scrollTop,scrollLeft:scrollNode.scrollLeft});},100);
  },true);
  frame.contentWindow.addEventListener('scroll',()=>{
    const x=frame.contentWindow.scrollX,y=frame.contentWindow.scrollY;
    clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>{if(x!==(mirror.meta.scrollX||0)||y!==(mirror.meta.scrollY||0))input({action:'scroll',nodeId:'root',scrollTop:y,scrollLeft:x});},100);
  });
  for(const d of pending)render(d);pending=[];
}
frame.addEventListener('load',attach);
if(frame.contentDocument?.readyState==='complete')attach();
new ResizeObserver(requestFit).observe($('stage'));
let dprQuery;function dprChanged(){dprQuery?.removeEventListener('change',dprChanged);dprQuery=matchMedia('(resolution: '+window.devicePixelRatio+'dppx)');dprQuery.addEventListener('change',dprChanged);requestFit();}dprChanged();
window.addEventListener('resize',requestFit);window.visualViewport?.addEventListener('resize',requestFit);window.visualViewport?.addEventListener('scroll',requestFit);
window.addEventListener('pagehide',()=>{stopped=true;clearInterval(regionTimer);peer?.close();video.srcObject=null;resources.dispose();ws?.close();});
connect();
const pixelPoint=e=>{const point=sourcePoint(e,$('fallback').getBoundingClientRect(),mirror?.meta);return point?{...point,button:['left','middle','right'][e.button]||'none',buttons:e.buttons,modifiers:modifiers(e)}:null;};
let pixelMove=0,pixelTouch,touchTimer;
function touchWheel(){clearTimeout(touchTimer);touchTimer=null;if(!pixelTouch)return;const {deltaX,deltaY,point}=pixelTouch;if(deltaX||deltaY)input({action:'mouseWheel',...point,deltaX:Math.max(-10000,Math.min(10000,deltaX)),deltaY:Math.max(-10000,Math.min(10000,deltaY))});pixelTouch.deltaX=pixelTouch.deltaY=0;}
$('fallback').addEventListener('pointerdown',e=>{
  const point=pixelPoint(e);if(!point)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
  if(e.pointerType==='touch'){if(!e.isPrimary)return;pixelTouch={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,point,moved:false,deltaX:0,deltaY:0};return;}
  $('fallback-keyboard').focus({preventScroll:true});input({action:'mousePressed',...point,clickCount:Math.min(e.detail||1,3)});
});
$('fallback').addEventListener('pointermove',e=>{
  if(e.pointerType==='touch'){
    if(pixelTouch?.id!==e.pointerId)return;e.preventDefault();
    if(Math.hypot(e.clientX-pixelTouch.x,e.clientY-pixelTouch.y)<8&&!pixelTouch.moved)return;
    pixelTouch.moved=true;const rect=$('fallback').getBoundingClientRect();
    pixelTouch.deltaX+=(pixelTouch.lastX-e.clientX)*mirror.meta.width/rect.width;pixelTouch.deltaY+=(pixelTouch.lastY-e.clientY)*mirror.meta.height/rect.height;pixelTouch.lastX=e.clientX;pixelTouch.lastY=e.clientY;
    if(!touchTimer)touchTimer=setTimeout(()=>{touchTimer=null;touchWheel();},50);return;
  }
  if(performance.now()-pixelMove<80)return;pixelMove=performance.now();const point=pixelPoint(e);if(point)input({action:'mouseMoved',...point});
});
$('fallback').addEventListener('pointerup',e=>{
  e.preventDefault();const point=pixelPoint(e);if(!point)return;
  if(e.pointerType==='touch'){
    if(pixelTouch?.id!==e.pointerId)return;
    if(pixelTouch.moved)touchWheel();else{$('fallback-keyboard').focus({preventScroll:true});input({action:'mousePressed',...point,button:'left',buttons:1,clickCount:1});input({action:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});}
    pixelTouch=null;return;
  }
  input({action:'mouseReleased',...point,clickCount:Math.min(e.detail||1,3)});
});
$('fallback').addEventListener('pointercancel',()=>{touchWheel();pixelTouch=null;clearTimeout(touchTimer);touchTimer=null;});
$('fallback').addEventListener('contextmenu',e=>e.preventDefault());
$('fallback').addEventListener('wheel',e=>{e.preventDefault();const point=pixelPoint(e);if(point){const wheel=wheelPixels(e,mirror.meta.height);input({action:'mouseWheel',...point,deltaX:Math.max(-10000,Math.min(10000,wheel.deltaX/layout.scale)),deltaY:Math.max(-10000,Math.min(10000,wheel.deltaY/layout.scale))});}},{passive:false});
const pixelKeyboard=$('fallback-keyboard');
pixelKeyboard.addEventListener('beforeinput',e=>{if(!e.isComposing&&e.data){e.preventDefault();input({action:'text',text:e.data});}});
pixelKeyboard.addEventListener('compositionend',e=>{if(e.data)input({action:'text',text:e.data});pixelKeyboard.value='';});
for(const [event,action] of [['keydown','keyDown'],['keyup','keyUp']])pixelKeyboard.addEventListener(event,e=>{if(e.isComposing||e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;e.preventDefault();input({action,key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e)});});
