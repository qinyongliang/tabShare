// The code below runs only in an isolated world of the explicitly shared tab.
function bootstrap() {
  if (globalThis.__tabShareDOM && !globalThis.__tabShareDOM.disposed) return;
  const ids = new WeakMap(), nodes = new Map(), previous = new Map(), sizes=new Map(),dirty = new Set(), subtrees=new Set(), controls=new Set(), observed=new WeakSet(), listeners=[];
  const resources=new Map(), requests=[], closedRoots=new WeakMap(), extraCSS=new Map(), failedResources=new Set();
  let mode="dom", lastCSS="", widget;
  let next = 0, first = true, sequence = 0, truncated = false, imageBytes=0, lastControlCheck=0,lastCapture=Date.now(),rootNode,retainedBytes=0;
  const version = crypto.randomUUID();
  const properties = ['display','position','top','right','bottom','left','box-sizing','width','height','min-width','min-height','max-width','max-height','margin','padding','border','border-radius','background-color','color','opacity','font','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','text-transform','white-space','word-break','overflow-wrap','vertical-align','flex','flex-direction','flex-wrap','align-items','align-content','justify-content','gap','row-gap','column-gap','grid-template-columns','grid-template-rows','grid-column','grid-row','list-style','box-shadow','text-shadow','transform','transform-origin','overflow','overflow-x','overflow-y','z-index','visibility','cursor','object-fit','object-position','appearance','outline','float','clear','table-layout','border-collapse','border-spacing','animation','animation-name','animation-duration','animation-delay','animation-timing-function','animation-iteration-count','animation-direction','animation-fill-mode','transition','background-image','background-size','background-position','background-repeat','background-clip','background-origin','background-attachment','border-top','border-right','border-bottom','border-left','padding-top','padding-right','padding-bottom','padding-left','margin-top','margin-right','margin-bottom','margin-left','text-indent','text-overflow','direction','writing-mode','word-spacing','font-feature-settings','font-variation-settings','filter','clip-path','isolation','mix-blend-mode','list-style-position','list-style-type','list-style-image','counter-increment','counter-reset'];
  const attributes = ['id','for','open','aria-expanded','aria-label','aria-labelledby','aria-describedby','type','placeholder','title','alt','role','colspan','rowspan','maxlength','min','max','step','size','multiple','disabled','readonly','required','name','lang','dir','popover'];
  const forbidden = new Set(['SCRIPT','STYLE','LINK','META','BASE','NOSCRIPT','TEMPLATE']);
  const unsupported = new Set(['IFRAME','FRAME','OBJECT','EMBED','CANVAS','VIDEO','AUDIO','SVG']);
  const observers = [], styleRoots=new Set();
  function mark(node, subtree = false) {
    if (!node || node===widget || node.parentElement?.closest('[data-tabshare-owner-ui]')) return;
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
      for (const record of records) mark(record.type === 'childList' ? record.target : record.target, record.type === 'attributes' && ['class','style','hidden'].includes(record.attributeName));
    });
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true}); observers.push(observer);
  }
  function listen(target,type,fn){target.addEventListener(type,fn,true);listeners.push([target,type,fn]);}
  function dispose(){for(const o of observers)o.disconnect();for(const [target,type,fn] of listeners)target.removeEventListener(type,fn,true);dirty.clear();subtrees.clear();widget?.remove();globalThis.__tabShareDOM.disposed=true;}
  observe(document.documentElement);
  for (const type of ['input','change','scroll','focusin','focusout','toggle','beforetoggle']) listen(document,type,event => {
    mark(event.target);
    if (event.target?.type === 'radio') for (const n of document.querySelectorAll('input[type=radio]')) mark(n);
  });
  listen(document,'selectionchange',()=>mark(document.activeElement));
  listen(globalThis,'scroll',()=>mark(document.body));
  listen(globalThis,'resize',()=>mark(document.body,true));
  let dprQuery;function changedDPR(){watchDPR();mark(document.body,true);}function watchDPR(){dprQuery?.removeEventListener('change',changedDPR,true);dprQuery=matchMedia('(resolution: '+devicePixelRatio+'dppx)');listen(dprQuery,'change',changedDPR);}watchDPR();
  for(const type of ['mouseover','mouseout'])listen(document,type,event=>mark(event.target.parentElement===document.body?event.target:event.target.parentElement,true));
  function resource(url,kind='image',base=location.href) {
    try {
      const u=new URL(url,base);if(!['http:','https:','blob:','data:'].includes(u.protocol))return '';
      if(u.protocol==='data:'&&/^data:image\/(png|jpeg|gif|webp|avif);base64,/.test(u.href)&&u.href.length<100000)return u.href;
      if(!resources.has(u.href)){if(resources.size>=256)return '';const id=version+'_'+resources.size;resources.set(u.href,id);requests.push({id,url:u.href,kind});}
      return 'ts-asset:'+resources.get(u.href);
    } catch {return '';}
  }
  function rewrite(value,base=location.href,kind='image') {
    return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,(_,a,b,c)=>'url("'+resource(a??b??c,kind,base)+'")');
  }
  function styleOf(computed) {const style={};for(const name of properties){const v=computed.getPropertyValue(name);if(v)style[name]=rewrite(v);}return style;}
  function readRules(list,base,out) {
    for(const rule of list){
      if(rule.type===CSSRule.KEYFRAMES_RULE)out.push(rewrite(rule.cssText,base));
      else if(rule.type===CSSRule.FONT_FACE_RULE)out.push(rewrite(rule.cssText,base,'font'));
      else if(rule.cssRules)readRules(rule.cssRules,base,out);
    }
  }
  function addStyles(css,url) {try{const sheet=new CSSStyleSheet();sheet.replaceSync(css);const rules=[];readRules(sheet.cssRules,url,rules);extraCSS.set(url,rules.join('\n'));mark(document.body,true);}catch{}}
  function registerShadow(host,root) {
    if(!host||host===widget||closedRoots.get(host)===root)return;
    closedRoots.set(host,root);observe(root);mark(host,true);
    for(const type of ['input','change','scroll','focusin','focusout','toggle','beforetoggle'])listen(root,type,e=>mark(e.target));
  }
  function setMode(value) {
    if(!['dom','raster'].includes(value)||mode===value)return;
    mode=value;first=true;previous.clear();sizes.clear();retainedBytes=0;truncated=false;mark(document.body,true);
    for(const radio of widget?.shadowRoot?.querySelectorAll('input')||[])radio.checked=radio.value===mode;
    updateWidget?.();
  }
  let updateWidget;
  function ownerUI() {
    widget=document.createElement('div');widget.setAttribute('data-tabshare-owner-ui','');
    widget.style.cssText='all:initial!important;position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;display:block!important';
    const root=widget.attachShadow({mode:'closed'});
    root.innerHTML=`<style>:host{font:14px system-ui;color:#23304a}button{font:inherit;background:#335fea;color:white;border:0;border-radius:24px;padding:12px 16px;cursor:pointer;box-shadow:0 3px 15px #0003}.panel{background:white;border:1px solid #dce3ee;border-radius:14px;padding:18px;width:260px;max-width:calc(100vw - 40px);max-height:calc(100dvh - 100px);overflow:auto;overscroll-behavior:contain;margin-bottom:10px;box-shadow:0 6px 30px #0002}h3{margin:0 0 12px;font-size:16px}label{display:block;margin:12px 0;cursor:pointer}small{display:block;color:#64718a;line-height:1.6}input{accent-color:#335fea}</style><section class="panel" hidden><h3>TabShare 共享设置</h3><label><input type="radio" name="mode" value="dom"> 本地模式（DOM 同步）</label><label><input type="radio" name="mode" value="raster"> 远程模式（WebRTC 视频）</label><small>所有访客同步切换，保留当前标签页与登录状态。DOM 模式会自动对复杂区域使用画面降级。</small></section><button type="button" aria-label="TabShare 共享设置">TS 共享设置</button>`;
    const panel=root.querySelector('section');root.querySelector('button').onclick=()=>panel.hidden=!panel.hidden;
    for(const radio of root.querySelectorAll('input'))radio.onchange=()=>setMode(radio.value);
    updateWidget=()=>{for(const radio of root.querySelectorAll('input'))radio.checked=radio.value===mode;};updateWidget();
    document.documentElement.append(widget);
  }
  if(document.documentElement)ownerUI();
  function idFor(node) {if(!ids.has(node))ids.set(node,String(++next));const id=ids.get(node);nodes.set(id,node);return id;}
  function childrenOf(node) {
    const root=closedRoots.get(node)||node.shadowRoot;
    if(root){registerShadow(node,root);return [...root.childNodes];}
    if(node.tagName==='SLOT'&&node.assignedNodes().length)return node.assignedNodes();
    return node.childNodes||[];
  }
  function allowed(node) {return node.nodeType===3 || node.nodeType===1&&node!==widget&&!node.hasAttribute('data-tabshare-owner-ui')&&!forbidden.has(node.tagName);}
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
    const rules=[];
    for(const root of [...styleRoots])if(!root.host.isConnected)styleRoots.delete(root);
    const sheets=[...document.styleSheets,...document.adoptedStyleSheets];for(const root of styleRoots)sheets.push(...root.styleSheets,...root.adoptedStyleSheets);
    for(const sheet of sheets){try{readRules(sheet.cssRules,sheet.href||location.href,rules);}catch{}}
    for(const css of extraCSS.values())rules.push(css);
    return rules.join('\n').slice(0,100000);
  }
  function capture(pixelsOnly=false) {
    lastCapture=Date.now();
    if(!document.body)return null;
    if(pixelsOnly&&mode==='raster'){
      dirty.clear();subtrees.clear();const meta={width:innerWidth,height:innerHeight,scrollX,scrollY,url:location.href,title:document.title,truncated,mode,devicePixelRatio};
      if(!first&&JSON.stringify(meta)===globalThis.__tabShareLastMeta)return null;globalThis.__tabShareLastMeta=JSON.stringify(meta);
      const root=idFor(document.body),result={version,sequence:++sequence,reset:first,root,nodes:first?[{id:root,tag:'body',children:[],style:{margin:'0px'},attrs:{}}]:[],updates:[],removes:[],meta};first=false;return result;
    }
    if(rootNode!==document.body){rootNode=document.body;first=true;previous.clear();sizes.clear();retainedBytes=0;dirty.clear();subtrees.clear();}
    for(const root of subtrees){const stack=[...childrenOf(root)];while(stack.length&&dirty.size<3500){const child=stack.pop();if(!allowed(child))continue;dirty.add(child);if(child.nodeType===1)stack.push(...childrenOf(child));}}subtrees.clear();
    if(Date.now()-lastControlCheck>1000){
      lastControlCheck=Date.now();
      for(const node of controls){if(!node.isConnected){controls.delete(node);continue;}const old=previous.get(ids.get(node));const value=node.type==='password'?'':String(node.value).slice(0,16000);if(old&&(old.value!==value||old.checked!==!!node.checked||old.selectedIndex!==(node.selectedIndex??null)))mark(node);}
    }
    if(!first&&!dirty.size)return null;
    const fresh=[],updates=[],removes=[];
    function encode(node) {
      if(!allowed(node))return;
      if(node===document.documentElement||node===document.head)return;
      const id=idFor(node);
      if(!previous.has(id)&&previous.size>=3500){truncated=true;return;}
      let value;
      if(node.nodeType===3)value={id,tag:'#text',text:node.textContent.slice(0,16000)};
      else{
        const computed=getComputedStyle(node),style=styleOf(computed),attrs={};
        for(const name of attributes)if(node.hasAttribute(name))attrs[name]=node.getAttribute(name).slice(0,1000);
        value={id,tag:node.tagName.toLowerCase(),style,attrs,children:[],scrollTop:node.scrollTop,scrollLeft:node.scrollLeft};
        if(unsupported.has(node.tagName)){value.tag='div';if(computed.display==='inline')style.display='inline-block';value.unsupported=node.tagName.toLowerCase();value.text='此 '+value.unsupported+' 内容暂不支持 DOM 共享';}
        else{
          if(node.tagName==='IMG'){attrs.src=resource(node.currentSrc||node.src);}
          if(['INPUT','TEXTAREA','SELECT'].includes(node.tagName)){controls.add(node);value.value=node.type==='password'?'':String(node.value).slice(0,16000);value.checked=!!node.checked;value.selectedIndex=node.selectedIndex??null;if(typeof node.selectionStart==='number'&&node===node.getRootNode().activeElement)value.caret={start:node.selectionStart,end:node.selectionEnd};}
          if(node.tagName==='OPTION'){attrs.value=node.value;value.selected=!!node.selected;}
          if(node.isContentEditable&&node.hasAttribute("contenteditable"))value.editable=true;
          value.pseudos={};for(const pseudo of ['::before','::after','::backdrop']){const c=getComputedStyle(node,pseudo);if(pseudo==='::backdrop'&&node.tagName==='DIALOG'||c.content&&!['none','normal'].includes(c.content))value.pseudos[pseudo]={...styleOf(c),content:rewrite(c.content)};}
          if(node.tagName==='DIALOG')value.modal=node.matches(':modal');
          if(node.hasAttribute('popover'))value.popoverOpen=node.matches(':popover-open');
          for(const child of childrenOf(node)){
            if(!allowed(child))continue;
            const childId=idFor(child);
            if(!previous.has(childId))encode(child);
            if(previous.has(childId))value.children.push(childId);
          }
        }
      }
      const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;
      const candidate=retainedBytes-(sizes.get(id)||0)+bytes;
      if(node!==document.body&&candidate>3000000){truncated=true;return;}
      retainedBytes=candidate;sizes.set(id,bytes);
      const old=previous.get(id),changes=difference(old,value);previous.set(id,value);
      if(!old)fresh.push(value);else if(changes)updates.push({id,changes});
    }
    if(first)encode(document.body);else for(const node of dirty)if(node.isConnected)encode(node);
    dirty.clear();
    for(const [id,node] of nodes)if(!node.isConnected){nodes.delete(id);if(previous.delete(id)){removes.push(id);retainedBytes-=sizes.get(id)||0;sizes.delete(id);}}
    const meta={width:innerWidth,height:innerHeight,scrollX,scrollY,url:location.href,title:document.title,truncated,mode,devicePixelRatio};
    const result={version,sequence:++sequence,reset:first,root:idFor(document.body),nodes:fresh,updates,removes,meta};
    const css=cssAnimations();if(first||css!==lastCSS){result.css=css;lastCSS=css;}
    if(requests.length)result.resources=requests.splice(0);
    first=false;
    // No idle packets or polling of animation styles: only mutations and state changes cause deltas.
    if(!fresh.length&&!updates.length&&!removes.length&&JSON.stringify(meta)===globalThis.__tabShareLastMeta)return null;
    globalThis.__tabShareLastMeta=JSON.stringify(meta);return result;
  }
  function act(input) {
    if(input.action==='mode'){setMode(input.mode);return;}
    if(input.selection){
      const v=input.selection,editable=nodes.get(input.nodeId);
      if(editable?.isContentEditable){const a=nodes.get(v.anchor),f=nodes.get(v.focus);if(a&&f&&editable.contains(a)&&editable.contains(f)){editable.focus({preventScroll:true});getSelection().setBaseAndExtent(a,Math.min(v.anchorOffset,a.nodeType===3?a.length:a.childNodes.length),f,Math.min(v.focusOffset,f.nodeType===3?f.length:f.childNodes.length));}}
      else if(['INPUT','TEXTAREA'].includes(editable?.tagName)){editable.focus({preventScroll:true});try{editable.setSelectionRange(v.start,v.end);}catch{}}
      if(input.action==='selection')return;
    }
    if(input.action==='scroll'&&input.nodeId==='root'){const root=document.scrollingElement;root.scrollLeft=input.scrollLeft||0;root.scrollTop=input.scrollTop||0;mark(document.body);return;}
    const node=nodes.get(input.nodeId);
    if(!node||!node.isConnected||node.nodeType!==1)throw new Error('页面已变化，请等待同步后重试');
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
    const r=node.getBoundingClientRect();
    return {x:Math.max(0,Math.min(innerWidth-1,r.left+r.width*(input.x??.5))),y:Math.max(0,Math.min(innerHeight-1,r.top+r.height*(input.y??.5)))};
  }
  function fallback() {
    if(mode==='raster'||truncated||failedResources.size)return {mode,full:true,width:innerWidth,height:innerHeight};
    const regions=[];
    for(const [id,node] of nodes){
      if(node.nodeType!==1||!unsupported.has(node.tagName)||getComputedStyle(node).display==='none')continue;
      const r=node.getBoundingClientRect();
      if(r.width<1||r.height<1||r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight)continue;
      if(r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return {full:true,width:innerWidth,height:innerHeight};
      for(const [x,y] of [[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]]){
        const hit=document.elementFromPoint(r.left+r.width*x,r.top+r.height*y);
        if(hit&&hit!==node&&!node.contains(hit))return {full:true,width:innerWidth,height:innerHeight};
      }
      regions.push({id,x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height});
      if(regions.length>4)return {full:true,width:innerWidth,height:innerHeight};
    }
    return {mode,full:false,regions,width:innerWidth,height:innerHeight};
  }
  globalThis.__tabShareDOM={capture,act,fallback,dispose,registerShadow,addStyles,setMode,invalidate(){mark(document.body,true);},resourceFailed(id){failedResources.add(id);},disposed:false,reset(){first=true;previous.clear();sizes.clear();retainedBytes=0;truncated=false;dirty.clear();subtrees.clear();lastCapture=Date.now();}};
}
export const installDOM = '(' + bootstrap.toString() + ')()';
export const captureDOM = 'globalThis.__tabShareDOM.capture()';
