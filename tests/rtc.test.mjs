import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {validPeerInput} from '../extension/controller.js';
import {DocumentState} from '../extension/document-state.js';

test('direct input rejects scripts, forged internal commands and oversized values',()=>{
 for(const input of [{action:'Runtime.evaluate',text:'alert(1)'},{action:'viewportRelease',viewerId:'other-viewer'},{action:'navigate',url:'javascript:alert(1)'},{action:'text',text:'x'.repeat(8193)},{action:'mouseWheel',x:NaN,y:0},{action:'viewport',width:3840,height:2160,deviceScaleFactor:2},{action:'selection',nodeId:'n1',selection:{anchorOffset:100001}}])assert.equal(validPeerInput(input),false);
 for(const input of [{action:'text',text:'你好'},{action:'viewport',width:390,height:720,deviceScaleFactor:2},{action:'mousePressed',x:.5,y:.5,nodeId:'n1',button:'left',buttons:1},{action:'selection',nodeId:'n1',selection:{start:0,end:3}},{action:'navigate',url:'https://example.com'}])assert.equal(validPeerInput(input),true);
});
test('late join cache merges styles, deleted attributes, children and CSS without mutating queued snapshots',()=>{
 const state=new DocumentState();state.apply({reset:true,version:'v1',sequence:1,root:'a',meta:{width:100},css:'.a{}',nodes:[{id:'a',attrs:{title:'old'},style:{color:'red',width:'10px'},children:['b']},{id:'b',text:'old'}]});
 const before=state.snapshot();state.apply({version:'v1',sequence:2,root:'a',meta:{width:200},css:'.b{}',nodes:[{id:'c',text:'new'}],updates:[{id:'a',changes:{style:{color:'blue',width:null},attrs:{title:null},children:['c']}}],removes:['b']});
 const after=state.snapshot();assert.deepEqual(after.nodes.map(n=>n.id),['a','c']);assert.deepEqual(after.nodes[0].style,{color:'blue'});assert.deepEqual(after.nodes[0].attrs,{});assert.equal(after.css,'.b{}');assert.equal(after.sequence,2);assert.equal(before.nodes[0].style.color,'red');assert.equal(before.nodes[0].attrs.title,'old');
 state.apply({reset:true,version:'v2',sequence:1,root:'z',nodes:[{id:'z'}],meta:{width:300}});assert.deepEqual(state.snapshot().nodes,[{id:'z'}]);
});
test('extension and viewer ship the same peer protocol',async()=>{
 assert.equal(await readFile(new URL('../extension/peer.js',import.meta.url),'utf8'),await readFile(new URL('../web/peer.js',import.meta.url),'utf8'));
});
