// The code below runs only in an isolated world of the explicitly shared tab.
function bootstrap() {
  if (globalThis.__tabShareDOM && !globalThis.__tabShareDOM.disposed) return;
  const ids = new WeakMap(), nodes = new Map(), previous = new Map(), sizes=new Map(),dirty = new Set(), subtrees=new Set(), controls=new Set(), observed=new WeakSet(), listeners=[];
  const images = new Map(), consumers = new Map();
  let next = 0, first = true, sequence = 0, truncated = false, imageBytes=0, lastControlCheck=0,lastCapture=Date.now(),rootNode,retainedBytes=0;
  const version = crypto.randomUUID();
  const properties = ['display','position','top','right','bottom','left','box-sizing','width','height','min-width','min-height','max-width','max-height','margin','padding','border','border-radius','background-color','color','opacity','font','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','text-transform','white-space','word-break','overflow-wrap','vertical-align','flex','flex-direction','flex-wrap','align-items','align-content','justify-content','gap','row-gap','column-gap','grid-template-columns','grid-template-rows','grid-column','grid-row','list-style','box-shadow','text-shadow','transform','transform-origin','overflow','overflow-x','overflow-y','z-index','visibility','cursor','object-fit','object-position','appearance','outline','float','clear','table-layout','border-collapse','border-spacing','animation','animation-name','animation-duration','animation-delay','animation-timing-function','animation-iteration-count','animation-direction','animation-fill-mode','transition'];
  const attributes = ['id','for','open','aria-expanded','aria-label','aria-labelledby','aria-describedby','type','placeholder','title','alt','role','colspan','rowspan','maxlength','min','max','step','size','multiple','disabled','readonly','required','name'];
  const forbidden = new Set(['SCRIPT','STYLE','LINK','META','BASE','NOSCRIPT','TEMPLATE']);
  const unsupported = new Set(['IFRAME','FRAME','OBJECT','EMBED','CANVAS','VIDEO','AUDIO','SVG']);
  const observers = [];
  function mark(node, subtree = false) {
    if (!node) return;
    // HTML/head events can affect body styles, but these ancestors must never enter the mirror tree.
    let owner=node;
    while(owner?.getRootNode?.() instanceof ShadowRoot)owner=owner.getRootNode().host;
    if(node!==document.body&&!document.body?.contains(owner)){node=document.body;subtree=true;}
    if(!node)return;
    dirty.add(node);
    if (subtree && node.querySelectorAll)subtrees.add(node);
  }
  function observe(root) {
    if(observed.has(root))return;observed.add(root);
    const observer = new MutationObserver(records => {
      for (const record of records) mark(record.type === 'childList' ? record.target : record.target, record.type === 'attributes' && ['class','style','hidden'].includes(record.attributeName));
    });
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true}); observers.push(observer);
  }
  function listen(target,type,fn){target.addEventListener(type,fn,true);listeners.push([target,type,fn]);}
  function dispose(){for(const o of observers)o.disconnect();for(const [target,type,fn] of listeners)target.removeEventListener(type,fn,true);dirty.clear();subtrees.clear();globalThis.__tabShareDOM.disposed=true;}
  observe(document.documentElement);
  for (const type of ['input','change','scroll','focusin','focusout']) listen(document,type,event => {
    mark(event.target);
    if (event.target?.type === 'radio') for (const n of document.querySelectorAll('input[type=radio]')) mark(n);
  });
  listen(globalThis,'scroll',()=>mark(document.body));
  listen(globalThis,'resize',()=>mark(document.body,true));
  for(const type of ['mouseover','mouseout'])listen(document,type,event=>mark(event.target.parentElement===document.body?event.target:event.target.parentElement,true));
  async function loadImage(url, node) {
    if (!url) return '';
    if (!consumers.has(url)) consumers.set(url,new Set()); consumers.get(url).add(node);
    if (images.has(url)) return images.get(url);
    if (images.size >= 60) return '';
    images.set(url,'');
    try {
      const u = new URL(url,location.href);
      if (!['http:','https:','blob:','data:'].includes(u.protocol)) return '';
      const response=await fetch(u.href,{credentials:'include'}), blob=await response.blob();
      if (!blob.type.startsWith('image/') || blob.type.includes('svg') || blob.size>250000 || imageBytes+blob.size>750000) return '';
      imageBytes+=blob.size;
      const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});
      images.set(url,data);for(const n of consumers.get(url)||[])mark(n);return data;
    } catch {return '';}
  }
  function idFor(node) {if(!ids.has(node))ids.set(node,String(++next));const id=ids.get(node);nodes.set(id,node);return id;}
  function childrenOf(node) {
    if(node.shadowRoot){observe(node.shadowRoot);return [...node.shadowRoot.childNodes];}
    if(node.tagName==='SLOT'&&node.assignedNodes().length)return node.assignedNodes();
    return node.childNodes||[];
  }
  function allowed(node) {return node.nodeType===3 || node.nodeType===1&&!forbidden.has(node.tagName);}
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
    function read(list){for(const rule of list){if(rule.type===CSSRule.KEYFRAMES_RULE&&!rule.cssText.includes('url('))rules.push(rule.cssText);else if(rule.cssRules)read(rule.cssRules);}}
    for(const sheet of document.styleSheets){try{read(sheet.cssRules);}catch{}}
    return rules.join('\n').slice(0,100000);
  }
  function capture() {
    lastCapture=Date.now();
    if(!document.body)return null;
    if(rootNode!==document.body){rootNode=document.body;first=true;previous.clear();sizes.clear();retainedBytes=0;dirty.clear();subtrees.clear();}
    for(const root of subtrees)for(const child of root.querySelectorAll('*')){if(dirty.size>=3500)break;dirty.add(child);}subtrees.clear();
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
        const computed=getComputedStyle(node),style={},attrs={};
        for(const name of properties){const v=computed.getPropertyValue(name);if(v&&!v.includes('url('))style[name]=v;}
        for(const name of attributes)if(node.hasAttribute(name))attrs[name]=node.getAttribute(name).slice(0,1000);
        value={id,tag:node.tagName.toLowerCase(),style,attrs,children:[],scrollTop:node.scrollTop,scrollLeft:node.scrollLeft};
        if(unsupported.has(node.tagName)){value.tag='div';value.unsupported=node.tagName.toLowerCase();value.text='此 '+value.unsupported+' 内容暂不支持 DOM 共享';}
        else{
          if(node.tagName==='IMG'){const source=node.currentSrc||node.src;void loadImage(source,node);attrs.src=images.get(source)||'';}
          const match=computed.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
          if(match){void loadImage(match[1],node);const data=images.get(match[1]);if(data)style['background-image']='url("'+data+'")';}
          if(['INPUT','TEXTAREA','SELECT'].includes(node.tagName)){controls.add(node);value.value=node.type==='password'?'':String(node.value).slice(0,16000);value.checked=!!node.checked;value.selectedIndex=node.selectedIndex??null;}
          if(node.tagName==='OPTION'){attrs.value=node.value;value.selected=!!node.selected;}
          if(node.isContentEditable)value.editable=true;
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
    const meta={width:innerWidth,height:innerHeight,scrollX,scrollY,url:location.href,title:document.title,truncated};
    const result={version,sequence:++sequence,reset:first,root:idFor(document.body),nodes:fresh,updates,removes,meta};
    if(first)result.css=cssAnimations();
    first=false;
    // No idle packets or polling of animation styles: only mutations and state changes cause deltas.
    if(!fresh.length&&!updates.length&&!removes.length&&JSON.stringify(meta)===globalThis.__tabShareLastMeta)return null;
    globalThis.__tabShareLastMeta=JSON.stringify(meta);return result;
  }
  function act(input) {
    if(input.action==='scroll'&&input.nodeId==='root'){const root=document.scrollingElement;root.scrollLeft=input.scrollLeft||0;root.scrollTop=input.scrollTop||0;mark(document.body);return;}
    const node=nodes.get(input.nodeId);
    if(!node||!node.isConnected||node.nodeType!==1)throw new Error('页面已变化，请等待同步后重试');
    if(input.action==='scroll'){node.scrollTo(input.scrollLeft||0,input.scrollTop||0);mark(node);return;}
    if(input.action==='select'){
      if(node.tagName!=='SELECT')throw new Error('不是选择框');
      node.value=input.text;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));mark(node);return;
    }
    const r=node.getBoundingClientRect();
    return {x:Math.max(0,Math.min(innerWidth-1,r.left+r.width*(input.x??.5))),y:Math.max(0,Math.min(innerHeight-1,r.top+r.height*(input.y??.5)))};
  }
  function fallback() {
    if(truncated)return {full:true,width:innerWidth,height:innerHeight};
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
    return {full:false,regions,width:innerWidth,height:innerHeight};
  }
  globalThis.__tabShareDOM={capture,act,fallback,dispose,disposed:false,reset(){first=true;previous.clear();sizes.clear();retainedBytes=0;truncated=false;dirty.clear();subtrees.clear();lastCapture=Date.now();}};
}
export const installDOM = '(' + bootstrap.toString() + ')()';
export const captureDOM = 'globalThis.__tabShareDOM.capture()';
