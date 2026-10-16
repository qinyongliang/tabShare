// Viewer-owned CSS animation: immediate feedback never waits for a network round trip.
// An input ACK means delivered to the source browser, not that an application task finished.
export class SyncFeedback {
  constructor(element,root,{now=()=>Date.now(),later=setTimeout,cancel=clearTimeout}={}) {
    this.element=element;this.root=root;this.label=element.querySelector('[data-feedback-label]');
    this.now=now;this.later=later;this.cancel=cancel;this.serial=0;this.pending=false;this.loading=false;this.timer=null;this.initialTimer=null;
  }
  begin() {
    this.cancel(this.timer);this.requestId=this.now().toString(36)+'_'+(++this.serial).toString(36);this.sentAt=this.now();this.result='';
    this.timer=this.later(()=>{this.slow=true;this.draw();},5000);this.slow=false;this.draw();return this.requestId;
  }
  acknowledge(id,status) {
    if(id!==this.requestId)return;
    this.cancel(this.timer);this.requestId=null;this.slow=false;this.result=status==='error'?'操作未送达，请重试':'操作已送达';this.draw();
    this.timer=this.later(()=>{this.result='';this.draw();},Math.max(300,450-(this.now()-this.sentAt)));
  }
  progress(delta) {
    if(this.version!==delta.version){
      this.version=delta.version;this.initial=true;this.root.dataset.initialSync='true';this.cancel(this.initialTimer);
      // A continuously mutating page must not stay blank forever.
      this.initialTimer=this.later(()=>{this.initial=false;delete this.root.dataset.initialSync;},2500);
    }
    this.pending=!!delta.meta?.pending;this.loading=!!delta.meta?.loading;
    if(!this.pending){this.initial=false;delete this.root.dataset.initialSync;this.cancel(this.initialTimer);}
    this.draw();
  }
  draw() {
    const busy=this.pending||this.loading||!!this.requestId;
    this.element.hidden=!busy&&!this.result;
    this.element.dataset.busy=String(busy);this.element.setAttribute('aria-busy',String(busy));
    this.label.textContent=this.slow?'仍在等待共享页面响应…':this.requestId?'正在发送操作…':this.pending?'正在同步页面…':this.loading?'共享页面正在加载…':this.result||'';
  }
  disconnect() {
    this.cancel(this.timer);this.cancel(this.initialTimer);this.requestId=null;this.pending=false;this.loading=false;this.result='';this.slow=false;this.version=null;
    delete this.root.dataset.initialSync;this.draw();
  }
}
