import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {validPeerInput} from '../extension/controller.js';
import {DocumentState} from '../extension/document-state.js';

test('direct input rejects scripts, forged internal commands and oversized values',()=>{
 for(const input of [{action:'history',entryId:0},{action:'history',entryId:1.1},{action:'history',entryId:2147483648},{action:'mode',mode:'raster'},{action:'Runtime.evaluate',text:'alert(1)'},{action:'viewportRelease',viewerId:'other-viewer'},{action:'navigate',url:'javascript:alert(1)'},{action:'text',text:'x'.repeat(8193)},{action:'mouseWheel',x:NaN,y:0},{action:'viewport',width:3840,height:2160,deviceScaleFactor:2},{action:'selection',nodeId:'n1',selection:{anchorOffset:100001}}])assert.equal(validPeerInput(input),false);
 for(const input of [{action:'history',entryId:42},{action:'text',text:'你好'},{action:'viewport',width:390,height:720,deviceScaleFactor:2},{action:'mousePressed',x:.5,y:.5,nodeId:'n1',button:'left',buttons:1},{action:'selection',nodeId:'n1',selection:{start:0,end:3}},{action:'navigate',url:'https://example.com'}])assert.equal(validPeerInput(input),true);
});
test('late join cache merges styles, deleted attributes, children and CSS without mutating queued snapshots',()=>{
 const state=new DocumentState();state.apply({reset:true,version:'v1',sequence:1,root:'a',meta:{width:100},css:'.a{}',nodes:[{id:'a',attrs:{title:'old'},style:{color:'red',width:'10px'},children:['b']},{id:'b',text:'old'}]});
 const before=state.snapshot();state.apply({version:'v1',sequence:2,root:'a',meta:{width:200},css:'.b{}',nodes:[{id:'c',text:'new'}],updates:[{id:'a',changes:{style:{color:'blue',width:null},attrs:{title:null},children:['c']}}],removes:['b']});
 const after=state.snapshot();assert.deepEqual(after.nodes.map(n=>n.id),['a','c']);assert.deepEqual(after.nodes[0].style,{color:'blue'});assert.deepEqual(after.nodes[0].attrs,{});assert.equal(after.css,'.b{}');assert.equal(after.sequence,2);assert.equal(before.nodes[0].style.color,'red');assert.equal(before.nodes[0].attrs.title,'old');
 state.apply({version:'v1',sequence:3,root:'a',updates:[],css:'',cssChanged:true});assert.equal(state.snapshot().css,'','late joins retain CSS deletion');
 state.apply({reset:true,version:'v2',sequence:1,root:'z',nodes:[{id:'z'}],meta:{width:300}});assert.deepEqual(state.snapshot().nodes,[{id:'z'}]);
});
test('extension and viewer ship the same peer protocol',async()=>{
 assert.equal(await readFile(new URL('../extension/draggable.js',import.meta.url),'utf8'),await readFile(new URL('../web/draggable.js',import.meta.url),'utf8'));
 assert.equal(await readFile(new URL('../extension/peer.js',import.meta.url),'utf8'),await readFile(new URL('../web/peer.js',import.meta.url),'utf8'));
});

test('large JSON packets compress losslessly with a bounded decoder',async()=>{
 const {compressPacket,decodeJSONPacket}=await import('../extension/peer.js');
 const message={type:'dom',nodes:Array.from({length:500},(_,i)=>({id:String(i),style:{color:'rgb(1,2,3)',width:'100px',display:'block'}}))};
 const json=new TextEncoder().encode(JSON.stringify(message)),bytes=new Uint8Array(json.length+1);bytes[0]=1;bytes.set(json,1);
 const packed=await compressPacket(bytes);assert.equal(packed[0],3);assert.ok(packed.length<bytes.length/4);
 assert.deepEqual(await decodeJSONPacket(packed),message);
 await assert.rejects(decodeJSONPacket(packed,100),/budget/);
 const wrong=packed.slice();new DataView(wrong.buffer).setUint32(1,100);await assert.rejects(decodeJSONPacket(wrong),/budget|length/);
 const corrupt=packed.slice();corrupt.fill(0,5);await assert.rejects(decodeJSONPacket(corrupt));
 const small=new Uint8Array([1,...new TextEncoder().encode('{"type":"input"}')]);assert.equal(await compressPacket(small),small);
});

test('video encoding budgets respond to loss, CPU, RTT, display size and foreground recovery',async()=>{
 const {encodingPolicy}=await import('../extension/peer.js');
 const size={width:1920,height:1080},profile={width:960,height:540,visible:true};
 assert.equal(encodingPolicy(size,profile).scaleResolutionDownBy,2);
 for(const network of [{loss:.08},{cpu:true},{encodeMs:40},{rtt:.4}])assert.equal(encodingPolicy(size,profile,network).maxFramerate,15);
 assert.equal(encodingPolicy(size,profile,{available:500000}).maxBitrate,400000);
 assert.deepEqual(encodingPolicy(size,{...profile,visible:false}),{scaleResolutionDownBy:2,maxFramerate:2,maxBitrate:150000});
 assert.equal(encodingPolicy(size,profile,{}).maxFramerate,30);
 assert.equal(encodingPolicy({width:7680,height:4320},{width:4096,height:4096,visible:true}).scaleResolutionDownBy,2,'large native tracks obey the encoded pixel budget');
});
