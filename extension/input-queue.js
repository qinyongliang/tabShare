// Serialize real input per tab; only adjacent pending pointer moves may replace each other.
export class InputQueue {
  constructor(limit=256){this.limit=limit;this.pending=[];this.running=false;}
  push(run,key){
    const last=this.pending.at(-1);
    if(key&&last?.key===key){last.run=run;return last.promise;}
    if(this.pending.length>=this.limit)return Promise.reject(new Error('Input queue full'));
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    this.pending.push({run,key,promise,resolve,reject});void this.drain();return promise;
  }
  async drain(){
    if(this.running)return;this.running=true;
    try{while(this.pending.length){const job=this.pending.shift();try{job.resolve(await job.run());}catch(error){job.reject(error);}}}finally{this.running=false;}
  }
  clear(){for(const job of this.pending.splice(0))job.resolve(false);}
}
