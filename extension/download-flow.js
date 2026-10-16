// One application-level write acknowledgement per file bounds memory even when
// a visitor's disk is slower than its network. No whole-file size budget.
export class DownloadAcks {
  constructor(timeout=120000){this.timeout=timeout;this.pending=new Map();}
  wait(id,offset,owner){
    if(this.pending.has(id))throw Error('下载块仍在等待确认');
    let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});promise.catch(()=>{});
    const entry={offset,owner,resolve,reject};this.pending.set(id,entry);
    entry.timer=setTimeout(()=>this.cancel(id,'访客保存超时，请重新下载'),this.timeout);
    return promise;
  }
  accept(owner,value){
    const entry=this.pending.get(value?.id);
    if(!entry||entry.owner.sessionId!==owner.sessionId||entry.owner.viewerId!==owner.viewerId||value.offset!==entry.offset)return false;
    clearTimeout(entry.timer);this.pending.delete(value.id);
    if(value.error)entry.reject(Error(String(value.error).slice(0,200)));else entry.resolve();return true;
  }
  cancel(id,message='下载已取消'){const entry=this.pending.get(id);if(!entry)return;clearTimeout(entry.timer);this.pending.delete(id);entry.reject(Error(message));}
  leave(owner){for(const [id,entry] of this.pending)if(entry.owner.sessionId===owner.sessionId&&entry.owner.viewerId===owner.viewerId)this.cancel(id,'下载访客已断开');}
  dispose(){for(const id of [...this.pending.keys()])this.cancel(id);}
}
