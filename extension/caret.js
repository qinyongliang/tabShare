// Returns CSS viewport coordinates only; text stays in the source browser.
export function caretPosition(doc=document,closedRoot=()=>null,probeRoot) {
  try {
    let node=doc.activeElement;
    while(node){const root=closedRoot(node)||node.shadowRoot;if(!root?.activeElement)break;node=root.activeElement;}
    if(!node)return null;
    const win=doc.defaultView,rect=node.getBoundingClientRect(),style=win.getComputedStyle(node);
    if(node.tagName==='IFRAME'||node.tagName==='FRAME'){
      const child=caretPosition(node.contentDocument,closedRoot);if(!child)return null;
      const sx=rect.width/(node.offsetWidth||rect.width),sy=rect.height/(node.offsetHeight||rect.height);
      return {...child,x:rect.left+(node.clientLeft+child.x)*sx,y:rect.top+(node.clientTop+child.y)*sy,height:child.height*sy};
    }
    const textControl=['INPUT','TEXTAREA'].includes(node.tagName)&&typeof node.selectionStart==='number';
    if(!textControl&&!node.isContentEditable)return null;
    if(node.disabled||node.readOnly)return null;
    let x=rect.left,y=rect.top,height=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2||20;
    if(textControl){
      const cache=caretPosition.probes||(caretPosition.probes=new WeakMap());let entry=cache.get(doc);
      if(!entry){const host=doc.createElement('div');host.setAttribute('data-tabshare-owner-ui','');host.style.cssText='all:initial!important;position:fixed!important;left:-100000px!important;top:0!important;visibility:hidden!important;pointer-events:none!important';const root=host.attachShadow({mode:'closed'}),box=doc.createElement('div');root.append(box);(probeRoot||doc.body).append(host);entry={host,box};cache.set(doc,entry);}
      const {box}=entry,offset=node.selectionDirection==='backward'?node.selectionStart:node.selectionEnd;
      const signature=[node,node.value,offset,node.scrollTop,node.scrollLeft,rect.x,rect.y,rect.width,rect.height,style.cssText,style.font,style.letterSpacing,style.direction];
      if(entry.signature?.every((v,i)=>v===signature[i]))return entry.result;
      box.style.cssText='all:initial;display:block;position:relative;white-space:pre-wrap;overflow-wrap:break-word;';
      for(const name of ['font-family','font-size','font-style','font-weight','font-stretch','font-kerning','font-feature-settings','font-variation-settings','font-variant','line-height','letter-spacing','word-spacing','tab-size','direction','text-align','text-indent','text-transform','writing-mode','padding-top','padding-right','padding-bottom','padding-left','border-top-width','border-right-width','border-bottom-width','border-left-width','box-sizing'])box.style.setProperty(name,style.getPropertyValue(name));
      box.style.borderStyle='solid';box.style.borderColor='transparent';box.style.width=node.offsetWidth+'px';
      if(node.tagName==='INPUT'){box.style.whiteSpace='pre';box.style.overflowWrap='normal';}
      box.textContent=(node.value||'').slice(0,Math.min(offset,64000));const marker=doc.createElement('span');marker.textContent='\u200b';box.append(marker);
      const a=marker.getBoundingClientRect(),b=box.getBoundingClientRect(),sx=rect.width/(node.offsetWidth||rect.width),sy=rect.height/(node.offsetHeight||rect.height);
      x=rect.left+(a.left-b.left-node.scrollLeft)*sx;
      y=rect.top+(node.tagName==='INPUT'?node.clientTop+(node.clientHeight-height)/2:a.top-b.top-node.scrollTop)*sy;height*=sy;
      const result={x,y,height,fontSize:parseFloat(style.fontSize)*sy||16,direction:style.direction};entry.signature=signature;entry.result=result;return result;
    }
    const selection=(node.getRootNode().getSelection?.()||win.getSelection());
    if(selection?.focusNode&&node.contains(selection.focusNode)){const range=doc.createRange();range.setStart(selection.focusNode,selection.focusOffset);range.collapse(true);const r=range.getBoundingClientRect();if(r.height){x=r.left;y=r.top;height=r.height;}else{x+=parseFloat(style.paddingLeft)||0;y+=parseFloat(style.paddingTop)||0;}}
    return {x,y,height,fontSize:parseFloat(style.fontSize)||16,direction:style.direction};
  } catch {return null;}
}

export function selectionState(doc=document,closedRoot=()=>null) {
  try{
    let node=doc.activeElement;while(node){const root=closedRoot(node)||node.shadowRoot;if(!root?.activeElement)break;node=root.activeElement;}
    if(node?.type==='password')return null;
    if(['IFRAME','FRAME'].includes(node?.tagName)){const state=selectionState(node.contentDocument,closedRoot);if(!state)return null;const r=node.getBoundingClientRect(),sx=r.width/node.offsetWidth,sy=r.height/node.offsetHeight;return {...state,x:r.left+(node.clientLeft+state.x)*sx,y:r.top+(node.clientTop+state.y)*sy,width:state.width*sx,height:state.height*sy};}
    const selection=node?.getRootNode().getSelection?.()||doc.defaultView.getSelection();
    let text=selection?.toString()||'',rect=selection?.rangeCount?selection.getRangeAt(0).getBoundingClientRect():null;
    if(['INPUT','TEXTAREA'].includes(node?.tagName)&&typeof node.selectionStart==='number'&&node.selectionStart!==node.selectionEnd){text=node.value.slice(node.selectionStart,node.selectionEnd);rect=node.getBoundingClientRect();}
    if(!text||!rect)return null;
    return {text:text.slice(0,65536),x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  }catch{return null;}
}
