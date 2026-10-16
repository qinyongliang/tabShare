// Never request or transmit location until this visitor explicitly clicks Allow.
export class VisitorGeolocation {
  constructor(doc,send,geo=doc.defaultView.navigator.geolocation){
    Object.assign(this,{doc,send,geo});this.pending=new Map();
    this.panel=doc.createElement('section');this.panel.id='location-requests';this.panel.setAttribute('aria-label','网页定位请求');doc.body.append(this.panel);
  }
  receive(request){
    if(!request||typeof request.epoch!=='string'||typeof request.id!=='string'||!/^[-A-Za-z0-9_]{8,100}$/.test(request.id))return;
    if(request.kind==='cancel'){this.clear(request.id);return;}
    if(request.kind!=='request'||this.pending.has(request.id)||this.pending.size>=4)return;
    let origin;try{const url=new URL(request.origin);if(!['http:','https:'].includes(url.protocol))return;origin=url.origin;}catch{return;}
    const card=this.doc.createElement('div'),text=this.doc.createElement('p'),allow=this.doc.createElement('button'),deny=this.doc.createElement('button');
    text.textContent=origin+' 请求'+(request.watch?'持续':'本次')+'使用你的设备位置。结果将发送给该共享网页，可能影响其他访客看到的内容。';
    allow.textContent=request.watch?'允许持续定位（最多10分钟）':'允许本次定位';deny.textContent='拒绝';allow.type=deny.type='button';card.append(text,allow,deny);this.panel.append(card);
    const entry={request,card,allow,deny};this.pending.set(request.id,entry);
    entry.timer=setTimeout(()=>this.reply(entry,{error:{code:1,message:'定位请求未获同意或已到期'}}),request.watch?600000:120000);
    deny.onclick=()=>this.reply(entry,{error:{code:1,message:'访问者拒绝或停止定位'}});
    allow.onclick=()=>{
      if(entry.started||this.pending.get(request.id)!==entry)return;entry.started=true;allow.disabled=true;deny.textContent='停止定位';
      if(!this.geo){this.reply(entry,{error:{code:2,message:'访问者浏览器不支持定位'}});return;}
      const success=position=>{if(this.pending.get(request.id)!==entry)return;const c=position.coords;this.reply(entry,{timestamp:position.timestamp,coords:Object.fromEntries(['latitude','longitude','accuracy','altitude','altitudeAccuracy','heading','speed'].map(k=>[k,Number.isFinite(c[k])?c[k]:null]))});};
      const failure=error=>this.reply(entry,{error:{code:[1,2,3].includes(error.code)?error.code:2,message:String(error.message||'浏览器定位失败').slice(0,200)}});
      const options={enableHighAccuracy:request.options?.enableHighAccuracy===true,timeout:Math.max(0,Math.min(120000,Number(request.options?.timeout)||0)),maximumAge:Math.max(0,Math.min(60000,Number(request.options?.maximumAge)||0))};
      try{if(request.watch){entry.watchID=this.geo.watchPosition(success,failure,options);if(this.pending.get(request.id)!==entry)this.geo.clearWatch(entry.watchID);}else this.geo.getCurrentPosition(success,failure,options);}catch(error){failure(error);}
    };
  }
  reply(entry,value){const {request}=entry;if(this.pending.get(request.id)!==entry)return;this.send({action:'geolocationResult',text:JSON.stringify({epoch:request.epoch,id:request.id,...value})});if(!request.watch||value.error?.code===1)this.clear(request.id);}
  clear(id){const entry=this.pending.get(id);if(!entry)return;this.pending.delete(id);clearTimeout(entry.timer);if(entry.watchID!==undefined)this.geo?.clearWatch(entry.watchID);entry.card.remove();}
  reset(){for(const entry of [...this.pending.values()]){this.send({action:'geolocationResult',text:JSON.stringify({epoch:entry.request.epoch,id:entry.request.id,error:{code:1,message:'访问者页面已切换或断开'}})});this.clear(entry.request.id);}}
}
