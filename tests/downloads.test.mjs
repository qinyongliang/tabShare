import test from 'node:test';
import assert from 'node:assert/strict';
import {Downloads} from '../web/downloads.js';
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const document=()=>({links:[],createElement(){return {click(){this.clicked=true;},remove(){this.removed=true;}};},getElementById(){return {append:link=>this.links.push(link)};}});
test('download chunks preserve bytes and filename in a native download link',async t=>{
 const doc=document(),notices=[],downloads=new Downloads(doc,m=>notices.push(m));t.after(()=>downloads.dispose());
 const a=new Uint8Array([0,255,12]),b=new Uint8Array([33,88]);
 await downloads.accept({id:'file',offset:0,name:'../report.bin',mime:'application/octet-stream',sha256:await digest(a)},a);
 assert.equal(doc.links.length,0);
 await downloads.accept({id:'file',offset:a.length,done:true,sha256:await digest(b)},b);
 assert.equal(doc.links.length,1);assert.equal(doc.links[0].download,'.._report.bin');assert.equal(doc.links[0].clicked,true);
 assert.deepEqual(new Uint8Array(await(await fetch(doc.links[0].href)).arrayBuffer()),new Uint8Array([...a,...b]));
 assert.equal(downloads.files.size,0);assert.equal(downloads.bytes,5);
});
test('corrupt or interrupted downloads release partial memory without offering a file',async t=>{
 const doc=document(),downloads=new Downloads(doc,()=>{});t.after(()=>downloads.dispose());const bytes=new Uint8Array([1,2,3]);
 await downloads.accept({id:'file',offset:0,sha256:await digest(bytes)},bytes);assert.equal(downloads.bytes,3);
 await downloads.accept({id:'file',offset:3,sha256:'wrong',done:true},bytes);assert.equal(downloads.bytes,0);assert.equal(doc.links.length,0);
 await downloads.accept({id:'file',offset:0,sha256:await digest(bytes)},bytes);await downloads.accept({id:'file',error:'disconnected'},new Uint8Array());assert.equal(downloads.bytes,0);assert.equal(downloads.files.size,0);
});
