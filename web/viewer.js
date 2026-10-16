import {SyncFeedback} from './feedback.js';
import {VisitorGeolocation} from './geolocation.js';
import {pasteImage,textPastePackets,clipboardShortcut,selectedText} from './clipboard.js';
import {contextMenu} from './context-menu.js';
import {draggable} from './draggable.js';
import {RemoteInput} from './remote-input.js';
import {Downloads} from './downloads.js';
import {PointerForwarder} from './pointer.js';
import {PopupWindows} from './popups.js';
import {shareKey,SharedNavigation} from './navigation.js';
import {PeerLink} from './peer.js';
import {Mirror} from './mirror.js';
import {Resources} from './resources.js';
import {displayLayout,sourcePoint,viewportSize,wheelPixels} from './display.js';
const $ = id => document.getElementById(id);
const id=location.pathname.split('/')[2], key=shareKey(location.hash);
let ws,retry,stopped=false,connected=false,mirror,pending=[],scrollTimer,scrollNode,scrollRoot=false,full=false,modeKnown=false;
const frame=$('mirror');
const feedback=new SyncFeedback($('sync-feedback'),document.documentElement);
let peer,peerReady=false,videoInfo,route='WebSocket 兜底',videoTick,regionTimer,lastRegionFrame;
const video=document.getElementById('stream');
const resources=new Resources(id,key,ids=>mirror?.refreshResources(ids));
let downloads=new Downloads(document,text=>notify(text,true));
const visitorLocation=new VisitorGeolocation(document,message=>input(message));
const popupWindows=new PopupWindows(document);
let contextSeen=0,sourceMode='dom',activeDialog,viewerId,following=false,viewportTimer,lastViewport,queuedViewport,fitFrame,layout;
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
const settingsDrag=draggable($('share-settings-toggle'),$('share-settings'));
$('share-settings-toggle').onclick=()=>{const panel=$('share-settings');panel.hidden=!panel.hidden;$('share-settings-toggle').setAttribute('aria-expanded',String(!panel.hidden));settingsDrag.reflow();};
for(const radio of document.querySelectorAll('[name=share-mode]'))radio.onchange=()=>input({action:'mode',mode:radio.value});
function modeSettings(mode){if(!['dom','raster'].includes(mode))return;sourceMode=mode;for(const r of document.querySelectorAll('[name=share-mode]'))r.checked=r.value===mode;}
function dialogAnswer(accept){if(activeDialog)input({action:'dialog',dialogId:activeDialog.id,accept,text:$('dialog-value').value.slice(0,8192)});}
$('dialog-answer').onsubmit=e=>{e.preventDefault();dialogAnswer(true);};$('dialog-cancel').onclick=()=>dialogAnswer(false);
$('site-dialog').addEventListener('cancel',e=>{e.preventDefault();dialogAnswer(false);});
function siteDialog(value){activeDialog=value;if(!value){$('site-dialog').close();return;}$('dialog-message').textContent=value.message;$('dialog-title').textContent=({alert:'网页提示',confirm:'网页确认',prompt:'网页输入',beforeunload:'离开页面确认'})[value.kind]||'网页提示';$('dialog-value').hidden=value.kind!=='prompt';$('dialog-value').value=value.default||'';$('dialog-cancel').hidden=value.kind==='alert';if(!$('site-dialog').open)$('site-dialog').showModal();}
const modifiers=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
function send(m){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));}
const navigation=new SharedNavigation(window,key,m=>input(m));
function input(m){if(connected){if(['mouseReleased','navigate','reload','back','forward','history','select'].includes(m.action))m={...m,requestId:feedback.begin()};if(m.nodeId||['text','keyDown','keyUp','mouseMoved','mouseLeave','mousePressed','mouseReleased','mouseWheel','scroll','select','selection'].includes(m.action))m={version:mirror?.version,...m};if(peerReady)void peer.send({type:'input',input:m},'input');else send({type:'input',input:m});}}
const pageMenu=contextMenu(document,{navigate:url=>input({action:'navigate',url}),reload:()=>input({action:'reload'}),error:error=>notify(error.message,true)});
const remoteInput=new RemoteInput(document,frame,m=>input(m),data=>{const image=[...data.files].find(f=>/^image\/(png|jpeg|gif|webp)$/.test(f.type));if(image)void pasteImage(image,{session:id,key,viewerId,peer:peerReady?peer:null,selection:{version:mirror.version,nodeId:''}}).catch(e=>notify(e.message,true));else try{for(const packet of textPastePackets(data.getData('text/plain')))input(packet);}catch(e){notify(e.message,true);}});
let regionalPointer,regionalActive=false;
function resync(){if(peerReady)void peer.send({type:'resync'},'input');else send({type:'resync'});}
function updateVideo(){
  const live=peerReady&&video.readyState>=2&&!video.paused;
  video.hidden=!full||!live;$('fallback').style.opacity=full&&live?'0':'1';
  const note=full?(live?'WebRTC 画面 · 点击、输入和滚动作用于源标签页':'应急画面 · 点击、输入和滚动作用于源标签页'):'DOM 差异同步 · 可选择文字、复制和操作表单';
  if($('render-note').textContent!==note)$('render-note').textContent=note;
}
function regionStyle(node,media,region){
  if(getComputedStyle(node).position==='static')node.style.position='relative';
  media.style.cssText='position:absolute;display:block;pointer-events:none;object-fit:fill;left:'+(region.offsetX||0)+'px;top:'+(region.offsetY||0)+'px;width:'+(region.styleWidth||region.width)+'px;height:'+(region.styleHeight||region.height)+'px';
  if(region.cuts?.length&&media.tagName==='IMG'){
    const w=region.width,h=region.height;let path='M0 0H'+w+'V'+h+'H0Z';
    for(const c of region.cuts)path+='M'+c.x+' '+c.y+'v'+c.height+'h'+c.width+'v-'+c.height+'Z';
    media.style.clipPath='path(evenodd,"'+path+'")';
  }
}
function drawRegions(){
  updateVideo();if(!peerReady||!videoInfo||video.readyState<2)return;
  if(!full&&mirror&&videoInfo.version===mirror.version){
    const signature=video.getVideoPlaybackQuality().totalVideoFrames+':'+JSON.stringify(videoInfo)+':'+mirror.sequence;
    if(signature===lastRegionFrame)return;lastRegionFrame=signature;
    const info=videoInfo,sx=video.videoWidth/(info.frameWidth||info.width),sy=video.videoHeight/(info.frameHeight||info.height);
    for(const region of info.regions||[]){const node=mirror.nodes.get(region.id);if(!node)continue;
      let canvas=node.querySelector('canvas[data-raster]');if(!canvas){node.replaceChildren();canvas=mirror.doc.createElement('canvas');canvas.dataset.raster='true';node.append(canvas);}
      regionStyle(node,canvas,region);
      const w=Math.max(1,Math.round(region.width*sx)),h=Math.max(1,Math.round(region.height*sy));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      canvas.getContext('2d').drawImage(video,(region.videoX??region.x-info.scrollX)*sx,(region.videoY??region.y-info.scrollY)*sy,(region.videoWidth??region.width)*sx,(region.videoHeight??region.height)*sy,0,0,w,h);
      const ctx=canvas.getContext('2d');for(const cut of region.cuts||[])ctx.clearRect(cut.x*sx,cut.y*sy,cut.width*sx,cut.height*sy);
    }
  }
}
function videoLoop(){drawRegions();if(!stopped)videoTick=video.requestVideoFrameCallback(videoLoop);}
video.addEventListener('playing',()=>{updateVideo();if(videoTick===undefined&&video.requestVideoFrameCallback)videoTick=video.requestVideoFrameCallback(videoLoop);});
async function signaling(s){
  if(s.description?.type==='offer'&&s.attempt!==peer?.attempt){
    peer?.close();peerReady=false;route='WebRTC 协商中';
    const link=new PeerLink({attempt:s.attempt,iceServers:rtcServers,signal:value=>send({type:'signal',signal:value}),
      message:(m,channel)=>{if(channel==='state')receive(m,true);},asset:(meta,bytes)=>{if(meta.kind==='download-chunk')queueDownload(meta,bytes);else void resources.add(meta,bytes);},
      track:stream=>{video.srcObject=stream;void video.play().catch(()=>{});},
      state:status=>{if(peer!==link)return;peerReady=status==='up';if(peerReady){void link.route().then(value=>{route=value;notify('已连接 · '+route,true);});resync();sendProfile();}else{route='WebSocket 兜底';updateVideo();send({type:'resync'});}}
    });peer=link;
  }
  if(peer?.attempt===s.attempt)await peer.accept(s);
}
let rtcServers=[],viewportOwner,lastProfile,viewportInitialized=false,autoViewport=false;
let downloadQueue=Promise.resolve();
function queueDownload(meta,bytes){const receiver=downloads;downloadQueue=downloadQueue.then(()=>acceptDownload(receiver,meta,bytes)).catch(error=>notify(error.message,true));}
async function acceptDownload(receiver,meta,bytes){
  try{const acknowledgement=await receiver.accept(meta,bytes);if(acknowledgement&&receiver===downloads&&!receiver.closed)input({action:'downloadAck',text:JSON.stringify(acknowledgement)});}
  catch(error){if(receiver===downloads&&!receiver.closed&&meta?.id&&Number.isSafeInteger(meta.offset+bytes.length))input({action:'downloadAck',text:JSON.stringify({id:meta.id,offset:meta.offset+bytes.length,error:String(error.message||'无法保存下载').slice(0,200)})});notify(error.message,true);}
}

