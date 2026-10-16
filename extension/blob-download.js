// Serialized into the shared isolated world. Fetch the Blob URL before the page
// revokes it, then read bounded BYOB blocks instead of materializing Response.blob().
export class BlobDownloads {
  constructor(){this.entries=new Map();this.disposed=false;}
  start(url){
    if(this.disposed||!url.startsWith('blob:'))throw Error('下载来源无效');
    if(this.entries.has(url))return this.entries.get(url).ready;
    if(this.entries.size>=2)throw Error('最多同时转发两个 Blob 下载');
    const entry={controller:new AbortController(),offset:0};this.entries.set(url,entry);
    entry.ready=fetch(url,{signal:entry.controller.signal}).then(response=>{
      if(!response.ok||!response.body)throw Error('无法读取 Blob 下载');
      const reader=response.body.getReader({mode:'byob'});entry.reader=reader;entry.mime=response.headers.get('content-type')||'application/octet-stream';
      if(this.entries.get(url)!==entry){void reader.cancel().catch(()=>{});throw Error('下载已取消');}return entry;
    });entry.ready.catch(()=>{});return entry.ready;
  }
  async part(url,offset){
    const entry=await this.start(url);
    if(entry.offset!==offset||!Number.isSafeInteger(offset)||entry.reading)throw Error('下载顺序错误');
    entry.reading=true;
    try{
      const {done,value}=await entry.reader.read(new Uint8Array(262144));
      if(this.entries.get(url)!==entry)throw Error('下载已取消');
      const bytes=value||new Uint8Array();if(!Number.isSafeInteger(offset+bytes.length))throw Error('下载偏移超出协议范围');entry.offset+=bytes.length;
      return {bytes,done,mime:entry.mime};
    }finally{entry.reading=false;}
  }
  stop(url){const entry=this.entries.get(url);if(!entry)return;this.entries.delete(url);entry.controller.abort();void entry.reader?.cancel().catch(()=>{});}
  dispose(){this.disposed=true;for(const url of [...this.entries.keys()])this.stop(url);}
}
