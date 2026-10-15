import test from 'node:test';
import assert from 'node:assert/strict';
import {pasteImage,maxClipboardImage} from '../web/clipboard.js';
test('clipboard images use the authenticated peer asset channel and preserve their target',async()=>{
 let received;const bytes=new Uint8Array([137,80,78,71]),file=new File([bytes],'photo.png',{type:'image/png'});
 await pasteImage(file,{session:'room',key:'secret',viewerId:'viewer',peer:{ready:true,sendAsset:async(meta,data)=>{received={meta,data};return true;}},selection:{version:'v1',nodeId:'3'}});
 assert.equal(received.meta.kind,'clipboard-image');assert.equal(received.meta.nodeId,'3');assert.equal(received.meta.version,'v1');assert.deepEqual(received.data,bytes);
 await assert.rejects(pasteImage(new File(['<svg/>'],'photo.svg',{type:'image/svg+xml'}),{}),/PNG/);
 await assert.rejects(pasteImage(new File([new Uint8Array(maxClipboardImage+1)],'big.png',{type:'image/png'}),{}),/4 MiB/);
});
