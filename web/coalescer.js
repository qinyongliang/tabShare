// Deliver the newest value for each key at a fixed cadence. Unlike debounce,
// continuous scrolling cannot postpone delivery until the gesture has ended.
export class Coalescer {
  constructor(deliver,{delay=32,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}={}){
    this.deliver=deliver;this.delay=delay;this.schedule=schedule;this.cancel=cancel;this.pending=new Map();this.timer=null;
  }
  push(key,value){this.pending.set(key,value);if(this.timer===null)this.timer=this.schedule(()=>this.flush(),this.delay);}
  flush(){this.timer=null;const batch=this.pending;this.pending=new Map();for(const [key,value] of batch)this.deliver(key,value);}
  clear(){if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.pending.clear();}
}
