// This hook runs only in the shared top-level page's main world. It never
// falls back to the source computer's location while sharing is active.
export function geolocationHook(epoch,binding){
  if(globalThis.top!==globalThis||!navigator.geolocation)return;
  globalThis.__tabShareGeolocation?.dispose();
  const geo=navigator.geolocation,originals={},pending=new Map(),outbox=[];let serial=0,disposed=false;
  const error=(code,message)=>({code,message,PERMISSION_DENIED:1,POSITION_UNAVAILABLE:2,TIMEOUT:3});
  const send=value=>{const raw=JSON.stringify({epoch,...value});try{if(typeof globalThis[binding]!=='function')throw Error();globalThis[binding](raw);}catch{if(outbox.length<8)outbox.push(raw);}};
  function remove(id){const item=pending.get(id);if(!item)return;clearTimeout(item.timer);pending.delete(id);send({kind:'cancel',id});}
  function request(success,failure,options={},watch=false){
    if(typeof success!=='function')throw new TypeError('Geolocation success callback must be a function');
    const number=++serial,id=epoch+'_'+number;
    if(disposed||!globalThis.isSecureContext){queueMicrotask(()=>failure?.(error(1,'共享定位需要安全页面和访问者授权')));return number;}
    if(pending.size>=4){queueMicrotask(()=>failure?.(error(2,'定位请求过多')));return number;}
    const timeout=Number.isFinite(options?.timeout)?Math.max(0,Math.min(120000,options.timeout)):120000;
    const item={success,failure,watch};pending.set(id,item);
    item.timer=setTimeout(()=>{if(!pending.has(id))return;remove(id);failure?.(error(3,'访问者定位超时'));},timeout);
    send({kind:'request',id,watch,options:{enableHighAccuracy:options?.enableHighAccuracy===true,timeout,maximumAge:Math.max(0,Math.min(60000,Number(options?.maximumAge)||0))}});
    return number;
  }
  const methods={getCurrentPosition:(ok,fail,options)=>{request(ok,fail,options);},watchPosition:(ok,fail,options)=>request(ok,fail,options,true),clearWatch:number=>remove(epoch+'_'+number)};
  for(const [name,fn] of Object.entries(methods)){originals[name]=Object.getOwnPropertyDescriptor(geo,name);Object.defineProperty(geo,name,{configurable:true,writable:true,value:fn});}
  globalThis.__tabShareGeolocation={epoch,disposed:false,attach(){if(typeof globalThis[binding]==='function')for(const raw of outbox.splice(0))globalThis[binding](raw);},resolve(value){
    if(value.epoch!==epoch)return;const item=pending.get(value.id);if(!item)return;
    clearTimeout(item.timer);
    if(!item.watch||value.error?.code===1)pending.delete(value.id);
    if(value.error){item.failure?.(error(value.error.code,value.error.message));return;}
    const coords={...value.coords,toJSON(){const {toJSON,...fields}=this;return fields;}};
    const position={coords,timestamp:value.timestamp,toJSON(){return {coords:coords.toJSON(),timestamp:this.timestamp};}};item.success(position);
  },dispose(){
    if(disposed)return;disposed=true;if(globalThis.__tabShareGeolocation?.epoch===epoch)globalThis.__tabShareGeolocation.disposed=true;outbox.length=0;
    for(const id of [...pending.keys()]){const item=pending.get(id);remove(id);queueMicrotask(()=>item.failure?.(error(2,'共享定位已结束')));}
    for(const [name,fn] of Object.entries(methods))if(geo[name]===fn){if(originals[name])Object.defineProperty(geo,name,originals[name]);else delete geo[name];}
  }};
}

const validID=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(value);
export function validPosition(value){
  const c=value?.coords,number=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  return !!c&&number(c.latitude,-90,90)&&number(c.longitude,-180,180)&&number(c.accuracy,0,1e8)&&number(value.timestamp,0,Number.MAX_SAFE_INTEGER)&&
    (c.altitude==null||number(c.altitude,-1e7,1e8))&&(c.altitudeAccuracy==null||number(c.altitudeAccuracy,0,1e8))&&(c.heading==null||number(c.heading,0,360))&&(c.speed==null||number(c.speed,0,1e6));
}
export class GeolocationBroker {
  constructor({epoch,origin,send,deliver}){Object.assign(this,{epoch,origin,send,deliver});this.pending=new Map();}
  request(value,owner){
    if(value?.epoch!==this.epoch||!validID(value.id))return;
    if(value.kind==='cancel'){this.end(value.id);return;}
    if(value.kind!=='request'||typeof value.watch!=='boolean'||this.pending.has(value.id))return;
    if(!owner||this.pending.size>=4){this.deliver({epoch:this.epoch,id:value.id,error:{code:2,message:'请由一位访问者操作网页后重新请求定位'}});return;}
    const options={enableHighAccuracy:value.options?.enableHighAccuracy===true,timeout:Math.max(0,Math.min(120000,Number(value.options?.timeout)||0)),maximumAge:Math.max(0,Math.min(60000,Number(value.options?.maximumAge)||0))};
    const entry={owner,watch:value.watch};this.pending.set(value.id,entry);
    entry.timer=setTimeout(()=>this.end(value.id,{code:1,message:'定位授权已到期，请重新请求'}),value.watch?600000:120000);
    this.send(owner,{kind:'request',epoch:this.epoch,id:value.id,origin:this.origin,watch:value.watch,options});
  }
  respond(owner,value){
    const entry=this.pending.get(value?.id);
    if(value?.epoch!==this.epoch||!entry||entry.owner.sessionId!==owner.sessionId||entry.owner.viewerId!==owner.viewerId)return false;
    let response;
    if(value.error&&[1,2,3].includes(value.error.code))response={error:{code:value.error.code,message:String(value.error.message||'定位失败').slice(0,200)}};
    else if(validPosition(value)){const c=value.coords;response={timestamp:value.timestamp,coords:Object.fromEntries(['latitude','longitude','accuracy','altitude','altitudeAccuracy','heading','speed'].map(k=>[k,c[k]??null]))};}
    else return false;
    this.deliver({epoch:this.epoch,id:value.id,...response});
    if(!entry.watch||response.error?.code===1)this.end(value.id);
    return true;
  }
  end(id,error){const entry=this.pending.get(id);if(!entry)return;clearTimeout(entry.timer);this.pending.delete(id);this.send(entry.owner,{kind:'cancel',epoch:this.epoch,id});if(error)this.deliver({epoch:this.epoch,id,error});}
  leave(owner){for(const [id,entry] of this.pending)if(entry.owner.sessionId===owner.sessionId&&entry.owner.viewerId===owner.viewerId)this.end(id,{code:1,message:'访问者已断开，定位已停止'});}
  dispose(){for(const id of [...this.pending.keys()])this.end(id,{code:1,message:'网页已切换或共享已结束'});}
}
