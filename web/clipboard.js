const types=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export const maxClipboardImage=4*1024*1024;
export async function pasteImage(file,{session,key,viewerId,peer,selection}){
  if(!types.has(file.type)||file.size>maxClipboardImage)throw Error('图片仅支持 PNG、JPEG、WebP、GIF，最大 4 MiB');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const meta={kind:'clipboard-image',mime:file.type,name:(file.name||'clipboard.png').slice(0,128),...selection};
  if(peer?.ready&&await peer.sendAsset(meta,bytes))return;
  const response=await fetch('/api/clipboard/'+encodeURIComponent(session),{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':file.type,'X-Viewer-ID':viewerId,'X-Document-Version':selection.version||'','X-Node-ID':selection.nodeId||''},body:bytes});
  if(!response.ok)throw Error(response.status===429?'粘贴过于频繁，请稍后重试':'图片粘贴失败，请检查连接');
}

// Preserve all text, including CJK/emoji, while respecting both raw-text and
// JSON-envelope byte limits on the existing authenticated input protocol.
export function textPastePackets(text,selection={}){
  if(typeof text!=='string')throw Error('剪贴板文本格式无效');
  const encoder=new TextEncoder();
  if(encoder.encode(text).length>256*1024)throw Error('单次文本粘贴最多 256 KiB，请分段粘贴');
  const chunks=[];let chunk='',bytes=0,encoded=0;
  for(const char of text){
    const code=char.codePointAt(0),size=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
    // JSON escapes control characters and isolated UTF-16 surrogates. Count
    // bytes arithmetically instead of allocating two buffers per code point.
    const wire=code===34||code===92?2:code<32?([8,9,10,12,13].includes(code)?2:6):code>=0xd800&&code<=0xdfff?6:size;
    if(bytes+size>8192||encoded+wire>12000){chunks.push(chunk);chunk='';bytes=encoded=0;}
    chunk+=char;bytes+=size;encoded+=wire;
  }
  if(chunk)chunks.push(chunk);
  // Only the first chunk replaces the selection. Following chunks append at
  // the source's resulting caret, in the same ordered input queue.
  return chunks.map((text,index)=>({action:'text',text,...(index===0?selection:{...(selection.nodeId?{nodeId:selection.nodeId}:{})})}));
}
export function clipboardShortcut(event){return !event.altKey&&(event.ctrlKey||event.metaKey)&&['c','v','x'].includes(event.key.toLowerCase());}
export function selectedText(doc,target){
  if(target?.tagName==='INPUT'&&target.type==='password')return '';
  if(typeof target?.selectionStart==='number'&&typeof target?.selectionEnd==='number')return target.value.slice(target.selectionStart,target.selectionEnd);
  return doc.getSelection()?.toString()||'';
}
