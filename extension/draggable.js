// Works in the viewer and in the source tab's isolated, closed-shadow UI.
export function draggable(button,panel,target=button,getBounds) {
  const doc=button.ownerDocument,win=doc.defaultView,margin=8;
  let drag,moved=false,positioned=false;
  const bounds=()=>getBounds?.()||{width:win.innerWidth,height:win.visualViewport?.height||win.innerHeight};
  const set=(node,name,value)=>node.style.setProperty(name,value,'important');
  function place(x,y){
    const r=button.getBoundingClientRect(),size=bounds();
    set(target,'left',Math.max(margin,Math.min(x,size.width-r.width-margin))+'px');
    set(target,'top',Math.max(margin,Math.min(y,size.height-r.height-margin))+'px');
    set(target,'right','auto');set(target,'bottom','auto');positioned=true;reflow();
  }
  function reflow(){
    if(panel.hidden)return;
    const size=bounds();set(panel,'max-height',Math.max(1,size.height-2*margin)+'px');
    const b=button.getBoundingClientRect(),p=panel.getBoundingClientRect();
    set(panel,'position','fixed');set(panel,'right','auto');set(panel,'bottom','auto');
    set(panel,'left',Math.max(margin,Math.min(b.right-p.width,size.width-p.width-margin))+'px');
    set(panel,'top',Math.max(margin,Math.min(b.top-p.height-margin>=margin?b.top-p.height-margin:b.bottom+margin,size.height-p.height-margin))+'px');
  }
  button.style.touchAction='none';
  button.addEventListener('pointerdown',e=>{
    if(e.button!==0||!e.isPrimary)return;
    const r=button.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:r.left,top:r.top};moved=false;
    button.setPointerCapture(e.pointerId);
  });
  button.addEventListener('pointermove',e=>{
    if(drag?.id!==e.pointerId)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(!moved&&Math.hypot(dx,dy)<6)return;
    moved=true;e.preventDefault();place(drag.left+dx,drag.top+dy);
  });
  const end=e=>{if(drag?.id===e.pointerId)drag=null;};
  button.addEventListener('pointerup',end);button.addEventListener('pointercancel',end);
  button.addEventListener('click',e=>{if(moved){e.preventDefault();e.stopImmediatePropagation();moved=false;}},true);
  const resize=()=>{const r=button.getBoundingClientRect(),size=bounds();if(positioned||r.right>size.width-margin||r.bottom>size.height-margin)place(r.left,r.top);else reflow();};
  win.addEventListener('resize',resize);win.visualViewport?.addEventListener('resize',resize);
  return {reflow,resize,dispose(){win.removeEventListener('resize',resize);win.visualViewport?.removeEventListener('resize',resize);}};
}