function sendProfile(){
  if(!peerReady||!peer)return;
  const box=$('surface').getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  const profile={width:Math.max(1,Math.min(4096,Math.ceil((videoInfo?.frameWidth&&layout?videoInfo.frameWidth*layout.scale:box.width)*dpr))),height:Math.max(1,Math.min(4096,Math.ceil((videoInfo?.frameHeight&&layout?videoInfo.frameHeight*layout.scale:box.height)*dpr))),visible:document.visibilityState!=='hidden'};
  const signature=peer.attempt+JSON.stringify(profile);if(signature===lastProfile)return;lastProfile=signature;void peer.send({type:'peer-profile',profile},'input');
}
document.addEventListener('visibilitychange',sendProfile);
function receive(m,direct=false){
  if(m.type==='geolocation'){try{visitorLocation.receive(JSON.parse(m.data));}catch{}return;}
  if(!direct&&peerReady&&['dom','raster','resource','resources'].includes(m.type))return;
  if(m.type==='signal'){if(typeof RTCPeerConnection==='function')void signaling(m.signal).catch(()=>{route='WebSocket 兜底';});return;}
  if(m.type==='video'){videoInfo=m.info;full=false;frame.hidden=false;$('fallback').hidden=true;clearInterval(regionTimer);lastRegionFrame=null;if(!m.info.full&&m.info.regions?.length)regionTimer=setInterval(drawRegions,33);updateVideo();drawRegions();sendProfile();return;}
  if(m.type==='ice')rtcServers=m.iceServers||[];
  if(m.type==='joined'){viewerId=m.viewerId;rtcServers=m.iceServers||[];autoViewport=!!m.autoViewport;lastViewport=null;queueViewport();}
  if(m.type==='viewport')sharedViewport(m.viewport);
  if(m.type==='ping')send({type:'pong'});
  if(m.type==='viewers')$('viewers').textContent=m.viewers+' 人';
  if(m.type==='resource')void resources.add(m.asset);
  if(m.type==='resources')for(const asset of m.assets||[])void resources.add(asset);
  if(m.type==='input-ack'){feedback.acknowledge(m.requestId,m.status);return;}
  if(m.type==='notice')notify(m.detail||'操作未完成',true);
  if(m.type==='download'){const bytes=Uint8Array.from(atob(m.download.data||''),c=>c.charCodeAt(0));queueDownload(m.download,bytes);}
  if(m.type==='dialog')siteDialog(m.dialog);
  if(m.type==='popup')popupWindows.receive(m.popup);
  if(m.type==='dom')render(m.document);
  if(m.type==='mode'){modeSettings(m.mode);modeKnown=true;full=false;frame.hidden=false;$('fallback').hidden=true;updateVideo();notify('已连接 · '+(full?'WebRTC 画面 · ':'DOM 差异 · ')+route,true);}
  if(m.type==='raster'){
    if(!m.full){const node=mirror?.nodes.get(m.nodeId);if(node){let image=node.querySelector('img[data-raster]');if(!image){node.replaceChildren();image=mirror.doc.createElement('img');image.dataset.raster='true';node.append(image);}regionStyle(node,image,{...m,...m.region});image.src='data:image/jpeg;base64,'+m.data;}}
  }
  if(m.type==='status'&&m.status!=='connected'){if(m.status==='closed'&&new URLSearchParams(location.search).has('popup'))window.close();connected=false;notify(m.detail||'等待共享页面');$('detail').textContent=m.detail||'等待共享浏览器连接。';$('empty').hidden=false;$('surface').hidden=true;$('display-area').hidden=true;}
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
  $('stage').dataset.pan=String(['width','actual','custom'].includes(display.mode));
  const {width,height}=mirror.meta;
  frame.style.width=width+'px';frame.style.height=height+'px';frame.style.transform='scale('+layout.scale+')';frame.style.transformOrigin='top left';
  $('fallback').style.width=video.style.width=layout.width+'px';$('fallback').style.height=video.style.height=layout.height+'px';
  $('surface').style.width=layout.width+'px';$('surface').style.height=layout.height+'px';
  $('display-area').style.width=layout.areaWidth+'px';$('display-area').style.height=layout.areaHeight+'px';
  $('surface').dataset.scale=String(layout.scale);
  const percent=Math.round(layout.scale*100);$('display-percent').value=percent+'%';
  $('display-zoom').value=String(Math.max(25,Math.min(200,percent)));
  const text='共享视口 '+width+' × '+height+' · 显示 '+percent+'%';if($('display-info').textContent!==text)$('display-info').textContent=text;
  queueViewport();sendProfile();remoteInput.place();
}
function render(delta){
  if(!mirror){pending.push(delta);return;}
  if(delta.reset&&delta.version!==mirror.version){if(mirror.version)visitorLocation.reset();resources.keepVersion(delta.version);remoteInput.release();regionalActive=false;regionalPointer=null;}
  const oldMeta=mirror.meta;
  if(!mirror.apply(delta)){resync();return;}
  feedback.progress(delta);
  connected=true;$('display-area').hidden=false;$('surface').hidden=false;$('empty').hidden=true;fit();
  const meta=delta.meta||{};if(meta.contextMenu?.sequence!==contextSeen){contextSeen=meta.contextMenu?.sequence;if(meta.contextMenu?.custom)pageMenu.hide();}$('surface').dataset.syncing=String(!!meta.pending);modeSettings(meta.mode);navigation.update(meta);if(!viewportInitialized&&viewerId){viewportInitialized=true;if(autoViewport&&!viewportOwner){following=true;$('follow-viewport').checked=true;queueViewport();}}
  remoteInput.update(meta);if(regionalActive&&!regionalPointer)remoteInput.copySelection(mirror.doc,meta.selection);
  if(meta.url&&document.activeElement!==$('address'))$('address').value=meta.url;
  if(typeof meta.title==='string')document.title=meta.title||meta.url||'共享标签页';
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
    if(ws!==connection)return;feedback.disconnect();visitorLocation.reset();void downloads.dispose();downloads=new Downloads(document,text=>notify(text,true));peer?.close();peer=null;peerReady=false;video.srcObject=null;if(stopped)return;connected=false;
    if(event.code===1008){stopped=true;if(new URLSearchParams(location.search).has('popup'))window.close();notify('分享已撤销，或链接密钥不正确');return;}
    notify('连接已断开，正在重连…');retry=setTimeout(connect,3000);
  };connection.onerror=()=>{};
}
$('retry').onclick=()=>{if(stopped){stopped=false;downloads=new Downloads(document,text=>notify(text,true));connect();}else if(ws?.readyState===WebSocket.OPEN)send({type:'retry'});else{clearTimeout(retry);const old=ws;ws=null;old?.close();connect();}};
$('leave').onclick=()=>{feedback.disconnect();visitorLocation.reset();void downloads.dispose();stopped=true;connected=false;clearInterval(regionTimer);peer?.close();peer=null;peerReady=false;clearTimeout(retry);ws?.close();$('surface').hidden=true;$('display-area').hidden=true;$('empty').hidden=false;$('detail').textContent='已断开此访客。';notify('访问已断开');};
$('reload').onclick=()=>input({action:'reload'});
$('navigation').onsubmit=e=>{e.preventDefault();try{const u=new URL($('address').value);if(!['http:','https:'].includes(u.protocol))throw new Error();input({action:'navigate',url:u.href});}catch{notify('请输入完整的 HTTP(S) 网址');}};
let pointerForwarder;
function attach(){
  const doc=frame.contentDocument;
  // Never attach to the initial about:blank document: it inherits the shell CSP
  // and is replaced when the dedicated sandbox page finishes loading.
  if(!doc||doc.URL!==new URL(frame.src,location.href).href||doc.readyState!=='complete'||mirror?.doc===doc)return;
  resources.setDocument(doc);mirror=new Mirror(doc,resources);
  pointerForwarder?.dispose();pointerForwarder=new PointerForwarder(doc,frame,m=>input(m));
  doc.addEventListener('pointerdown',e=>{const region=e.target.closest?.('[data-unsupported]');regionalActive=!!region;remoteInput.release();if(region&&e.button===0)regionalPointer={id:e.pointerId,x:e.clientX,y:e.clientY};},true);
  doc.addEventListener('pointerup',e=>{if(regionalPointer?.id!==e.pointerId)return;const moved=Math.hypot(e.clientX-regionalPointer.x,e.clientY-regionalPointer.y)>6;regionalPointer=null;if(!moved){const r=frame.getBoundingClientRect(),scale=layout?.scale||1;remoteInput.activate(r.left+e.clientX*scale,r.top+e.clientY*scale);}},true);
  doc.addEventListener('pointercancel',()=>{regionalPointer=null;},true);
  doc.addEventListener('copy',e=>{if(regionalActive&&mirror.meta?.selection?.text){e.preventDefault();e.clipboardData.setData('text/plain',mirror.meta.selection.text);}},true);
  doc.addEventListener('keydown',e=>{if(regionalActive&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.target.closest?.('input,textarea,[contenteditable=true]')&&(e.key.length===1||e.key==='Process'||e.keyCode===229)){remoteInput.place();remoteInput.box.focus({preventScroll:true});}},true);
  const pointer=e=>{const node=e.target.closest?.('[data-node-id]');if(!node)return null;const r=node.getBoundingClientRect();return{nodeId:node.dataset.nodeId,x:Math.max(0,Math.min(1,(e.clientX-r.left)/(r.width||1))),y:Math.max(0,Math.min(1,(e.clientY-r.top)/(r.height||1))),modifiers:modifiers(e),buttons:e.buttons,button:['left','middle','right'][e.button]||'none'};};
  let touch;
  const clearTouch=()=>{touch=null;};doc.addEventListener('pointercancel',clearTouch,true);
  doc.addEventListener('pointerdown',e=>{if(e.target.closest?.('select'))return;const p=pointer(e);if(e.pointerType==='touch'){if(!e.isPrimary)return;touch={id:e.pointerId,x:e.clientX,y:e.clientY,point:p};return;}if(p)input({action:'mousePressed',...p,clickCount:Math.min(e.detail||1,3)});},true);
  doc.addEventListener('pointerup',e=>{if(e.pointerType==='touch'){if(touch?.id===e.pointerId&&Math.hypot(e.clientX-touch.x,e.clientY-touch.y)<8&&touch.point){const p=pointer(e)||touch.point;input({action:'mousePressed',...p,button:'left',buttons:1,clickCount:1});input({action:'mouseReleased',...p,button:'left',buttons:0,clickCount:1});}clearTouch();return;}if(e.target.closest?.('select'))return;const p=pointer(e);if(p)input({action:'mouseReleased',...p,clickCount:Math.min(e.detail||1,3)});},true);
  doc.addEventListener('click',e=>{if(e.target.closest?.('a'))e.preventDefault();},true);
  doc.addEventListener('submit',e=>e.preventDefault(),true);
  doc.addEventListener('contextmenu',e=>{
    const text=doc.getSelection()?.toString()||'';if(text||e.target.closest?.('input,textarea,[contenteditable=true],img,[data-unsupported]'))return;
    e.preventDefault();const node=e.target.closest?.('[data-node-id]'),href=mirror.states.get(node?.dataset.nodeId)?.href,box=frame.getBoundingClientRect();
    pageMenu.show({x:box.x+e.clientX*(layout?.scale||1),y:box.y+e.clientY*(layout?.scale||1),text,href,paste:()=>pasteClipboard(e.target)});
  },true);
  doc.addEventListener('pointerdown',()=>pageMenu.hide(),true);
  // Text uses native controls in the visitor browser. Trusted CDP input updates the original.
  doc.addEventListener('input',e=>mirror.localEdit(e.target),true);
  let composing=false,compositionSelection;
  const selection=target=>{const element=target.closest?.('[contenteditable=true]')||target;if(!element?.dataset?.nodeId)return {};const nodeId=element.dataset.nodeId;if(['INPUT','TEXTAREA'].includes(element.tagName)&&typeof element.selectionStart==='number'&&element.selectionStart!==element.selectionEnd)return {nodeId,selection:{start:element.selectionStart,end:element.selectionEnd}};if(element.isContentEditable){const v=doc.getSelection(),find=n=>[...mirror.nodes].find(([,node])=>node===n)?.[0];if(v?.anchorNode&&element.contains(v.anchorNode)&&element.contains(v.focusNode))return{nodeId,selection:{anchor:find(v.anchorNode),focus:find(v.focusNode),anchorOffset:v.anchorOffset,focusOffset:v.focusOffset}};}return {};};
  doc.addEventListener('compositionstart',e=>{composing=true;compositionSelection=selection(e.target);},true);
  doc.addEventListener('compositionend',e=>{composing=false;if(e.data)input({action:'text',text:e.data,...compositionSelection});},true);
  doc.addEventListener('beforeinput',e=>{if(composing||e.isComposing)return;if(e.data){input({action:'text',text:e.data,...selection(e.target)});if(typeof e.target.setRangeText==='function'&&typeof e.target.selectionStart==='number'){e.preventDefault();e.target.setRangeText(e.data,e.target.selectionStart,e.target.selectionEnd,'end');mirror.localEdit(e.target);}}},true);
  const browserHistoryKey=e=>e.altKey&&!e.ctrlKey&&!e.metaKey&&['ArrowLeft','ArrowRight'].includes(e.key)||e.metaKey&&!e.altKey&&['[',']'].includes(e.key);
  doc.addEventListener('keydown',e=>{
    if(browserHistoryKey(e)){e.preventDefault();history.go(['ArrowLeft','['].includes(e.key)?-1:1);return;}
    if(composing||e.isComposing||e.keyCode===229)return;
    if(clipboardShortcut(e))return;
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;
    input({action:'keyDown',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e),...selection(e.target)});
  },true);
  doc.addEventListener('keyup',e=>{if(browserHistoryKey(e)||clipboardShortcut(e))return;if(composing||e.isComposing||e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;input({action:'keyUp',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e)});},true);
  function pasteText(text,target){
    if(!text)return;
    const packets=textPastePackets(text,selection(target));
    if(typeof target.setRangeText==='function'&&typeof target.selectionStart==='number'&&typeof target.selectionEnd==='number'){target.setRangeText(text,target.selectionStart,target.selectionEnd,'end');mirror.localEdit(target);}
    for(const packet of packets)input(packet);
  }
  function pasteFile(file,target){
    const node=target.closest?.('[data-node-id]');
    return pasteImage(file,{session:id,key,viewerId,peer:peerReady?peer:null,selection:{...selection(target),nodeId:selection(target).nodeId||node?.dataset.nodeId,version:mirror.version}}).catch(error=>notify(error.message,true));
  }
  async function pasteClipboard(target){
    if(!navigator.clipboard?.read){if(navigator.clipboard?.readText){pasteText(await navigator.clipboard.readText(),target);return;}throw Error('当前浏览器不支持剪贴板读取，请使用 Ctrl+V 或系统粘贴');}
    const entries=await navigator.clipboard.read();for(const entry of entries){const mime=entry.types.find(v=>/^image\/(png|jpeg|gif|webp)$/.test(v));if(mime){await pasteFile(new File([await entry.getType(mime)],'clipboard.'+mime.split('/')[1],{type:mime}),target);return;}if(entry.types.includes('text/plain')){pasteText(await (await entry.getType('text/plain')).text(),target);return;}}
  }
  doc.addEventListener('paste',e=>{e.preventDefault();const image=[...e.clipboardData.files].find(file=>/^image\/(png|jpeg|gif|webp)$/.test(file.type));if(image){void pasteFile(image,e.target);return;}try{pasteText(e.clipboardData.getData('text/plain'),e.target);}catch(error){notify(error.message,true);}},true);

  doc.addEventListener('cut',e=>{
    const selected=selection(e.target),text=selectedText(doc,e.target);
    if(!selected.selection||!text||e.target.readOnly||e.target.disabled)return;
    e.preventDefault();e.clipboardData.setData('text/plain',text);
    if(typeof e.target.setRangeText==='function'&&typeof e.target.selectionStart==='number'){e.target.setRangeText('',e.target.selectionStart,e.target.selectionEnd,'end');mirror.localEdit(e.target);}
    input({action:'keyDown',key:'Backspace',code:'Backspace',keyCode:8,...selected});input({action:'keyUp',key:'Backspace',code:'Backspace',keyCode:8});
  },true);
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
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
window.addEventListener('pagehide',()=>{feedback.disconnect();stopped=true;clearInterval(regionTimer);peer?.close();video.srcObject=null;resources.dispose();downloads.dispose();ws?.close();});
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

window.addEventListener('pagehide',()=>visitorLocation.reset());
