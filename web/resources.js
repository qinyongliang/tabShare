export class Resources {
  constructor(session,key,ready){this.session=session;this.key=key;this.ready=ready;this.urls=new Map();this.hashes=new Map();this.pending=new Map();this.bytes=0;this.reserved=0;this.sizes=new Map();this.controller=new AbortController();}
  async add(meta, directBytes) {
    if(this.urls.has(meta.id)||this.pending.has(meta.id)||meta.size>8*1024*1024||meta.size<1)return;
    if(this.bytes+this.reserved+meta.size>32*1024*1024)return;
    if(!/^(image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)|font\/(woff2?|ttf|otf)|application\/font-woff)$/.test(meta.mime))return;
    this.reserved+=meta.size;const job=(async()=>{
      let bytes;
      if(directBytes)bytes=directBytes.buffer.slice(directBytes.byteOffset,directBytes.byteOffset+directBytes.byteLength);
      else {const response=await fetch('/api/resources/'+encodeURIComponent(this.session)+'/'+encodeURIComponent(meta.id),{headers:{Authorization:'Bearer '+this.key},signal:this.controller.signal});if(!response.ok)return;
      bytes=await response.arrayBuffer();}
      if(bytes.byteLength!==meta.size)return;
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');if(hash!==meta.sha256||this.version&&!meta.id.startsWith(this.version+'_'))return;
      let url=this.hashes.get(hash);
      if(!url){let data=bytes;
        if(meta.mime==='image/svg+xml'){
          const doc=new DOMParser().parseFromString(new TextDecoder().decode(bytes),'image/svg+xml');
          if(doc.querySelector('parsererror'))return;
          doc.querySelectorAll('script,foreignObject,iframe,object,embed').forEach(n=>n.remove());
          for(const node of doc.querySelectorAll('*'))for(const attr of [...node.attributes])if(/^on/i.test(attr.name)||/(href|src)$/i.test(attr.name)&&!attr.value.startsWith('#')||/url\(\s*["']?(?!#)/i.test(attr.value))node.removeAttribute(attr.name);
          data=new XMLSerializer().serializeToString(doc);
        }
        url=URL.createObjectURL(new Blob([data],{type:meta.mime}));this.hashes.set(hash,url);this.sizes.set(hash,meta.size);this.bytes+=meta.size;
      }
      this.urls.set(meta.id,url);this.ready();
    })().catch(()=>{}).finally(()=>{this.pending.delete(meta.id);this.reserved-=meta.size;});this.pending.set(meta.id,job);
  }
  resolve(value) {
    return String(value).replace(/ts-asset:([A-Za-z0-9_-]+)/g,(_,id)=>this.urls.get(id)||'');
  }
  keepVersion(version){this.version=version;for(const [id] of this.urls)if(!id.startsWith(version+'_'))this.urls.delete(id);const used=new Set(this.urls.values());for(const [hash,url] of this.hashes)if(!used.has(url)){URL.revokeObjectURL(url);this.hashes.delete(hash);this.sizes.delete(hash);}this.bytes=[...this.sizes.values()].reduce((n,size)=>n+size,0);}
  dispose(){this.controller.abort();for(const url of this.hashes.values())URL.revokeObjectURL(url);this.urls.clear();this.hashes.clear();this.pending.clear();}
}
