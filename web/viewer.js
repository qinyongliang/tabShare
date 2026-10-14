import {Mirror} from './mirror.js';
import {Resources} from './resources.js';
const $ = id => document.getElementById(id);
const id=location.pathname.split('/')[2], key=location.hash.slice(1);
let ws,retry,stopped=false,connected=false,mirror,applying=false,pending=[],scrollTimer,scrollNode,scrollRoot=false,full=false,modeKnown=false;
const frame=$('mirror');
const resources=new Resources(id,key,()=>mirror?.refreshResources());
let sourceMode='dom',activeDialog;
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
function input(m){if(connected)send({type:'input',input:m});}
function notify(text,live=false){$('status').textContent=text;$('dot').className=live?'live':'';}
function fit(){
  if(!mirror?.meta)return;
  const {width,height}=mirror.meta,rect=$('stage').getBoundingClientRect();
  const scale=Math.max(.1,Math.min((rect.width-32)/width,(rect.height-32)/height,1));
  frame.style.width=width+'px';frame.style.height=height+'px';frame.style.transform='scale('+scale+')';frame.style.transformOrigin='top left';
  $('fallback').style.width=width*scale+'px';$('fallback').style.height=height*scale+'px';
  $('surface').style.width=width*scale+'px';$('surface').style.height=height*scale+'px';
}
function render(delta){
  if(!mirror){pending.push(delta);return;}
  applying=true;
  if(delta.reset&&delta.version!==mirror.version)resources.keepVersion(delta.version);
  const oldMeta=mirror.meta;
  if(!mirror.apply(delta)){send({type:'retry'});applying=false;return;}
  connected=true;$('surface').hidden=false;$('empty').hidden=true;fit();
  const meta=delta.meta||{};modeSettings(meta.mode);
  if(meta.url&&document.activeElement!==$('address'))$('address').value=meta.url;
  if(meta.title)document.title=meta.title+' · TabShare';
  if(delta.reset||meta.scrollX!==oldMeta?.scrollX||meta.scrollY!==oldMeta?.scrollY)frame.contentWindow.scrollTo(meta.scrollX||0,meta.scrollY||0);
  notify(full?'已连接 · 画面流同步':meta.truncated?'已连接 · 页面较大，部分内容未同步':'已连接 · DOM 差异同步',true);
  requestAnimationFrame(()=>{applying=false;});
}
function connect(){
  if(stopped)return;
  if(!id||!key){notify('分享链接不完整');$('detail').textContent='请使用包含 # 后面密钥的完整分享链接。';return;}
  const connection=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws/view/'+encodeURIComponent(id));ws=connection;
  connection.onopen=()=>connection.send(JSON.stringify({type:'join',key}));
  connection.onmessage=event=>{
    if(ws!==connection)return;
    const m=JSON.parse(event.data);
    if(m.type==='ping')send({type:'pong'});
    if(m.type==='viewers')$('viewers').textContent=m.viewers+' 人';
    if(m.type==='resource')void resources.add(m.asset);
    if(m.type==='resources')for(const asset of m.assets||[])void resources.add(asset);
    if(m.type==='dialog')siteDialog(m.dialog);
    if(m.type==='dom')render(m.document);
    if(m.type==='mode'){modeSettings(m.mode);modeKnown=true;full=!!m.full;frame.hidden=full;$('fallback').hidden=!full;notify(full?'已连接 · 画面流同步':'已连接 · DOM 差异同步',true);}
    if(m.type==='raster'){
      if(m.full&&(!modeKnown||full)){full=true;frame.hidden=true;$('fallback').hidden=false;$('fallback').src='data:image/jpeg;base64,'+m.data;notify('已连接 · 画面流同步',true);}
      else{
        const node=mirror?.nodes.get(m.nodeId);
        if(node){let image=node.querySelector('img[data-raster]');if(!image){node.replaceChildren();image=mirror.doc.createElement('img');image.dataset.raster='true';image.style.cssText='display:block;width:100%;height:100%;object-fit:fill';node.append(image);}image.src='data:image/jpeg;base64,'+m.data;}
      }
    }
    if(m.type==='status'&&m.status!=='connected'){
      connected=false;notify(m.detail||'等待共享页面');$('detail').textContent=m.detail||'等待共享浏览器连接。';$('empty').hidden=false;$('surface').hidden=true;
    }
  };
  connection.onclose=event=>{
    if(ws!==connection||stopped)return;connected=false;
    if(event.code===1008){stopped=true;notify('分享已撤销，或链接密钥不正确');return;}
    notify('连接已断开，正在重连…');retry=setTimeout(connect,3000);
  };connection.onerror=()=>{};
}
$('retry').onclick=()=>{if(stopped){stopped=false;connect();}else if(ws?.readyState===WebSocket.OPEN)send({type:'retry'});else{clearTimeout(retry);const old=ws;ws=null;old?.close();connect();}};
$('leave').onclick=()=>{stopped=true;connected=false;clearTimeout(retry);ws?.close();$('surface').hidden=true;$('empty').hidden=false;$('detail').textContent='已断开此访客。';notify('访问已断开');};
for(const action of ['back','forward','reload'])$(action).onclick=()=>input({action});
$('navigation').onsubmit=e=>{e.preventDefault();try{const u=new URL($('address').value);if(!['http:','https:'].includes(u.protocol))throw new Error();input({action:'navigate',url:u.href});}catch{notify('请输入完整的 HTTP(S) 网址');}};
function attach(){
  const doc=frame.contentDocument;mirror=new Mirror(doc,resources);
  const pointer=e=>{const node=e.target.closest?.('[data-node-id]');if(!node)return null;const r=node.getBoundingClientRect();return{nodeId:node.dataset.nodeId,x:Math.max(0,Math.min(1,(e.clientX-r.left)/(r.width||1))),y:Math.max(0,Math.min(1,(e.clientY-r.top)/(r.height||1))),modifiers:modifiers(e),buttons:e.buttons,button:['left','middle','right'][e.button]||'none'};};
  let lastMove=0;
  doc.addEventListener('pointerdown',e=>{if(e.target.closest?.('select'))return;const p=pointer(e);if(p)input({action:'mousePressed',...p,clickCount:Math.min(e.detail||1,3)});},true);
  doc.addEventListener('pointerup',e=>{if(e.target.closest?.('select'))return;const p=pointer(e);if(p)input({action:'mouseReleased',...p,clickCount:Math.min(e.detail||1,3)});},true);
  doc.addEventListener('pointermove',e=>{if(performance.now()-lastMove<80)return;lastMove=performance.now();const p=pointer(e);if(p)input({action:'mouseMoved',...p});},true);
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
  doc.addEventListener('change',e=>{if(!applying&&e.target.tagName==='SELECT')input({action:'select',nodeId:e.target.dataset.nodeId,text:e.target.value,values:[...e.target.selectedOptions].map(o=>o.value)});},true);
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
new ResizeObserver(fit).observe($('stage'));
window.addEventListener('pagehide',()=>{stopped=true;resources.dispose();ws?.close();});
connect();
const pixelPoint=e=>{const r=$('fallback').getBoundingClientRect();return{x:Math.max(0,Math.min(mirror.meta.width,(e.clientX-r.left)*mirror.meta.width/r.width)),y:Math.max(0,Math.min(mirror.meta.height,(e.clientY-r.top)*mirror.meta.height/r.height)),button:['left','middle','right'][e.button]||'none',buttons:e.buttons,modifiers:modifiers(e)};};
let pixelMove=0;
$('fallback').addEventListener('pointermove',e=>{if(performance.now()-pixelMove<80)return;pixelMove=performance.now();input({action:'mouseMoved',...pixelPoint(e)});});
$('fallback').addEventListener('contextmenu',e=>e.preventDefault());
for(const [event,action] of [['pointerdown','mousePressed'],['pointerup','mouseReleased']])$('fallback').addEventListener(event,e=>{e.preventDefault();$('fallback-keyboard').focus({preventScroll:true});input({action,...pixelPoint(e),clickCount:Math.min(e.detail||1,3)});});
$('fallback').addEventListener('wheel',e=>{e.preventDefault();input({action:'mouseWheel',...pixelPoint(e),deltaX:Math.max(-10000,Math.min(10000,e.deltaX)),deltaY:Math.max(-10000,Math.min(10000,e.deltaY))});},{passive:false});
const pixelKeyboard=$('fallback-keyboard');
pixelKeyboard.addEventListener('beforeinput',e=>{if(!e.isComposing&&e.data){e.preventDefault();input({action:'text',text:e.data});}});
pixelKeyboard.addEventListener('compositionend',e=>{if(e.data)input({action:'text',text:e.data});pixelKeyboard.value='';});
for(const [event,action] of [['keydown','keyDown'],['keyup','keyUp']])pixelKeyboard.addEventListener(event,e=>{if(e.isComposing||e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;e.preventDefault();input({action,key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e)});});
