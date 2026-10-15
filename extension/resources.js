// Read only resources already loaded by the shared page. Never forward cookies or headers.
export class ResourceBridge {
  constructor(command, evaluate) {
    this.command=command;this.evaluate=evaluate;this.loaded=new Map();this.responses=new Map();
    this.done=new Map();this.reading=null;this.pendingTransfers=new Map();this.controller=new AbortController();this.disposed=false;this.generation=0;this.bytesRetained=0;
  }
  reset() {this.generation++;this.loaded.clear();this.responses.clear();this.pendingTransfers.clear();this.done.clear();this.bytesRetained=0;}
  event(method,p) {
    if(method==='Network.responseReceived'&&p.response?.url){if(this.responses.size>=512)this.responses.delete(this.responses.keys().next().value);this.responses.set(p.response.url,{id:p.requestId,mime:p.response.mimeType,frameId:p.frameId});if(p.type==='Font')void this.evaluate('globalThis.__tabShareDOM?.loadedResources('+JSON.stringify([p.response.url])+')').catch(()=>{});}
  }
  async scan() {
    const tree=await this.command('Page.getResourceTree');const styles=[];
    const walk=n=>{for(const r of n.resources||[]){this.loaded.set(r.url,{frameId:n.frame.id,mime:r.mimeType});if(r.type==='Stylesheet')styles.push(r.url);}for(const c of n.childFrames||[])walk(c);};
    walk(tree.frameTree);
    await this.evaluate('globalThis.__tabShareDOM.loadedResources('+JSON.stringify([...this.loaded.keys(),...this.responses.keys()])+')');
    for(const url of styles){if(this.done.has('css:'+url))continue;this.done.set('css:'+url,true);try{const body=await this.read(url);const css=body.base64Encoded?new TextDecoder().decode(this.bytes(body)):body.content;await this.evaluate('globalThis.__tabShareDOM.addStyles('+JSON.stringify(css)+','+JSON.stringify(url)+')');}catch{this.done.delete('css:'+url);}}
  }
  bytes(body) {
    if(!body.base64Encoded)return new TextEncoder().encode(body.content??body.body);
    const raw=atob(body.content??body.body),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;
  }
  async read(url) {
    const resource=this.loaded.get(url),response=this.responses.get(url);
    if(!resource&&!response)throw new Error('Resource was not loaded by this tab');
    if(resource)try{return await this.command('Page.getResourceContent',{frameId:resource.frameId,url});}catch{}
    if(response)try{return await this.command('Network.getResponseBody',{requestId:response.id});}catch{}
    // Chrome does not expose some cached fonts through Page.getResourceContent.
    // Reload only a URL already present in this tab's resource tree, using its browser context.
    const {resource:result}=await this.command('Network.loadNetworkResource',{frameId:resource?.frameId||response.frameId,url,options:{disableCache:false,includeCredentials:true}});
    if(!result?.success||!result.stream)throw new Error('Browser did not retain resource body');
    const chunks=[];let size=0;
    try{
      for(;;){const chunk=await this.command('IO.read',{handle:result.stream,size:65536}),bytes=this.bytes({content:chunk.data,base64Encoded:chunk.base64Encoded});size+=bytes.length;if(size>8*1024*1024)throw new Error('Resource budget exceeded');chunks.push(bytes);if(chunk.eof)break;}
    }finally{await this.command('IO.close',{handle:result.stream}).catch(()=>{});}
    let raw='';for(const chunk of chunks)for(let i=0;i<chunk.length;i+=4096)raw+=String.fromCharCode(...chunk.subarray(i,i+4096));
    return {content:btoa(raw),base64Encoded:true};
  }
  wait(ms) {
    return new Promise(resolve=>{
      const signal=this.controller.signal;if(signal.aborted)return resolve();
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
    });
  }
  transfer(requests,sessions,config) {
    if(this.disposed)return Promise.resolve();
    for(const request of requests){
      const old=this.pendingTransfers.get(request.id);
      this.pendingTransfers.set(request.id,{request:request.url?request:old?.request||request,sessions:new Set([...old?.sessions||[],...sessions]),config});
    }
    if(this.reading)return this.reading;
    // A single deduplicated work queue, independent of DOM and input.
    this.reading=this.drain().finally(()=>{this.reading=null;if(this.pendingTransfers.size&&!this.disposed)return this.transfer([],[],{});});
    return this.reading;
  }
  async drain() {
    const generation=this.generation;
    await this.scan().catch(()=>{});
    while(this.pendingTransfers.size&&!this.disposed&&generation===this.generation){
      const [key,job]=this.pendingTransfers.entries().next().value;this.pendingTransfers.delete(key);
      const {request,sessions,config}=job;
      try {
        let item=this.done.get(request.id);
        if(!item){
          const body=await this.read(request.url),bytes=this.bytes(body);
          if(this.disposed||generation!==this.generation)return;
          if(!bytes.length||bytes.length>8*1024*1024||this.bytesRetained+bytes.length>32*1024*1024)throw new Error('Resource budget exceeded');
          let mime=this.loaded.get(request.url)?.mime||this.responses.get(request.url)?.mime;
          if(request.kind==='font'){const magic=new TextDecoder().decode(bytes.subarray(0,4));mime=magic==='wOF2'?'font/woff2':magic==='wOFF'?'font/woff':magic==='OTTO'?'font/otf':'font/ttf';}
          item={bytes,mime,sent:new Set()};this.bytesRetained+=bytes.length;this.done.set(request.id,item);
        }
        let sentBytes=0;
        for(const id of sessions){
          if(this.disposed||generation!==this.generation)return;
          const delivery=config.deliver?await config.deliver(id,request.id,item):true;
          if(typeof delivery==='object')sentBytes+=delivery.sentBytes||0;
          const relay=typeof delivery==='object'?delivery.relay:delivery;
          if(!relay||item.sent.has(id))continue;
          const response=await fetch(config.server+'/api/resources/'+encodeURIComponent(id)+'/'+encodeURIComponent(request.id),{method:'POST',headers:{Authorization:'Bearer '+config.pairingToken,'Content-Type':item.mime||'application/octet-stream'},body:item.bytes,signal:this.controller.signal});
          if(!response.ok)throw new Error('Resource relay rejected upload');
          item.sent.add(id);sentBytes+=item.bytes.length;
        }
        // Cached no-op deliveries consume no bandwidth budget or wait time.
        if(sentBytes)await this.wait(Math.min(30000,sentBytes/262144*1000));
      } catch {
        if(!this.disposed&&generation===this.generation)await this.evaluate('globalThis.__tabShareDOM.resourceFailed('+JSON.stringify(request.id)+')').catch(()=>{});
      }
    }
  }
  dispose(){this.disposed=true;this.controller.abort();this.reset();}
}
