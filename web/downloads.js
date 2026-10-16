const blockLimit=256*1024;
export class Downloads {
  constructor(doc,notice,{openFile}={}){this.doc=doc;this.notice=notice;this.files=new Map();this.bytes=0;this.openFile=openFile;this.closed=false;}
  async choose(file){
    if(this.openFile)return this.openFile(file.name);
    const picker=this.doc.defaultView?.showSaveFilePicker;
    if(typeof picker!=='function')throw Error('当前浏览器不支持流式保存，请使用桌面 Chrome 或 Edge');
    const card=this.doc.createElement('div'),button=this.doc.createElement('button'),cancel=this.doc.createElement('button');
    button.type=cancel.type='button';button.textContent='保存 '+file.name;cancel.textContent='取消';card.append(button,cancel);file.card=card;
    this.doc.getElementById('downloads').append(card);
    // Show outside the collapsed settings, so a pending file choice is visible.
    const settings=this.doc.getElementById('share-settings');if(settings)settings.hidden=false;
    this.doc.getElementById('share-settings-toggle')?.setAttribute('aria-expanded','true');
    this.notice('请选择保存位置：'+file.name);
    return new Promise((resolve,reject)=>{
      file.rejectChoice=reject;cancel.onclick=()=>reject(Error('访问者取消下载'));
      button.onclick=async()=>{if(button.disabled)return;button.disabled=true;
        try{const handle=await picker.call(this.doc.defaultView,{suggestedName:file.name});const writer=await handle.createWritable();if(file.cancelled){await writer.abort();return;}resolve(writer);}catch(error){reject(error);}
      };
    });
  }
  async accept(meta,bytes){
    if(this.closed)throw Error('下载接收已关闭');
    if(!meta||typeof meta.id!=='string'||meta.id.length>80)throw Error('下载标识无效');
    if(meta.error){await this.drop(meta.id);this.notice(meta.error);return null;}
    if(!Number.isSafeInteger(meta.offset)||meta.offset<0||!(bytes instanceof Uint8Array)||bytes.length>blockLimit||!Number.isSafeInteger(meta.offset+bytes.length))throw Error('下载分块无效');
    let file=this.files.get(meta.id);
    if(!file){if(meta.offset!==0||this.files.size>=2)throw Error('下载顺序错误或并发过多');file={size:0,name:String(meta.name||'download').replace(/[\\/\x00-\x1f]/g,'_').slice(0,200)};this.files.set(meta.id,file);}
    if(file.busy)throw Error('上一下载块尚未保存');file.busy=true;this.bytes+=bytes.length;
    clearTimeout(file.timer);file.timer=setTimeout(()=>void this.drop(meta.id).then(()=>this.notice('下载连接超时，请重新下载')),120000);
    try{
      if(file.size!==meta.offset)throw Error('下载块顺序错误');
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
      if(hash!==meta.sha256)throw Error('下载数据校验失败');
      if(!file.writer)file.writer=await this.choose(file);
      if(file.cancelled){await file.writer.abort().catch(()=>{});throw Error('下载已取消');}
      if(bytes.length)await file.writer.write(bytes);
      if(file.cancelled)throw Error('下载已取消');file.size+=bytes.length;
      if(meta.done){await file.writer.close();clearTimeout(file.timer);this.files.delete(meta.id);file.card?.remove();this.notice('已保存下载：'+file.name);}
      return {id:meta.id,offset:file.size};
    }catch(error){await this.drop(meta.id);throw error;}
    finally{this.bytes-=bytes.length;file.busy=false;}
  }
  async drop(id){const file=this.files.get(id);if(!file)return;this.files.delete(id);file.cancelled=true;clearTimeout(file.timer);file.rejectChoice?.(Error('下载已取消'));file.card?.remove();try{await file.writer?.abort();}catch{}}
  async dispose(){this.closed=true;await Promise.all([...this.files.keys()].map(id=>this.drop(id)));}
}
