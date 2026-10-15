// Coordinates from an iframe's pointer events are already in its CSS viewport,
// including when the iframe is scaled. Keep the final position at a bounded rate.
export class PointerForwarder {
  constructor(doc,frame,send,interval=33){
    Object.assign(this,{doc,frame,send,interval,last:-Infinity,inside:false,listeners:[]});
    const on=(target,type,fn)=>{target.addEventListener(type,fn,true);this.listeners.push([target,type,fn]);};
    on(doc,'pointermove',e=>this.move(e));
    on(doc,'pointerover',e=>this.move(e));
    for(const type of ['pointerdown','pointerup'])on(doc,type,e=>{if(e.pointerType!=='touch')this.flush();});
    on(doc,'pointerleave',e=>{if(e.pointerType!=='touch'&&(e.target===doc||e.target===doc.documentElement))this.leave();});
    on(frame,'pointerleave',e=>{if(e.pointerType!=='touch')this.leave();});
    on(frame.ownerDocument,'visibilitychange',()=>{if(frame.ownerDocument.hidden)this.leave();});
  }
  move(e){
    if(e.pointerType==='touch')return;
    this.inside=true;
    this.pending={action:'mouseMoved',x:Math.max(0,Math.min(16384,e.clientX)),y:Math.max(0,Math.min(16384,e.clientY)),button:'none',buttons:e.buttons,modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)};
    const wait=this.interval-(performance.now()-this.last);
    if(wait<=0)this.flush();else if(!this.timer)this.timer=setTimeout(()=>this.flush(),wait);
  }
  flush(){
    clearTimeout(this.timer);this.timer=null;
    if(!this.pending)return;
    const point=this.pending;this.pending=null;
    const signature=JSON.stringify(point);if(signature===this.signature)return;
    this.signature=signature;this.last=performance.now();this.send(point);
  }
  leave(){
    clearTimeout(this.timer);this.timer=null;this.pending=null;this.signature=null;
    if(!this.inside)return;
    this.inside=false;this.last=-Infinity;this.send({action:'mouseLeave'});
  }
  dispose(){clearTimeout(this.timer);for(const [target,type,fn] of this.listeners)target.removeEventListener(type,fn,true);this.listeners=[];}
}
