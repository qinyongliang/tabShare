import {draggable} from './draggable.js';
import {caretPosition,selectionState} from './caret.js';
// The code below runs only in an isolated world of the explicitly shared tab.
function bootstrap(draggable,caretPosition,selectionState) {
  if(globalThis.__tabShareDOM&&!globalThis.__tabShareDOM.disposed){if(globalThis.__tabShareDOM.format===5)return;globalThis.__tabShareDOM.dispose?.();}
  const ids = new WeakMap(), nodes = new Map(), previous = new Map(), sizes=new Map(),dirty = new Set(), priority=new Set(),subtrees=new Set(), controls=new Set(), observed=new WeakSet(), listeners=[];
  const resources=new Map(), requests=[], closedRoots=new WeakMap(), extraCSS=new Map(), failedResources=new Set(),resourceUsers=new Map(),nodeAssets=new Map(),failedNodes=new Set();
  const blobDownloads=new Map(),downloadRequests=[];
  function downloadBlob(url){if(!url.startsWith('blob:'))throw Error('Unsupported download source');if(!blobDownloads.has(url)){if(blobDownloads.size>=2)blobDownloads.delete(blobDownloads.keys().next().value);const job=fetch(url).then(r=>r.blob()).then(blob=>{if(blob.size>64*1024*1024)throw Error('Download exceeds 64 MiB');return blob;});job.catch(()=>{});blobDownloads.set(url,job);}return blobDownloads.get(url);}
  listen(document,'tabshare-download',e=>{try{const value=JSON.parse(e.detail);if(typeof value.url==='string'&&value.url.length<2048&&value.url.startsWith('blob:')){downloadBlob(value.url);downloadRequests.push({url:value.url,suggestedFilename:String(value.suggestedFilename||'download').slice(0,200)});if(downloadRequests.length>4)downloadRequests.shift();mark(document.body);if(remoteInputActive)e.preventDefault();}}catch{}});
  listen(document,'click',e=>{const link=e.target.closest?.('a[download]');if(link?.href.startsWith('blob:'))try{downloadBlob(link.href);downloadRequests.push({url:link.href,suggestedFilename:link.download||'download'});if(downloadRequests.length>4)downloadRequests.shift();mark(document.body);if(remoteInputActive)e.preventDefault();}catch{};});
  let remoteInputActive=false,mode="dom", lastCSS="", widget,widgetRoot,widgetDrag,baseline,ownerViewport,rootStyleDirty=true,cssDirty=true,rootCSS='',wakeQueued=false,wakeUrgent=false,disposed=false,lastStyleChange=-Infinity;
  let next = 0, first = true, sequence = 0, truncated = false, imageBytes=0, lastControlCheck=0,lastCapture=Date.now(),rootNode,retainedBytes=0,contextMenu,imagePasteCount=0;
  const version = typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
  const properties=[];
  const currentColors=new Set(['outline-color','column-rule-color','text-decoration-color','text-emphasis-color','-webkit-text-fill-color','-webkit-text-stroke-color']);
  const followsColor=name=>currentColors.has(name)||/^border-(top|right|bottom|left|block-start|block-end|inline-start|inline-end)-color$/.test(name);
  const attributes = ['id','for','open','aria-expanded','aria-label','aria-labelledby','aria-describedby','type','placeholder','title','alt','role','colspan','rowspan','maxlength','min','max','step','size','multiple','disabled','readonly','required','name','lang','dir','popover'];
  const svgAttributes='viewBox preserveAspectRatio d x y x1 x2 y1 y2 cx cy r rx ry points width height fill stroke stroke-width clip-path mask offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod maskUnits maskContentUnits clipPathUnits patternUnits patternContentUnits patternTransform fx fy fr href pathLength textLength lengthAdjust startOffset dx dy rotate'.split(' ');
  const forbidden = new Set(['SCRIPT','STYLE','LINK','META','BASE','NOSCRIPT','TEMPLATE']);
  const unsupported = new Set(['IFRAME','FRAME','OBJECT','EMBED','CANVAS','VIDEO','AUDIO']);
  const observers = [], styleRoots=new Set(), loadedURLs=new Set(), usedFonts=new Set();
  function wake(urgent=false){
    if(disposed||typeof globalThis.__tabShareWake!=='function')return;
    wakeUrgent||=urgent;if(wakeQueued)return;wakeQueued=true;
    // Page timers can be throttled in background tabs. Signal in a microtask;
    // the extension coalesces frames and owns the network/animation budgets.
    queueMicrotask(()=>{wakeQueued=false;if(disposed)return;const priority=wakeUrgent;wakeUrgent=false;try{globalThis.__tabShareWake(JSON.stringify({version,urgent:priority}));}catch{}});
  }
  // Computed styles have no live CSS selectors in the mirror. Track state-rule
  // matches so editing a control also invalidates its labels/ancestor pseudos.
  // Only changed matches are serialized; selector work is coalesced and budgeted.
  const stateRules=new Map(),stateQueue=new Set(),controlStates=new WeakMap();let cssEpoch=0;
  function stateMask(selector){return (/:placeholder-shown\b|:(?:checked|indeterminate|valid|invalid|user-valid|user-invalid|in-range|out-of-range)\b/.test(selector)?1:0)|(/:focus(?:-within|-visible)?\b/.test(selector)?2:0)|(/:(?:hover|active)\b/.test(selector)?4:0)|(/:(?:has|empty|disabled|enabled|read-only|read-write|open|popover-open)\b/.test(selector)?8:0);}
  function invalidateState(mask){for(const rules of stateRules.values())for(const rule of rules.values())if(rule.mask&mask)stateQueue.add(rule);}
  function controlState(node){return [node.matches?.(':placeholder-shown'),node.matches?.(':empty'),node.checked,node.indeterminate,node.selectedIndex,node.validity?.valid,node.validity?.rangeUnderflow,node.validity?.rangeOverflow].join(':');}
  function checkControl(node){const state=controlState(node);if(controlStates.get(node)!==state){controlStates.set(node,state);invalidateState(1|8);}}
  function stateEvent(event){mark(event.target);if(dirty.has(event.target))priority.add(event.target);if(event.type==='input'||event.type==='change')checkControl(event.target);else if(event.type!=='scroll')invalidateState(1|2|8);if(event.target?.type==='radio')for(const n of event.target.getRootNode().querySelectorAll('input[type=radio]')){mark(n);checkControl(n);}wake(true);}
  function trackRule(selector,root){
    const mask=stateMask(selector);if(!mask)return;
    selector=selector.replace(/::(?:before|after|backdrop)\b/g,'');
    let rules=stateRules.get(root);if(!rules){rules=new Map();stateRules.set(root,rules);}
    let rule=rules.get(selector);if(!rule){let matches;try{matches=new Set(root.querySelectorAll(selector));}catch{matches=new Set();}rule={selector,root,mask,matches};rules.set(selector,rule);}rule.epoch=cssEpoch;
  }
  function refreshState(){
    const started=performance.now();
    for(const rule of stateQueue){
      stateQueue.delete(rule);let matches;
      try{matches=new Set(rule.root.querySelectorAll(rule.selector));}catch{continue;}
      for(const node of rule.matches)if(node.isConnected&&!matches.has(node))mark(node,true);
      for(const node of matches)if(!rule.matches.has(node))mark(node,true);
      rule.matches=matches;
      if(performance.now()-started>=6)break;
    }
  }
  function mark(node, subtree = false) {
    if (!node || node===widget || node.parentElement?.closest('[data-tabshare-owner-ui]')) return;
    if(node===document.documentElement||node===document.head)rootStyleDirty=true;
    // HTML/head events can affect body styles, but these ancestors must never enter the mirror tree.
    let owner=node;
    while(owner?.getRootNode?.() instanceof ShadowRoot)owner=owner.getRootNode().host;
    if(node!==document.body&&!document.body?.contains(owner)){node=document.body;subtree=true;}
    if(!node)return;
    dirty.add(node);
    if (subtree && node.querySelectorAll)subtrees.add(node);
  }
  function observe(root) {
    if(observed.has(root))return;observed.add(root);if(root instanceof ShadowRoot)styleRoots.add(root);
    const observer = new MutationObserver(records => {
      let changed=false,urgent=false;
      for (const record of records) {
        const element=record.target.nodeType===3?record.target.parentElement:record.target;
        if(element===widget||element?.closest?.('[data-tabshare-owner-ui]'))continue;
        const children=[...record.addedNodes,...record.removedNodes];
        // A title is metadata, not a reason to recapture the entire body.
        if(element?.closest?.('title')||record.type==='childList'&&children.length&&children.every(n=>n.nodeName==='TITLE')){wake(true);continue;}
        if(element?.closest?.('style,link')||children.some(n=>n.nodeType===1&&(n.matches('style,link')||n.querySelector('style,link'))))cssDirty=true;
        mark(record.target,record.type==='attributes'&&['class','style','hidden','data-empty','data-state','data-placeholder','aria-expanded'].includes(record.attributeName));changed=true;urgent||=record.type!=='attributes'||record.attributeName!=='style';
      }
      if(changed){invalidateState(15);const now=performance.now();if(!urgent){urgent=now-lastStyleChange>35;lastStyleChange=now;}wake(urgent);}
    });
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true}); observers.push(observer);
  }
  function listen(target,type,fn,capture=true){target.addEventListener(type,fn,capture);listeners.push([target,type,fn,capture]);}
  function dispose(){disposed=true;for(const o of observers)o.disconnect();for(const [target,type,fn,capture] of listeners)target.removeEventListener(type,fn,capture);dirty.clear();priority.clear();subtrees.clear();stateRules.clear();stateQueue.clear();blobDownloads.clear();downloadRequests.length=0;widgetDrag?.dispose();widget?.remove();globalThis.__tabShareDOM.disposed=true;}
  observe(document.documentElement);
  for (const type of ['input','change','scroll','focusin','focusout','toggle','beforetoggle']) listen(document,type,stateEvent);
  listen(document,'load',e=>{if(['LINK','STYLE'].includes(e.target.tagName)){cssDirty=true;rootStyleDirty=true;mark(document.body,true);}else if(['IMG','VIDEO','IFRAME'].includes(e.target.tagName)){mark(e.target.parentElement,true);for(let n=e.target.parentElement;n;n=n.parentElement)mark(n);}wake(true);});
  if(document.fonts)listen(document.fonts,'loadingdone',()=>{cssDirty=true;rootStyleDirty=true;mark(document.body,true);wake(true);});
  listen(document,'paste',e=>{if(e.clipboardData?.files.length)imagePasteCount++;});
  let contextSequence=0,contextEvent;
  listen(globalThis,'contextmenu',e=>{if(e.target===widget)return;contextEvent=e;const sequence=++contextSequence;queueMicrotask(()=>{if(contextEvent===e){contextMenu={sequence,custom:e.defaultPrevented};mark(document.body);}});});
  listen(globalThis,'contextmenu',e=>{if(contextEvent!==e)return;contextMenu={sequence:contextSequence,custom:e.defaultPrevented};contextEvent=null;e.preventDefault();mark(document.body);},false);
  listen(document,'selectionchange',()=>{mark(document.activeElement);wake(true);});
  listen(globalThis,'scroll',()=>{mark(document.body);wake(true);});
  listen(globalThis,'resize',()=>{rootStyleDirty=true;mark(document.body,true);wake(true);});
  let dprQuery;function changedDPR(){watchDPR();mark(document.body,true);}function watchDPR(){dprQuery?.removeEventListener('change',changedDPR,true);dprQuery=matchMedia('(resolution: '+devicePixelRatio+'dppx)');listen(dprQuery,'change',changedDPR);}watchDPR();
  for(const type of ['mouseover','mouseout','mousedown','mouseup'])listen(document,type,()=>{invalidateState(4);wake(true);});
  for(const type of ['transitionend','transitioncancel'])listen(document,type,e=>{mark(e.target,true);wake(true);});
  function resource(url,kind='image',base=location.href) {
    try {
      const u=new URL(url,base);if(!['http:','https:','blob:','data:'].includes(u.protocol))return '';
      const fragment=u.hash;u.hash='';
      if(u.protocol==='data:'&&/^data:image\/(png|jpeg|gif|webp|avif);base64,/.test(u.href)&&u.href.length<100000)return u.href;
      if(!resources.has(u.href)){if(resources.size>=256)return '';const id=version+'_'+resources.size;resources.set(u.href,id);requests.push({id,url:u.href,kind});}
      return 'ts-asset:'+resources.get(u.href)+fragment;
    } catch {return '';}
  }
  function rewrite(value,base=location.href,kind='image',visible=true) {
    return value.replace(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*?))\s*\)/gi,(_,a,b,c)=>{const raw=(a??b??c).replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi,(_,hex,char)=>hex?String.fromCodePoint(Math.min(0x10ffff,parseInt(hex,16))||0xfffd):char);try{const u=new URL(raw,base),here=new URL(location.href);if(u.hash&&u.origin===here.origin&&u.pathname===here.pathname&&u.search===here.search)return 'url("'+u.hash+'")';}catch{}return 'url("'+(visible?resource(raw,kind,base):'')+'")';});
  }
  function fontNames(value) {return value.split(',').map(v=>v.trim().replace(/^['"]|['"]$/g,'').toLowerCase());}
  function styleOf(computed,visible=true) {if(visible)for(const name of fontNames(computed.fontFamily))if(!usedFonts.has(name)){usedFonts.add(name);cssDirty=true;}const style={};for(const name of properties){const v=computed.getPropertyValue(name);if(v&&v!==baseline?.[name]&&!(followsColor(name)&&v===computed.color))style[name]=rewrite(v,location.href,'image',visible);}return style;}
  function readRules(list,base,out,root=document) {
    for(const rule of list){
      if(rule.selectorText)trackRule(rule.selectorText,root);
      if(rule.type===CSSRule.KEYFRAMES_RULE)out.push(rewrite(rule.cssText,base));
      else if(rule.type===CSSRule.FONT_FACE_RULE){
        if(!fontNames(rule.style.getPropertyValue('font-family')).some(name=>usedFonts.has(name)))continue;
        const sources=rule.style.getPropertyValue('src').match(/(?:url|local)\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)(?:\s*(?:format|tech)\([^)]*\))*/gi)||[];
        const usable=sources.filter(source=>{if(/^local\(/i.test(source))return true;const m=/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(source);try{return !!m&&loadedURLs.has(new URL(m[1]??m[2]??m[3],base).href);}catch{return false;}});
        if(usable.length){const descriptors=[...rule.style].filter(name=>name!=='src').map(name=>name+':'+rule.style.getPropertyValue(name));out.push('@font-face{'+descriptors.join(';')+';src:'+rewrite(usable.join(','),base,'font')+'}');}
      }
      else if(rule.cssRules)readRules(rule.cssRules,base,out,root);
    }
  }
  function addStyles(css,url) {try{const sheet=new CSSStyleSheet();sheet.replaceSync(css);extraCSS.set(url,{sheet,base:url});cssDirty=true;mark(document.body,true);wake(true);}catch{}}
  function registerShadow(host,root) {
    if(!host||host===widget||closedRoots.get(host)===root)return;
    closedRoots.set(host,root);observe(root);cssDirty=true;mark(host,true);
    for(const type of ['input','change','scroll','focusin','focusout','toggle','beforetoggle'])listen(root,type,stateEvent);
    for(const type of ['mouseover','mouseout','mousedown','mouseup'])listen(root,type,()=>{invalidateState(4);wake(true);});
    for(const type of ['transitionend','transitioncancel'])listen(root,type,e=>{mark(e.target,true);wake(true);});
  }
  function setMode(value) {
    if(value!=='dom'||mode===value)return;
    mode=value;first=true;previous.clear();sizes.clear();retainedBytes=0;truncated=false;mark(document.body,true);
    for(const radio of widget?.shadowRoot?.querySelectorAll('input')||[])radio.checked=radio.value===mode;
    updateWidget?.();
  }
  let updateWidget;
  function ownerUI() {
    widget=document.createElement('div');widget.setAttribute('data-tabshare-owner-ui','');
    widget.style.cssText='all:initial!important;position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;display:block!important';
    const root=widget.attachShadow({mode:'closed'});widgetRoot=root;
    const sheet=document.createElement('style');sheet.textContent=':host{font:14px system-ui;color:#23304a}button{font:14px system-ui;background:#335fea;color:white;border:0;border-radius:24px;padding:12px 16px;cursor:grab;user-select:none;box-shadow:0 3px 15px #0003}button:active{cursor:grabbing}.panel{position:fixed;background:white;border:1px solid #dce3ee;border-radius:14px;padding:18px;width:260px;box-sizing:border-box;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;overscroll-behavior:contain;box-shadow:0 6px 30px #0002}h3{margin:0 0 12px;font-size:16px}small{display:block;color:#64718a;line-height:1.6}';root.append(sheet);
    const section=document.createElement('section');section.className='panel';section.hidden=true;
    const heading=document.createElement('h3');heading.textContent='共享设置';
    const note=document.createElement('small');note.textContent='DOM 差异同步，复杂内容仅使用局部视频。拖拽按钮可调整位置；浏览器调试栏可随时停止共享。';section.append(heading,note);
    const toggle=document.createElement('button');toggle.type='button';toggle.textContent='共享设置';toggle.setAttribute('aria-label','共享设置');toggle.setAttribute('aria-expanded','false');root.append(section,toggle);
    const panel=root.querySelector('section'),button=root.querySelector('button');
    document.documentElement.append(widget);widgetDrag=draggable(button,panel,widget,()=>({width:Math.min(innerWidth,ownerViewport?.width||innerWidth),height:Math.min(innerHeight,ownerViewport?.height||innerHeight)}));
    button.onclick=()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));widgetDrag.reflow();};
    const probe=document.createElement('span');probe.style.cssText='all:initial!important';root.append(probe);
    const c=getComputedStyle(probe);baseline={};properties.splice(0,properties.length,...[...c].filter(name=>!name.startsWith('--')));for(const name of properties)baseline[name]=followsColor(name)?'currentcolor':c.getPropertyValue(name);probe.remove();

  }
  if(document.documentElement)ownerUI();
  function idFor(node) {if(!ids.has(node))ids.set(node,String(++next));const id=ids.get(node);nodes.set(id,node);return id;}
  function childrenOf(node) {
    const root=closedRoots.get(node)||node.shadowRoot;
    if(root){registerShadow(node,root);return [...root.childNodes];}
    if(node.tagName==='SLOT'&&node.assignedNodes().length)return node.assignedNodes();
    return node.childNodes||[];
  }
  function allowed(node) {return node.nodeType===3 || node.nodeType===1&&node!==widget&&!node.hasAttribute('data-tabshare-owner-ui')&&!forbidden.has(node.tagName.toUpperCase());}
  function difference(old, value) {
    if(!old)return value;
    const changes={};
    for(const [key,newValue] of Object.entries(value)){
      if(key==='id')continue;
      if(key==='style'||key==='attrs'){
        const delta={};for(const name of new Set([...Object.keys(old[key]||{}),...Object.keys(newValue)]))if((old[key]||{})[name]!==newValue[name])delta[name]=newValue[name]??null;
        if(Object.keys(delta).length)changes[key]=delta;
      } else if(JSON.stringify(old[key])!==JSON.stringify(newValue))changes[key]=newValue;
    }
    return Object.keys(changes).length?changes:null;
  }
  function cssAnimations() {
    cssEpoch++;cssDirty=false;
    if(rootStyleDirty){const computed=getComputedStyle(document.documentElement),names=['display','font-size','font-family','line-height','direction','writing-mode','color-scheme','background-color','color','scrollbar-width','scrollbar-color','scrollbar-gutter','zoom','position','transform','transform-origin','perspective','perspective-origin','filter','contain','isolation','padding','margin','border','box-sizing','overflow','overflow-x','overflow-y'];rootCSS=':root{'+names.map(name=>name+':'+rewrite(computed.getPropertyValue(name))).join(';')+'}';rootStyleDirty=false;}
    const rules=[rootCSS,':where([data-node-id]),:where([data-node-id])::before,:where([data-node-id])::after,:where([data-node-id])::backdrop{'+Object.entries(baseline||{}).filter(([,v])=>v).map(([k,v])=>k+':'+v).join(';')+'}'];
    for(const root of [...styleRoots])if(!root.host.isConnected)styleRoots.delete(root);
    for(const root of [document,...styleRoots])for(const sheet of [...root.styleSheets,...root.adoptedStyleSheets]){try{readRules(sheet.cssRules,sheet.href||location.href,rules,root);}catch{}}
    for(const item of extraCSS.values())readRules(item.sheet.cssRules,item.base,rules);
    for(const [root,items] of stateRules){for(const [selector,rule] of items)if(rule.epoch!==cssEpoch){items.delete(selector);stateQueue.delete(rule);}if(!items.size)stateRules.delete(root);}
    return rules.join('\n').slice(0,100000);
  }
  function capture() {
    lastCapture=Date.now();
    if(!document.body)return null;
    if(rootNode!==document.body){rootNode=document.body;first=true;previous.clear();sizes.clear();nodeAssets.clear();resourceUsers.clear();failedNodes.clear();retainedBytes=0;dirty.clear();priority.clear();subtrees.clear();truncated=false;}
    if(first){dirty.add(document.body);subtrees.add(document.body);}
    if(Date.now()-lastControlCheck>1000){
      lastControlCheck=Date.now();
      for(const node of controls){if(!node.isConnected){controls.delete(node);continue;}const old=previous.get(ids.get(node));const value=node.type==='password'?'':String(node.value).slice(0,16000);if(old&&(old.value!==value||old.checked!==!!node.checked||old.selectedIndex!==(node.selectedIndex??null))){mark(node);checkControl(node);}}
    }
    refreshState();
    const meta={width:innerWidth,height:innerHeight,scrollX,scrollY,url:location.href,title:document.title,truncated,mode,devicePixelRatio,contextMenu,caret:caretPosition(document,node=>closedRoots.get(node),widgetRoot),selection:selectionState(document,node=>closedRoots.get(node)),pending:dirty.size>0};
    const hadWork=dirty.size>0, fresh=[],updates=[],removes=[];
    let count=0,packetBytes=0;const started=performance.now();
    // Shallow nodes make capture resumable: expensive trees never monopolize the tab.
    while(dirty.size){
      const node=(priority.size?priority:dirty).values().next().value;priority.delete(node);
      dirty.delete(node);const deep=subtrees.delete(node);
      if(!node.isConnected||!allowed(node)||node===document.documentElement||node===document.head)continue;
      const id=idFor(node),old=previous.get(id);
      if(!old&&previous.size>=30000){truncated=true;continue;}
      let value;
      if(node.nodeType===3)value={id,tag:'#text',text:node.textContent.slice(0,16000)};
      else{
        const computed=getComputedStyle(node),visible=node.checkVisibility({checkVisibilityCSS:true}),style=styleOf(computed,visible),attrs={};
        for(const [name,v] of Object.entries(style))if(v===baseline?.[name])delete style[name];
        for(const name of attributes)if(node.hasAttribute(name))attrs[name]=node.getAttribute(name).slice(0,1000);
        value={id,tag:node.localName,style,attrs,children:[],scrollTop:node.scrollTop,scrollLeft:node.scrollLeft};
        if(node.namespaceURI==='http://www.w3.org/2000/svg'){
          value.ns='svg';for(const name of svgAttributes)if(node.hasAttribute(name)&&name!=='href')attrs[name]=node.getAttribute(name).slice(0,16000);
          const href=node.href?.baseVal;if(href&&['use','linearGradient','radialGradient','pattern'].includes(node.localName))attrs.href=href.startsWith('#')?href:resource(href);
        }
        if(unsupported.has(node.tagName)||node.localName==='svg'&&node.querySelector('foreignObject,filter,image')){value.tag='div';delete value.ns;if(computed.display==='inline')style.display='inline-block';value.unsupported=node.localName;}
        else{
          if(node.tagName==='A')try{const href=new URL(node.href);if(['http:','https:'].includes(href.protocol))value.href=href.href.slice(0,8192);}catch{}
          if(node.tagName==='IMG'){attrs.src=visible?resource(node.currentSrc||node.src):'';if(failedNodes.has(id)){value.tag='div';value.unsupported='image';}}
          if(['INPUT','TEXTAREA','SELECT'].includes(node.tagName)){controls.add(node);controlStates.set(node,controlState(node));value.value=node.type==='password'?'':String(node.value).slice(0,16000);value.checked=!!node.checked;value.selectedIndex=node.selectedIndex??null;if(typeof node.selectionStart==='number'&&node===node.getRootNode().activeElement)value.caret={start:node.selectionStart,end:node.selectionEnd};}
          if(node.tagName==='OPTION'){attrs.value=node.value;value.selected=!!node.selected;}
          if(node.isContentEditable&&node.hasAttribute('contenteditable'))value.editable=true;
          value.pseudos={};for(const pseudo of ['::before','::after','::backdrop']){const c=getComputedStyle(node,pseudo);if(pseudo==='::backdrop'&&node.tagName==='DIALOG'||c.content&&!['none','normal'].includes(c.content))value.pseudos[pseudo]={...styleOf(c,visible),content:rewrite(c.content,location.href,'image',visible)};}
          if(node.tagName==='DIALOG')value.modal=node.matches(':modal');
          if(node.hasAttribute('popover'))value.popoverOpen=node.matches(':popover-open');
          for(const child of childrenOf(node)){
            if(!allowed(child))continue;
            if(!ids.has(child)&&nodes.size>=30000){truncated=true;break;}
            const childId=idFor(child);value.children.push(childId);
            if(deep||!previous.has(childId)){dirty.add(child);if(deep)subtrees.add(child);}
          }
        }
      }
      const encoded=JSON.stringify(value),bytes=new TextEncoder().encode(encoded).byteLength,candidate=retainedBytes-(sizes.get(id)||0)+bytes;
      if(candidate>5500000){truncated=true;continue;}
      retainedBytes=candidate;sizes.set(id,bytes);previous.set(id,value);
      for(const asset of nodeAssets.get(id)||[])resourceUsers.get(asset)?.delete(id);
      const assets=new Set(encoded.match(/ts-asset:[A-Za-z0-9_-]+/g)?.map(v=>v.slice(9))||[]);nodeAssets.set(id,assets);failedNodes.delete(id);
      for(const asset of assets){if(!resourceUsers.has(asset))resourceUsers.set(asset,new Set());resourceUsers.get(asset).add(id);if(failedResources.has(asset))failedNodes.add(id);}
      const changes=difference(old,value);if(!old){fresh.push({...value});packetBytes+=bytes;}else if(changes){updates.push({id,changes});packetBytes+=JSON.stringify(changes).length;}
      if(++count>=300||packetBytes>=160000||performance.now()-started>=24)break;
    }
    if(hadWork)for(const [id,node] of nodes)if(!node.isConnected){nodes.delete(id);for(const asset of nodeAssets.get(id)||[]){const users=resourceUsers.get(asset);users?.delete(id);if(!users?.size)resourceUsers.delete(asset);}nodeAssets.delete(id);failedNodes.delete(id);if(previous.delete(id)){removes.push(id);retainedBytes-=sizes.get(id)||0;sizes.delete(id);controls.delete(node);}}
    meta.truncated=truncated;
    const result={version,sequence:sequence+1,reset:first,root:idFor(document.body),nodes:fresh,updates,removes,meta};
    if(hadWork)for(const root of styleRoots)if(!root.host.isConnected){cssDirty=true;break;}
    if(first||cssDirty||rootStyleDirty){const css=cssAnimations();if(first||css!==lastCSS){result.css=css;result.cssChanged=true;lastCSS=css;}}
    meta.pending=dirty.size>0||stateQueue.size>0;
    if(requests.length)result.resources=requests.splice(0);
    if(downloadRequests.length)result.downloads=downloadRequests.splice(0);
    first=false;
    if(!fresh.length&&!updates.length&&!removes.length&&!result.cssChanged&&!result.resources?.length&&!result.downloads?.length&&JSON.stringify(meta)===globalThis.__tabShareLastMeta)return null;
    sequence++;globalThis.__tabShareLastMeta=JSON.stringify(meta);
    // Pool repeated computed styles inside this packet. References are local to
    // the packet, so late joins, navigation and independent transports need no cache negotiation.
    const pool=new Map();
    for(const value of [...fresh,...updates.map(u=>u.changes)])if(value.style){const key=JSON.stringify(value.style);if(key.length<96)continue;let entry=pool.get(key);if(!entry){entry=[];pool.set(key,entry);}entry.push(value);}
    const styles=[];for(const entries of pool.values())if(entries.length>1){const index=styles.length;styles.push(entries[0].style);for(const value of entries){delete value.style;value.styleRef=index;}}
    if(styles.length)result.styles=styles;
    return result;
  }
  function limit(){globalThis.__tabShareDOM.reset();}
  function act(input) {
    if(input.version&&input.version!==version)return {stale:true};
    if(input.action==='mode'){setMode(input.mode);return;}
    if(input.selection){
      const v=input.selection,editable=nodes.get(input.nodeId);
      if(editable?.isContentEditable){const a=nodes.get(v.anchor),f=nodes.get(v.focus);if(a&&f&&editable.contains(a)&&editable.contains(f)){editable.focus({preventScroll:true});getSelection().setBaseAndExtent(a,Math.min(v.anchorOffset,a.nodeType===3?a.length:a.childNodes.length),f,Math.min(v.focusOffset,f.nodeType===3?f.length:f.childNodes.length));}}
      else if(['INPUT','TEXTAREA'].includes(editable?.tagName)){editable.focus({preventScroll:true});try{editable.setSelectionRange(v.start,v.end);}catch{}}
      if(input.action==='selection')return;
    }
    if(input.action==='scroll'&&input.nodeId==='root'){const root=document.scrollingElement;root.scrollLeft=input.scrollLeft||0;root.scrollTop=input.scrollTop||0;mark(document.body);return;}
    if(input.action==='focus'&&!input.nodeId)return {mac:/Mac/.test(navigator.platform)};
    const node=nodes.get(input.nodeId);
    if(!node||!node.isConnected||node.nodeType!==1)throw new Error('页面已变化，请等待同步后重试');
    if(input.action==='focus'){node.focus({preventScroll:true});return {mac:/Mac/.test(navigator.platform)};}
    if(input.action==='pasteImage'){
      node.focus({preventScroll:true});const bytes=Uint8Array.from(atob(input.data),c=>c.charCodeAt(0)),file=new File([bytes],input.name||'clipboard.png',{type:input.mime}),data=new DataTransfer();data.items.add(file);
      const consumed=!node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true,composed:true}));
      const inserted=!consumed&&node.isContentEditable&&document.execCommand('insertImage',false,'data:'+input.mime+';base64,'+input.data);
      mark(node,true);return {accepted:consumed||!!inserted};
    }
    if(input.action==='scroll'){node.scrollTo(input.scrollLeft||0,input.scrollTop||0);mark(node);return;}
    if(input.action==='selectFinish'){if(node.tagName==='SELECT'&&node.value!==input.text){node.value=input.text;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));mark(node);}return;}
    if(input.action==='select'){
      if(node.tagName!=='SELECT')throw new Error('不是选择框');
      node.focus({preventScroll:true});
      if(!node.multiple){
        const target=[...node.options].findIndex(o=>o.value===input.text&&!o.disabled);
        if(target<0)return;
        const before=[...node.options].findLastIndex((o,i)=>i<target&&!o.disabled),after=[...node.options].findIndex((o,i)=>i>target&&!o.disabled);
        if(before>=0||after>=0){node.selectedIndex=before>=0?before:after;mark(node);return {key:before>=0?'ArrowDown':'ArrowUp',code:before>=0?'ArrowDown':'ArrowUp',keyCode:before>=0?40:38};}
        node.selectedIndex=target;
      }else for(const option of node.options)option.selected=(input.values||[input.text]).includes(option.value);
      node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));mark(node);return;
    }
    let r=node.getBoundingClientRect();
    if(input.action==='mousePressed'&&(r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight)){node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});r=node.getBoundingClientRect();}
    const link=node.closest('a[download]');
    return {x:Math.max(0,Math.min(innerWidth-1,r.left+r.width*(input.x??.5))),y:Math.max(0,Math.min(innerHeight-1,r.top+r.height*(input.y??.5))),...(link?{download:{url:link.href,name:link.download}}:{})};
  }
  function fallback() {
    const regions=[];
    for(const [id,node] of nodes){
      if(node.nodeType!==1||!node.isConnected||!previous.has(id))continue;
      const failed=failedNodes.has(id)&&(node.tagName==='IMG'||!node.children.length);
      if(!previous.get(id).unsupported&&!failed||!node.checkVisibility({checkVisibilityCSS:true}))continue;
      const r=node.getBoundingClientRect();let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
      for(let parent=node.parentElement;parent;parent=parent.parentElement){const c=getComputedStyle(parent),p=parent.getBoundingClientRect();if(['hidden','clip','scroll','auto'].includes(c.overflowX)){left=Math.max(left,p.left+parent.clientLeft);right=Math.min(right,p.left+parent.clientLeft+parent.clientWidth);}if(['hidden','clip','scroll','auto'].includes(c.overflowY)){top=Math.max(top,p.top+parent.clientTop);bottom=Math.min(bottom,p.top+parent.clientTop+parent.clientHeight);}}
      if(right-left<1||bottom-top<1)continue;
      const scaleX=r.width/(node.offsetWidth||r.width),scaleY=r.height/(node.offsetHeight||r.height);
      const region={id,styleWidth:(right-left)/scaleX,styleHeight:(bottom-top)/scaleY,x:left+scrollX,y:top+scrollY,width:right-left,height:bottom-top,offsetX:(left-r.left)/scaleX-node.clientLeft,offsetY:(top-r.top)/scaleY-node.clientTop,cuts:[]},occluders=new Set();
      // Occlusion is masked in the regional pixels; the corresponding DOM stays above it.
      for(const [x,y] of [[.5,.5],[.05,.05],[.95,.05],[.05,.95],[.95,.95]]){
        const hit=document.elementFromPoint(left+region.width*x,top+region.height*y);
        if(hit&&hit!==node&&!node.contains(hit))occluders.add(hit);
      }
      if(widget)occluders.add(widget);const ownerPanel=widgetRoot?.querySelector('section:not([hidden])');if(ownerPanel)occluders.add(ownerPanel);
      for(const hit of occluders){const c=hit.getBoundingClientRect(),x=Math.max(left,c.left),y=Math.max(top,c.top),w=Math.min(right,c.right)-x,h=Math.min(bottom,c.bottom)-y;if(w>0&&h>0)region.cuts.push({x:x-left,y:y-top,width:w,height:h});}
      regions.push(region);if(regions.length>=32)break;
    }
    return {mode:'dom',full:false,regions,width:innerWidth,height:innerHeight};
  }
  async function cropFrame(data,info){
    const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'})),images=[];
    try{const sx=image.width/info.width,sy=image.height/info.height;let total=0;
      for(const r of info.regions){
        const canvas=new OffscreenCanvas(Math.max(1,Math.round(r.width*sx)),Math.max(1,Math.round(r.height*sy)));
        canvas.getContext('2d',{alpha:false}).drawImage(image,(r.x-info.scrollX)*sx,(r.y-info.scrollY)*sy,r.width*sx,r.height*sy,0,0,canvas.width,canvas.height);
        let encoded='';for(const quality of [.65,.4,.15,.05]){const blob=await canvas.convertToBlob({type:'image/jpeg',quality}),result=new Uint8Array(await blob.arrayBuffer());let raw='';for(let i=0;i<result.length;i+=4096)raw+=String.fromCharCode(...result.subarray(i,i+4096));encoded=btoa(raw);if(encoded.length<2*1024*1024)break;}
        if(encoded.length>=2*1024*1024||total+encoded.length>4*1024*1024)break;
        total+=encoded.length;images.push({id:r.id,data:encoded});
      }
      return images;
    }finally{image.close();}
  }
  globalThis.__tabShareDOM={format:5,cropFrame,async downloadPart(url,offset){const blob=await downloadBlob(url),bytes=new Uint8Array(await blob.slice(offset,offset+262144).arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=4096)raw+=String.fromCharCode(...bytes.subarray(i,i+4096));return {data:btoa(raw),size:blob.size,mime:blob.type};},downloadDone(url){blobDownloads.delete(url);},ownerInput(suppressed){remoteInputActive=suppressed;if(suppressed)widget?.style.setProperty('pointer-events','none','important');else widget?.style.removeProperty('pointer-events');},async writeClipboardImage(input){
    try{const bytes=Uint8Array.from(atob(input.data),c=>c.charCodeAt(0));let blob=new Blob([bytes],{type:input.mime});if(input.mime!=='image/png'){const image=await createImageBitmap(blob);if(image.width*image.height>16777216){image.close();return false;}const canvas=new OffscreenCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);image.close();blob=await canvas.convertToBlob({type:'image/png'});}await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);return true;}catch{return false;}
  },get imagePasteCount(){return imagePasteCount;},ownerViewport(value){ownerViewport=value;widgetDrag?.resize();},capture,act,fallback,dispose,registerShadow,addStyles,setMode,limit,loadedResources(urls){let changed=false;for(const url of urls)if(!loadedURLs.has(url)){loadedURLs.add(url);changed=true;}if(changed){cssDirty=true;mark(document.body);wake(true);}},invalidate(){rootStyleDirty=true;cssDirty=true;mark(document.body,true);wake(true);},resourceFailed(id){failedResources.add(id);for(const nodeId of resourceUsers.get(id)||[]){failedNodes.add(nodeId);mark(nodes.get(nodeId));}},disposed:false,reset(){widget?.style.removeProperty('pointer-events');first=true;previous.clear();sizes.clear();retainedBytes=0;nodeAssets.clear();resourceUsers.clear();failedNodes.clear();truncated=false;dirty.clear();priority.clear();subtrees.clear();lastCapture=Date.now();}};
}
export const installDOM = '(' + bootstrap.toString() + ')('+draggable.toString()+','+caretPosition.toString()+','+selectionState.toString()+')';
export const captureDOM = 'globalThis.__tabShareDOM.capture()';
