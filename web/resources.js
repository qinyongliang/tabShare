export class Resources {
  constructor(session,key,ready){this.session=session;this.key=key;this.ready=ready;this.urls=new Map();this.hashes=new Map();this.pending=new Map();this.bytes=0;this.reserved=0;this.sizes=new Map();this.controller=new AbortController();this.changed=new Set();this.notice=null;this.future=new Map();this.retired=new Set();this.documentReady=new Promise(resolve=>{this.resolveDocument=resolve;});}
  // Parse SVG in the script-disabled mirror's realm. The viewer shell keeps its
  // strict style-src policy; inherited shell CSP must not reject SVG styles.
  setDocument(doc){this.document=doc;this.resolveDocument?.(doc);this.resolveDocument=null;}
  // State and assets use independent ordered channels. Assets can arrive before
  // the compressed DOM for their document, including across rapid navigations.
  acceptVersion(version){
    if(this.controller.signal.aborted||this.retired.has(version))return false;
    if(version===this.version)return true;
    const now=Date.now();let pruned=false;
    for(const [id,expires] of this.future)if(expires<now){this.future.delete(id);this.forgetVersion(id);pruned=true;}
    if(!this.future.has(version)){
      if(this.future.size>=4){const id=this.future.keys().next().value;this.future.delete(id);this.forgetVersion(id);pruned=true;}
      this.future.set(version,now+120000);
    }
    if(pruned)this.collect();
    return true;
  }
  forgetVersion(version){for(const id of this.urls.keys())if(id.startsWith(version+'_')){this.urls.delete(id);this.changed.delete(id);}}
  collect(){const used=new Set(this.urls.values());for(const [hash,url] of this.hashes)if(!used.has(url)){URL.revokeObjectURL(url);this.hashes.delete(hash);this.sizes.delete(hash);}this.bytes=[...this.sizes.values()].reduce((n,size)=>n+size,0);}
  async add(meta, directBytes) {
    if(typeof meta?.id!=='string'||!Number.isSafeInteger(meta.size))return;
    const match=/^([A-Za-z0-9-]{1,80})_[0-9]{1,6}$/.exec(meta.id);if(!match)return;
    const version=match[1];if(!this.acceptVersion(version))return;
    if(this.urls.has(meta.id)||this.pending.has(meta.id)||meta.size>8*1024*1024||meta.size<1)return;
    if(this.urls.size+this.pending.size>=2048)return;
    if(this.bytes+this.reserved+meta.size>32*1024*1024)return;
    if(!/^(image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)|font\/(woff2?|ttf|otf)|application\/font-woff)$/.test(meta.mime))return;
    this.reserved+=meta.size;const job=(async()=>{
      let bytes;
      if(directBytes)bytes=directBytes.buffer.slice(directBytes.byteOffset,directBytes.byteOffset+directBytes.byteLength);
      else {const response=await fetch('/api/resources/'+encodeURIComponent(this.session)+'/'+encodeURIComponent(meta.id),{headers:{Authorization:'Bearer '+this.key},signal:this.controller.signal});if(!response.ok)return;
      bytes=await response.arrayBuffer();}
      if(bytes.byteLength!==meta.size)return;
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
      if(hash!==meta.sha256||this.controller.signal.aborted||version!==this.version&&!this.future.has(version)||this.retired.has(version))return;
      let url=this.hashes.get(hash);
      if(!url){let data=bytes,realm=globalThis;
        if(meta.mime==='image/svg+xml'){
          const context=this.document||await this.documentReady;
          if(!context||this.controller.signal.aborted)return;
          realm=context.defaultView;
          const doc=new context.defaultView.DOMParser().parseFromString(new TextDecoder().decode(bytes),'image/svg+xml');
          if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg'||doc.documentElement.namespaceURI!=='http://www.w3.org/2000/svg')return;
          doc.querySelectorAll('script,foreignObject,iframe,object,embed').forEach(n=>n.remove());
          const externalURL=value=>{let external=false;value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,(_,a,b,c)=>{if(!(a??b??c).startsWith('#'))external=true;return '';});return external;};
          for(const node of doc.querySelectorAll('*'))for(const attr of [...node.attributes])if(/^on/i.test(attr.name)||/(href|src)$/i.test(attr.name)&&!attr.value.startsWith('#')||externalURL(attr.value))node.removeAttribute(attr.name);
          data=new XMLSerializer().serializeToString(doc);
        }
        url=realm.URL.createObjectURL(new realm.Blob([data],{type:meta.mime}));this.hashes.set(hash,url);this.sizes.set(hash,meta.size);this.bytes+=meta.size;
      }
      this.urls.set(meta.id,url);this.changed.add(meta.id);
      if(this.notice===null)this.notice=setTimeout(()=>{this.notice=null;const ids=[...this.changed];this.changed.clear();this.ready(ids);},16);
    })().catch(()=>{}).finally(()=>{this.pending.delete(meta.id);this.reserved-=meta.size;});this.pending.set(meta.id,job);return job;
  }
  resolve(value) {
    return String(value).replace(/ts-asset:([A-Za-z0-9_-]+)/g,(_,id)=>this.urls.get(id)||'');
  }
  keepVersion(version){
    if(this.version&&this.version!==version){this.retired.add(this.version);this.forgetVersion(this.version);if(this.retired.size>256)this.retired.delete(this.retired.values().next().value);}
    this.version=version;this.future.delete(version);this.retired.delete(version);this.collect();
  }
  dispose(){this.resolveDocument?.(null);this.resolveDocument=null;this.document=null;clearTimeout(this.notice);this.changed.clear();this.controller.abort();for(const url of this.hashes.values())URL.revokeObjectURL(url);this.urls.clear();this.hashes.clear();this.sizes.clear();this.bytes=0;this.future.clear();this.retired.clear();this.pending.clear();}
}
