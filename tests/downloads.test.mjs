import test from 'node:test';
import assert from 'node:assert/strict';
import {Downloads} from '../web/downloads.js';
import {DownloadAcks} from '../extension/download-flow.js';
import {BlobDownloads} from '../extension/blob-download.js';
const digest=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const document=()=>({createElement(){return {remove(){}};},getElementById(){return {append(){}};}});
test('downloads write verified chunks before acknowledging and close without whole-file buffering',async t=>{
 const chunks=[],notices=[];let name,closed=false;
 const downloads=new Downloads(document(),m=>notices.push(m),{openFile:async value=>{name=value;return {write:async bytes=>chunks.push([...bytes]),close:async()=>{closed=true;},abort:async()=>{}};}});t.after(()=>downloads.dispose());
 const a=new Uint8Array([0,255,12]),b=new Uint8Array([33,88]);
 assert.deepEqual(await downloads.accept({id:'file',offset:0,name:'../report.bin',sha256:await digest(a)},a),{id:'file',offset:3});
 assert.deepEqual(await downloads.accept({id:'file',offset:3,done:true,sha256:await digest(b)},b),{id:'file',offset:5});
 assert.equal(name,'.._report.bin');assert.deepEqual(chunks,[[0,255,12],[33,88]]);assert.ok(closed);assert.equal(downloads.files.size,0);assert.equal(downloads.bytes,0);
});
test('files larger than 64 MiB stream with one-block retained memory',async t=>{
 const bytes=new Uint8Array(262144),sha256=await digest(bytes);let total=0,peak=0,closed=false;
 const downloads=new Downloads(document(),()=>{},{openFile:async()=>({write:async data=>{peak=Math.max(peak,downloads.bytes);total+=data.length;},close:async()=>{closed=true;},abort:async()=>{}})});t.after(()=>downloads.dispose());
 for(let i=0;i<288;i++)await downloads.accept({id:'large',offset:i*bytes.length,done:i===287,sha256},bytes);
 assert.equal(total,72*1024*1024);assert.equal(peak,262144);assert.equal(downloads.bytes,0);assert.ok(closed);
});
test('corrupt chunks abort the partial writer and never acknowledge success',async t=>{
 let aborted=0;const downloads=new Downloads(document(),()=>{},{openFile:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{aborted++;}})});t.after(()=>downloads.dispose());const bytes=new Uint8Array([1,2,3]);
 await downloads.accept({id:'file',offset:0,sha256:await digest(bytes)},bytes);
 await assert.rejects(downloads.accept({id:'file',offset:3,sha256:'wrong',done:true},bytes),/校验/);
 assert.equal(aborted,1);assert.equal(downloads.bytes,0);assert.equal(downloads.files.size,0);
});
test('disk backpressure and disconnect release only after the pending write settles',async()=>{
 let release,aborted=0;const downloads=new Downloads(document(),()=>{},{openFile:async()=>({write:()=>new Promise(r=>{release=r;}),abort:async()=>{aborted++;},close:async()=>{}})}),bytes=new Uint8Array([1]);
 const job=downloads.accept({id:'slow',offset:0,sha256:await digest(bytes)},bytes);job.catch(()=>{});
 while(!release)await new Promise(r=>setTimeout(r,1));assert.equal(downloads.bytes,1);await downloads.dispose();release();await assert.rejects(job,/取消/);assert.equal(downloads.bytes,0);assert.equal(aborted,1);
});
test('download ACKs bind to recipient and exact persisted offset',async()=>{
 const flow=new DownloadAcks(),owner={sessionId:'room',viewerId:'one'},pending=flow.wait('file',100,owner);
 assert.equal(flow.accept({...owner,viewerId:'two'},{id:'file',offset:100}),false);assert.equal(flow.accept(owner,{id:'file',offset:99}),false);
 assert.equal(flow.accept(owner,{id:'file',offset:100}),true);await pending;assert.equal(flow.pending.size,0);
 const second=flow.wait('file',200,owner);flow.leave(owner);await assert.rejects(second,/断开/);flow.dispose();
});
test('Blob URLs use bounded byte-stream reads and stop cancels the fetch',async()=>{
 const original=globalThis.fetch;let produced=0,aborted=false;
 globalThis.fetch=async(url,{signal})=>{signal.addEventListener('abort',()=>{aborted=true;});return {ok:true,headers:new Headers({'content-type':'application/octet-stream'}),body:new ReadableStream({type:'bytes',pull(controller){controller.enqueue(new Uint8Array(65536));if(++produced===1100)controller.close();}})};};
 const downloads=new BlobDownloads();
 try{let offset=0;for(;;){const part=await downloads.part('blob:test',offset);assert.ok(part.bytes.length<=262144);offset+=part.bytes.length;if(part.done)break;}assert.equal(offset,1100*65536);downloads.stop('blob:test');assert.ok(aborted);assert.equal(downloads.entries.size,0);}
 finally{downloads.dispose();globalThis.fetch=original;}
});
