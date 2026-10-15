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
