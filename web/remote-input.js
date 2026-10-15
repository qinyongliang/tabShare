export class RemoteInput {
  constructor(doc,frame,send,paste){
    this.doc=doc;this.frame=frame;this.send=send;
    const box=doc.createElement('textarea');box.id='remote-input';box.setAttribute('aria-label','视频区域键盘输入');box.autocomplete='off';box.spellcheck=false;box.tabIndex=-1;doc.body.append(box);this.box=box;
    box.addEventListener('compositionstart',()=>{this.composing=true;});
    box.addEventListener('compositionend',e=>{this.composing=false;this.committed=e.data||'';setTimeout(()=>{this.committed='';},0);if(e.data)send({action:'text',text:e.data});box.value='';this.place();});
    box.addEventListener('beforeinput',e=>{if(this.composing||e.isComposing)return;if(this.committed&&e.data===this.committed){e.preventDefault();this.committed='';return;}if(e.data){e.preventDefault();send({action:'text',text:e.data});box.value='';}});
    box.addEventListener('paste',e=>{e.preventDefault();paste(e.clipboardData);});
    for(const [event,action] of [['keydown','keyDown'],['keyup','keyUp']])box.addEventListener(event,e=>{if(e.altKey&&!e.ctrlKey&&!e.metaKey&&['ArrowLeft','ArrowRight'].includes(e.key)||e.metaKey&&!e.altKey&&['[',']'].includes(e.key)){e.preventDefault();if(event==='keydown')doc.defaultView.history.go(['ArrowLeft','['].includes(e.key)?-1:1);return;}if(e.isComposing||e.keyCode===229)return;if((e.ctrlKey||e.metaKey)&&['c','v'].includes(e.key.toLowerCase()))return;if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;e.preventDefault();send({action,key:e.key,code:e.code,keyCode:e.keyCode,modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)});});
    doc.addEventListener('pointerdown',e=>{if(e.target!==box)this.release();},true);
    doc.addEventListener('scroll',()=>this.place(),true);
  }
  activate(x,y){const r=this.frame.getBoundingClientRect(),scale=r.width/this.frame.clientWidth;this.active=true;this.fallback={x:(x-r.left)/scale,y:(y-r.top)/scale,height:20,fontSize:16};this.caret=null;this.place();this.box.focus({preventScroll:true});}
  release(){this.active=false;this.box.hidden=true;if(this.doc.activeElement===this.box)this.box.blur();}
  update(meta){this.caret=meta?.caret;if(this.active&&!this.composing&&meta?.selection?.text){this.box.value=meta.selection.text;this.box.setSelectionRange(0,this.box.value.length);}this.place();}
  place(){if(!this.active)return;const c=this.caret||this.fallback;if(!c||!Number.isFinite(c.x)||!Number.isFinite(c.y))return;const r=this.frame.getBoundingClientRect(),scale=r.width/this.frame.clientWidth;this.box.hidden=false;this.box.style.left=r.left+c.x*scale+'px';this.box.style.top=r.top+c.y*scale+'px';this.box.style.height=Math.max(2,c.height*scale)+'px';this.box.style.fontSize=Math.max(1,(c.fontSize||16)*scale)+'px';this.box.style.lineHeight=Math.max(2,c.height*scale)+'px';this.box.dir=c.direction==='rtl'?'rtl':'ltr';}
  copySelection(doc,state){
    let proxy=doc.getElementById('tabshare-selection');if(!state?.text){proxy?.remove();return;}
    if(!proxy){proxy=doc.createElement('span');proxy.id='tabshare-selection';proxy.style.cssText='position:fixed!important;pointer-events:none!important;opacity:0!important;white-space:pre!important;';doc.body.append(proxy);}
    proxy.textContent=state.text;proxy.style.left=state.x+'px';proxy.style.top=state.y+'px';const range=doc.createRange();range.selectNodeContents(proxy);const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);
  }
}
