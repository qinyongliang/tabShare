const tags = new Set('a abbr address article aside b bdi bdo blockquote br button caption code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i img input kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr'.split(' '));
const attrs = new Set('id for open aria-expanded aria-label aria-labelledby aria-describedby type placeholder title alt role colspan rowspan maxlength min max step size multiple disabled readonly required name value lang dir popover'.split(' '));
export class Mirror {
  constructor(doc,resources) { this.doc = doc;this.resources=resources; this.nodes = new Map();this.states=new Map();this.localValues=new Map(); this.version = null;this.css=""; }
  apply(delta) {
    if (!delta.reset && delta.version !== this.version) return false;
    if (delta.reset) { this.nodes.clear();this.states.clear();this.localValues.clear(); this.doc.body.replaceChildren(); this.version = delta.version; this.doc.head.querySelectorAll('style').forEach(n => n.remove()); }
    if(delta.reset||delta.css!=null){this.css=delta.css||'';this.stylesheet();}
    const added = delta.nodes || [];
    for (const data of added) {
      if (this.nodes.has(data.id)) continue;
      const node = data.id === delta.root ? this.doc.body : data.tag === '#text' ? this.doc.createTextNode('') : this.doc.createElement(tags.has(data.tag) ? data.tag : 'div');
      if (node.nodeType === 1) node.dataset.nodeId = data.id;
      this.nodes.set(data.id, node);
    }
    for (const data of added) this.properties(this.nodes.get(data.id), data);
    for (const {id, changes} of delta.updates || []) { const node = this.nodes.get(id); if (node) this.properties(node, changes); }
    for (const data of added) if (data.children) this.children(this.nodes.get(data.id), data.children);
    for (const {id, changes} of delta.updates || []) if (changes.children) this.children(this.nodes.get(id), changes.children);
    for (const id of delta.removes || []) { const node=this.nodes.get(id);if(node!==this.doc.body)node?.remove();this.nodes.delete(id);this.states.delete(id);this.doc.getElementById("ts-pseudo-"+id)?.remove(); }
    for (const data of [...added, ...(delta.updates || []).map(x => ({id: x.id, ...x.changes}))]) {
      const node = this.nodes.get(data.id);
      if (node?.nodeType === 1) {
        if (typeof data.scrollTop === 'number' && Math.abs(node.scrollTop - data.scrollTop) > 2) node.scrollTop = data.scrollTop;
        if (typeof data.scrollLeft === 'number' && Math.abs(node.scrollLeft - data.scrollLeft) > 2) node.scrollLeft = data.scrollLeft;
      }
    }
    for(const [id,state] of this.states){const n=this.nodes.get(id);if(n?.isConnected&&n.nodeType===1){if(n.tagName==='DIALOG'&&typeof state.modal==='boolean'){if(state.modal&&!n.matches(':modal')){n.removeAttribute('open');try{n.showModal();}catch{}}else if(!state.modal&&n.matches(':modal'))n.close();}if(typeof state.popoverOpen==='boolean')try{if(state.popoverOpen&&!n.matches(':popover-open'))n.showPopover();else if(!state.popoverOpen&&n.matches(':popover-open'))n.hidePopover();}catch{}}}
    this.meta = delta.meta;
    return true;
  }
  properties(node, data,remember=true) {
    if (!node) return;
    const id=data.id||node.dataset?.nodeId;
    if(remember&&id){const old=this.states.get(id)||{};this.states.set(id,{...old,...data,style:{...old.style,...data.style},attrs:{...old.attrs,...data.attrs}});}
    if (node.nodeType === 3) { if (data.text != null && node.textContent !== data.text) node.textContent = data.text; return; }
    for (const [name, value] of Object.entries(data.style || {})) {
      if (value == null) node.style.removeProperty(name);
      else {const safe=this.safeStyle(value);if(safe!==null)node.style.setProperty(name,safe);}
    }
    for (const [name, value] of Object.entries(data.attrs || {})) {
      if (name === 'src' && node.tagName === 'IMG') { const safe=this.resources?.resolve(value||'')||value;if (/^(blob:|data:image\/(png|jpeg|gif|webp|avif);base64,)/.test(safe||'')) node.src = safe; else node.removeAttribute('src'); continue; }
      if (!attrs.has(name)) continue;
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
    let safe=true;resolved.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,(_,a,b,c)=>{const u=a??b??c;if(u&&!/^(blob:|data:image\/(png|jpeg|gif|webp|avif);base64,)/.test(u))safe=false;return '';});
    return safe?resolved:null;
  }
  stylesheet() {
    let style=this.doc.getElementById('ts-page-css');if(!style){style=this.doc.createElement('style');style.id='ts-page-css';this.doc.head.append(style);}
    const safe=this.safeStyle(this.css);style.textContent=safe||'';
  }
  pseudos(id,values) {
    if(!/^\d+$/.test(id))return;
    let style=this.doc.getElementById('ts-pseudo-'+id);if(!style){style=this.doc.createElement('style');style.id='ts-pseudo-'+id;this.doc.head.append(style);}style.textContent='';
    for(const [pseudo,props] of Object.entries(values)){if(!['::before','::after','::backdrop'].includes(pseudo))continue;const i=style.sheet.insertRule('[data-node-id="'+id+'"]'+pseudo+' {}');const rule=style.sheet.cssRules[i];for(const [name,value] of Object.entries(props)){const safe=this.safeStyle(value);if(safe!==null)rule.style.setProperty(name,safe);}}
  }
  refreshResources() {this.stylesheet();for(const [id,state] of this.states)this.properties(this.nodes.get(id),state,false);}
  children(parent, ids) {
    if (!parent) return;
    const desired = ids.map(id => this.nodes.get(id)).filter(Boolean);
    for (let index = 0; index < desired.length; index++) if (parent.childNodes[index] !== desired[index]) parent.insertBefore(desired[index], parent.childNodes[index] || null);
    while (parent.childNodes.length > desired.length) parent.lastChild.remove();
  }
}
