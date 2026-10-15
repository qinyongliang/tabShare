const svgTags=new Set('svg g path defs rect circle ellipse line polyline polygon use title desc clipPath mask linearGradient radialGradient stop text tspan symbol pattern'.split(' '));
const svgAttrs=new Set('viewBox preserveAspectRatio d x y x1 x2 y1 y2 cx cy r rx ry points width height fill stroke stroke-width clip-path mask offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod maskUnits maskContentUnits clipPathUnits patternUnits patternContentUnits patternTransform fx fy fr href pathLength textLength lengthAdjust startOffset dx dy rotate'.split(' '));
const tags = new Set('a abbr address article aside b bdi bdo blockquote br button caption code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i img input kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr'.split(' '));
const attrs = new Set('id for open aria-expanded aria-label aria-labelledby aria-describedby type placeholder title alt role colspan rowspan maxlength min max step size multiple disabled readonly required name value lang dir popover'.split(' '));
export class Mirror {
  constructor(doc,resources) { this.doc = doc;this.resources=resources; this.nodes = new Map();this.parents=new Map();this.states=new Map();this.localValues=new Map();this.resourceUsers=new Map();this.nodeResources=new Map();this.topLayers=new Set(); this.version = null;this.css=""; }
  apply(delta) {
    if (!delta.reset && delta.version !== this.version) return false;
    if (delta.reset) { this.nodes.clear();this.parents.clear();this.states.clear();this.localValues.clear();this.resourceUsers.clear();this.nodeResources.clear();this.topLayers.clear(); this.doc.body.replaceChildren();for(const a of [...this.doc.body.attributes])this.doc.body.removeAttribute(a.name); this.version = delta.version; this.doc.head.querySelectorAll('style').forEach(n => n.remove()); }
    if(delta.reset||delta.cssChanged||delta.css!=null){this.css=delta.css||'';this.stylesheet();}
    const added = delta.nodes || [];
    for (const data of added) {
      if (this.nodes.has(data.id)) continue;
      const node = data.id === delta.root ? this.doc.body : data.tag === '#text' ? this.doc.createTextNode('') : data.ns==='svg'&&svgTags.has(data.tag)?this.doc.createElementNS('http://www.w3.org/2000/svg',data.tag):this.doc.createElement(tags.has(data.tag) ? data.tag : 'div');
      if (node.nodeType === 1) node.dataset.nodeId = data.id;
      this.nodes.set(data.id, node);
    }
    for (const data of added) this.properties(this.nodes.get(data.id), data);
    for (const {id, changes} of delta.updates || []) { const node = this.nodes.get(id); if (node) this.properties(node, changes); }
    const reconcile=new Set();
    for(const data of [...added,...(delta.updates||[]).map(u=>({id:u.id,...u.changes}))]){
      if(data.children)reconcile.add(data.id);
      if(this.parents.has(data.id))reconcile.add(this.parents.get(data.id));
    }
    for(const id of reconcile)this.children(this.nodes.get(id),this.states.get(id)?.children||[]);
    for (const id of delta.removes || []) { const node=this.nodes.get(id);if(node!==this.doc.body)node?.remove();this.nodes.delete(id);this.states.delete(id);this.parents.delete(id);this.localValues.delete(id);this.indexResources(id,null);this.topLayers.delete(id);this.doc.getElementById("ts-pseudo-"+id)?.remove(); }
    for (const data of [...added, ...(delta.updates || []).map(x => ({id: x.id, ...x.changes}))]) {
      const node = this.nodes.get(data.id);
      if (node?.nodeType === 1) {
        if (typeof data.scrollTop === 'number' && Math.abs(node.scrollTop - data.scrollTop) > 2) node.scrollTop = data.scrollTop;
        if (typeof data.scrollLeft === 'number' && Math.abs(node.scrollLeft - data.scrollLeft) > 2) node.scrollLeft = data.scrollLeft;
      }
    }
    for(const id of this.topLayers){const state=this.states.get(id);const n=this.nodes.get(id);if(n?.isConnected&&n.nodeType===1){if(n.tagName==='DIALOG'&&typeof state.modal==='boolean'){if(state.modal&&!n.matches(':modal')){n.removeAttribute('open');try{n.showModal();}catch{}}else if(!state.modal&&n.matches(':modal'))n.close();}if(typeof state.popoverOpen==='boolean')try{if(state.popoverOpen&&!n.matches(':popover-open'))n.showPopover();else if(!state.popoverOpen&&n.matches(':popover-open'))n.hidePopover();}catch{}}}
    this.meta = delta.meta;this.sequence=delta.sequence;
    return true;
  }
  properties(node, data,remember=true) {
    if (!node) return;
    if(data.unsupported&&node.tagName==='IMG'){const replacement=this.doc.createElement('div');for(const a of node.attributes)if(a.name!=='src')replacement.setAttribute(a.name,a.value);node.replaceWith(replacement);this.nodes.set(node.dataset.nodeId,replacement);node=replacement;}
    const id=data.id||node.dataset?.nodeId;
    if(remember&&id){
      const old=this.states.get(id)||{};if(data.children){for(const child of old.children||[])if(this.parents.get(child)===id)this.parents.delete(child);for(const child of data.children)this.parents.set(child,id);}
      const state={...old,...data,style:{...old.style,...data.style},attrs:{...old.attrs,...data.attrs}};this.states.set(id,state);
      if(data.style||data.attrs||data.pseudos)this.indexResources(id,state);
      if(typeof state.modal==='boolean'||typeof state.popoverOpen==='boolean')this.topLayers.add(id);
    }
    if (node.nodeType === 3) { if (data.text != null && node.textContent !== data.text) node.textContent = data.text; return; }
    for (const [name, value] of Object.entries(data.style || {})) {
      if (value == null) node.style.removeProperty(name);
      else {const safe=this.safeStyle(value);if(safe!==null)node.style.setProperty(name,safe);}
    }
    for (const [name, value] of Object.entries(data.attrs || {})) {
      if (name === 'src' && node.tagName === 'IMG') { const safe=this.resources?.resolve(value||'')||value;if (/^(blob:|data:image\/(png|jpeg|gif|webp|avif);base64,)/.test(safe||'')) node.src = safe; else node.removeAttribute('src'); continue; }
      const svg=node.namespaceURI==='http://www.w3.org/2000/svg';
      if (!attrs.has(name)&&!(svg&&svgAttrs.has(name))) continue;
      if(svg&&name==='href'){const safe=this.resources?.resolve(value||'')||value;if(!safe||!/^(#|blob:)/.test(safe)){node.removeAttribute(name);continue;}node.setAttribute(name,safe);continue;}
      if(svg&&this.safeStyle(value||'')===null)continue;
      if (value == null){if(name==='open'&&node.tagName==='DIALOG')node.close();node.removeAttribute(name);}else node.setAttribute(name, String(value));
    }
    if (node.tagName === 'A') node.href = '#';
    if (node.tagName === 'INPUT' && node.type === 'file') { node.type = 'text'; node.disabled = true; node.placeholder = '不支持远程文件上传'; }
    if (data.unsupported) node.dataset.unsupported = data.unsupported;
    if (data.text != null && node.textContent !== data.text) node.textContent = data.text;
    // Preserve the caret while applying authoritative shared form state, including other visitors' edits.
    const local=this.localValues.get(node.dataset.nodeId);
    if(local&&data.value===local.value)this.localValues.delete(node.dataset.nodeId);
    if (data.value != null && 'value' in node && node.value !== data.value && !(node===this.doc.activeElement&&local&&Date.now()<local.expires)) {
      const focused=node===this.doc.activeElement,start=node.selectionStart,end=node.selectionEnd;
      node.value=data.value;
      if(focused&&typeof start==='number')try{node.setSelectionRange(Math.min(start,node.value.length),Math.min(end,node.value.length));}catch{}
    }
    if(data.caret&&node===this.doc.activeElement&&(!local||data.value===local.value||Date.now()>=local.expires))try{node.setSelectionRange(data.caret.start,data.caret.end);}catch{}
    if (typeof data.checked === 'boolean') node.checked = data.checked;
    if (typeof data.selected === 'boolean') node.selected = data.selected;
    if (typeof data.selectedIndex === 'number' && node.tagName === 'SELECT' && node !== this.doc.activeElement) node.selectedIndex = data.selectedIndex;
    if (data.editable) node.contentEditable = 'true';
    if(data.pseudos)this.pseudos(id,data.pseudos);
  }
  localEdit(node) {if(typeof node.selectionStart!=='number')return;const id=node.dataset.nodeId,record={value:node.value,expires:Date.now()+1500};this.localValues.set(id,record);setTimeout(()=>{if(this.localValues.get(id)!==record)return;this.localValues.delete(id);this.properties(node,this.states.get(id)||{},false);},1500);}
  safeStyle(value) {
    const resolved=this.resources?.resolve(value)||String(value);
    let safe=true;resolved.replace(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi,(_,a,b,c)=>{const u=(a??b??c).replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi,(_,hex,char)=>hex?String.fromCodePoint(Math.min(0x10ffff,parseInt(hex,16))||0xfffd):char);if(u&&!u.startsWith('#')&&!/^(blob:|data:image\/(png|jpeg|gif|webp|avif);base64,)/.test(u))safe=false;return '';});
    return safe?resolved:null;
  }
  stylesheet() {
    let style=this.doc.getElementById('ts-page-css');if(!style){style=this.doc.createElement('style');style.id='ts-page-css';this.doc.head.append(style);}
    const safe=this.safeStyle(this.css);style.textContent=safe||'';
  }
  pseudos(id,values) {
    if(!/^\d+$/.test(id))return;
    let style=this.doc.getElementById('ts-pseudo-'+id);
    if(!Object.keys(values).length){style?.remove();return;}
    if(!style){style=this.doc.createElement('style');style.id='ts-pseudo-'+id;this.doc.head.append(style);}
    // insertRule changes CSSOM, not textContent. Assigning an already empty
    // textContent leaves those old rules alive (including editor placeholders).
    while(style.sheet.cssRules.length)style.sheet.deleteRule(style.sheet.cssRules.length-1);
    for(const [pseudo,props] of Object.entries(values)){if(!['::before','::after','::backdrop'].includes(pseudo))continue;const i=style.sheet.insertRule('[data-node-id="'+id+'"]'+pseudo+' {}');const rule=style.sheet.cssRules[i];for(const [name,value] of Object.entries(props)){const safe=this.safeStyle(value);if(safe!==null)rule.style.setProperty(name,safe);}}
  }
  assetIDs(value) {return new Set(String(value||'').match(/ts-asset:[A-Za-z0-9_-]+/g)?.map(v=>v.slice(9))||[]);}
  indexResources(id,state) {
    for(const asset of this.nodeResources.get(id)||[]){const users=this.resourceUsers.get(asset);users?.delete(id);if(!users?.size)this.resourceUsers.delete(asset);}
    const assets=state?this.assetIDs(JSON.stringify([state.style,state.attrs,state.pseudos])):new Set();
    if(!assets.size){this.nodeResources.delete(id);return;}
    this.nodeResources.set(id,assets);
    for(const asset of assets){if(!this.resourceUsers.has(asset))this.resourceUsers.set(asset,new Set());this.resourceUsers.get(asset).add(id);}
  }
  refreshResources(changed) {
    const assets=new Set(changed||this.resourceUsers.keys()),affected=new Set();
    if([...this.assetIDs(this.css)].some(id=>assets.has(id)))this.stylesheet();
    for(const asset of assets)for(const id of this.resourceUsers.get(asset)||[])affected.add(id);
    const uses=value=>[...this.assetIDs(value)].some(id=>assets.has(id));
    for(const id of affected){
      const state=this.states.get(id),node=this.nodes.get(id);if(!state||!node)continue;
      const data={id};
      for(const field of ['style','attrs']){const entries=Object.entries(state[field]||{}).filter(([,value])=>uses(value));if(entries.length)data[field]=Object.fromEntries(entries);}
      if(uses(JSON.stringify(state.pseudos)))data.pseudos=state.pseudos;
      this.properties(node,data,false);
    }
  }
  children(parent, ids) {
    if (!parent) return;
    const desired = ids.map(id => this.nodes.get(id)).filter(Boolean);
    for (let index = 0; index < desired.length; index++) if (parent.childNodes[index] !== desired[index]) parent.insertBefore(desired[index], parent.childNodes[index] || null);
    while (parent.childNodes.length > desired.length) parent.lastChild.remove();
  }
}
