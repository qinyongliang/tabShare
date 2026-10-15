const limit=64*1024*1024;
export class Downloads {
  constructor(doc,notice){this.doc=doc;this.notice=notice;this.files=new Map();this.completed=[];this.bytes=0;}
  async accept(meta,bytes){
    if(!meta||typeof meta.id!=='string'||meta.id.length>80)return;
    if(meta.error){this.drop(meta.id);this.notice(meta.error);return;}
    if(!Number.isSafeInteger(meta.offset)||meta.offset<0||bytes.length>262144)return;
    let file=this.files.get(meta.id);
    if(!file){if(meta.offset!==0||this.files.size>=4)return;file={chunks:[],size:0,name:String(meta.name||'download').replace(/[\\/\x00-\x1f]/g,'_').slice(0,200),mime:String(meta.mime||'application/octet-stream').slice(0,100)};this.files.set(meta.id,file);}
    clearTimeout(file.timer);file.timer=setTimeout(()=>{this.drop(meta.id);this.notice('下载连接超时，请重新下载');},120000);
    while(this.bytes+bytes.length>limit&&this.completed.length)this.evict();
    if(file.size!==meta.offset||file.size+bytes.length>limit||this.bytes+bytes.length>limit){this.drop(meta.id);this.notice('下载超过 64 MiB 接收预算，或连接已中断');return;}
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    if(hash!==meta.sha256){this.drop(meta.id);this.notice('下载数据校验失败');return;}
    file.chunks.push(bytes);file.size+=bytes.length;this.bytes+=bytes.length;
    if(!meta.done)return;
    clearTimeout(file.timer);const url=URL.createObjectURL(new Blob(file.chunks,{type:file.mime})),link=this.doc.createElement('a');link.href=url;link.download=file.name;link.textContent='下载 '+file.name;link.className='download-link';
    const list=this.doc.getElementById('downloads');list.append(link);this.completed.push({url,link,size:file.size});this.files.delete(meta.id);
    link.click();this.notice('已转发下载：'+file.name);
    while(this.completed.length>4)this.evict();
  }
  evict(){const old=this.completed.shift();URL.revokeObjectURL(old.url);old.link.remove();this.bytes-=old.size;}
  drop(id){const file=this.files.get(id);if(file){clearTimeout(file.timer);this.bytes-=file.size;}this.files.delete(id);}
  dispose(){for(const file of this.completed)URL.revokeObjectURL(file.url);for(const id of this.files.keys())this.drop(id);this.completed=[];this.bytes=0;}
}
