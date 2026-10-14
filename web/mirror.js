const tags = new Set('a abbr address article aside b bdi bdo blockquote br button caption code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i img input kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr'.split(' '));
const attrs = new Set('id for open aria-expanded aria-label aria-labelledby aria-describedby type placeholder title alt role colspan rowspan maxlength min max step size multiple disabled readonly required name value'.split(' '));
export class Mirror {
  constructor(doc) { this.doc = doc; this.nodes = new Map(); this.version = null; }
  apply(delta) {
    if (!delta.reset && delta.version !== this.version) return false;
    if (delta.reset) { this.nodes.clear(); this.doc.body.replaceChildren(); this.version = delta.version; this.doc.head.querySelectorAll('style').forEach(n => n.remove()); if (delta.css) { const style = this.doc.createElement('style'); style.textContent = delta.css; this.doc.head.append(style); } }
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
    for (const id of delta.removes || []) { const node=this.nodes.get(id);if(node!==this.doc.body)node?.remove();this.nodes.delete(id); }
    for (const data of [...added, ...(delta.updates || []).map(x => ({id: x.id, ...x.changes}))]) {
      const node = this.nodes.get(data.id);
      if (node?.nodeType === 1) {
        if (typeof data.scrollTop === 'number' && Math.abs(node.scrollTop - data.scrollTop) > 2) node.scrollTop = data.scrollTop;
        if (typeof data.scrollLeft === 'number' && Math.abs(node.scrollLeft - data.scrollLeft) > 2) node.scrollLeft = data.scrollLeft;
      }
    }
    this.meta = delta.meta;
    return true;
  }
  properties(node, data) {
    if (!node) return;
    if (node.nodeType === 3) { if (data.text != null && node.textContent !== data.text) node.textContent = data.text; return; }
    for (const [name, value] of Object.entries(data.style || {})) {
      if (value == null) node.style.removeProperty(name);
      else if (!/url\(/i.test(value) || /^url\("data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+"\)$/.test(value)) node.style.setProperty(name, String(value));
    }
    for (const [name, value] of Object.entries(data.attrs || {})) {
      if (name === 'src' && node.tagName === 'IMG') { if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(value || '')) node.src = value; else node.removeAttribute('src'); continue; }
      if (!attrs.has(name)) continue;
      if (value == null) node.removeAttribute(name); else node.setAttribute(name, String(value));
    }
    if (node.tagName === 'A') node.href = '#';
    if (node.tagName === 'INPUT' && node.type === 'file') { node.type = 'text'; node.disabled = true; node.placeholder = '不支持远程文件上传'; }
    if (data.unsupported) node.dataset.unsupported = data.unsupported;
    if (data.text != null && node.textContent !== data.text) node.textContent = data.text;
    // Preserve the caret while applying authoritative shared form state, including other visitors' edits.
    if (data.value != null && 'value' in node && node.value !== data.value) {
      const focused=node===this.doc.activeElement,start=node.selectionStart,end=node.selectionEnd;
      node.value=data.value;
      if(focused&&typeof start==='number')try{node.setSelectionRange(Math.min(start,node.value.length),Math.min(end,node.value.length));}catch{}
    }
    if (typeof data.checked === 'boolean') node.checked = data.checked;
    if (typeof data.selected === 'boolean') node.selected = data.selected;
    if (typeof data.selectedIndex === 'number' && node.tagName === 'SELECT' && node !== this.doc.activeElement) node.selectedIndex = data.selectedIndex;
    if (data.editable) node.contentEditable = 'true';
  }
  children(parent, ids) {
    if (!parent) return;
    const desired = ids.map(id => this.nodes.get(id)).filter(Boolean);
    for (let index = 0; index < desired.length; index++) if (parent.childNodes[index] !== desired[index]) parent.insertBefore(desired[index], parent.childNodes[index] || null);
    while (parent.childNodes.length > desired.length) parent.lastChild.remove();
  }
}
