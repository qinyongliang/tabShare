// Read only resources already loaded by the shared page. Never forward cookies or headers.
export class ResourceBridge {
  constructor(command, evaluate) {
    this.command=command;this.evaluate=evaluate;this.loaded=new Map();this.responses=new Map();
    this.done=new Map();this.reading=null;this.disposed=false;this.generation=0;this.bytesRetained=0;
  }
  reset() {this.generation++;this.loaded.clear();this.responses.clear();this.done.clear();this.bytesRetained=0;}
  event(method,p) {
    if(method==='Network.responseReceived'&&p.response?.url){if(this.responses.size>=512)this.responses.delete(this.responses.keys().next().value);this.responses.set(p.response.url,{id:p.requestId,mime:p.response.mimeType,frameId:p.frameId});}
  }
  async scan() {
    const tree=await this.command('Page.getResourceTree');const styles=[];
    const walk=n=>{for(const r of n.resources||[]){this.loaded.set(r.url,{frameId:n.frame.id,mime:r.mimeType});if(r.type==='Stylesheet')styles.push(r.url);}for(const c of n.childFrames||[])walk(c);};
    walk(tree.frameTree);
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
  async transfer(requests,sessions,config) {
    if(this.disposed)return;
    // Serialize transfers separately from DOM/input. A large image never blocks a click.
    this.reading=(this.reading||Promise.resolve()).then(async()=>{
      const generation=this.generation;await this.scan().catch(()=>{});
      for(const request of requests){
        if(this.disposed||generation!==this.generation)return;
        try {
          let item=this.done.get(request.id);
          if(!item){const body=await this.read(request.url),bytes=this.bytes(body);if(!bytes.length||bytes.length>8*1024*1024||this.bytesRetained+bytes.length>32*1024*1024)throw new Error('Resource budget exceeded');
            let mime=this.loaded.get(request.url)?.mime||this.responses.get(request.url)?.mime;
            if(request.kind==='font'){const magic=new TextDecoder().decode(bytes.subarray(0,4));mime=magic==='wOF2'?'font/woff2':magic==='wOFF'?'font/woff':magic==='OTTO'?'font/otf':'font/ttf';}
            item={bytes,mime,sent:new Set()};this.bytesRetained+=bytes.length;this.done.set(request.id,item);
          }
          for(const id of sessions){if(item.sent.has(id))continue;const response=await fetch(config.server+'/api/resources/'+encodeURIComponent(id)+'/'+encodeURIComponent(request.id),{method:'POST',headers:{Authorization:'Bearer '+config.pairingToken,'Content-Type':item.mime||'application/octet-stream'},body:item.bytes});if(response.ok)item.sent.add(id);else throw new Error('Resource relay rejected upload');}
          // Separate resource budget: at most 256 KiB/s after the current bounded object.
          await new Promise(resolve=>setTimeout(resolve,Math.min(30000,item.bytes.length/262144*1000)));
        } catch {if(!this.disposed&&generation===this.generation)await this.evaluate('globalThis.__tabShareDOM.resourceFailed('+JSON.stringify(request.id)+')').catch(()=>{});}
      }
    }).catch(()=>{});
    return this.reading;
  }
  dispose(){this.disposed=true;this.reset();}
}
