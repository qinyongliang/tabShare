import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Mirror} from '../web/mirror.js';
import {PeerLink} from '../extension/peer.js';
import {Resources} from '../web/resources.js';

function element(id='1') {
  return {nodeType:1,tagName:'INPUT',type:'text',dataset:{nodeId:id},value:'',style:{setProperty(){},removeProperty(){}},setAttribute(){},removeAttribute(){}};
}
test('sparse input patches reuse unchanged style and attribute maps',()=>{
  const mirror=new Mirror({},null),node=element();
  mirror.properties(node,{id:'1',style:{color:'red',width:'10px'},attrs:{title:'old'},value:'before'});
  const before=mirror.states.get('1');
  for(let i=0;i<1000;i++)mirror.properties(node,{id:'1',value:String(i)});
  const after=mirror.states.get('1');
  assert.equal(after.style,before.style);assert.equal(after.attrs,before.attrs);
  assert.equal(after.value,'999');assert.equal(node.value,'999');assert.equal(before.value,'before');
  mirror.properties(node,{id:'1',style:{color:'blue',width:null},attrs:{title:null}});
  const changed=mirror.states.get('1');assert.deepEqual(changed.style,{color:'blue'});assert.deepEqual(changed.attrs,{});
  assert.deepEqual(before.style,{color:'red',width:'10px'});assert.deepEqual(before.attrs,{title:'old'});
});
test('resource disposal clears accounting maps and tolerates repeated cleanup',async()=>{
  const resources=new Resources('room','key',()=>{}),bytes=new Uint8Array([1,2,3]);
  const sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  resources.keepVersion('v1');await resources.add({id:'v1_0',size:3,mime:'image/png',sha256},bytes);
  await Promise.all(resources.pending.values());assert.equal(resources.bytes,3);
  resources.dispose();resources.dispose();assert.equal(resources.bytes,0);assert.equal(resources.sizes.size,0);assert.equal(resources.hashes.size,0);assert.equal(resources.reserved,0);
});
test('closing peers promptly releases partially received buffers and channel handlers',()=>{
  // Exercise real receive validation and teardown with an inert RTC transport.
  const previous=globalThis.RTCPeerConnection;let closed=0;
  globalThis.RTCPeerConnection=class {close(){closed++;}};
  try{
    const peer=new PeerLink({signal(){}}),channel={label:'state',close(){}};peer.channel(channel);
    const entry=peer.channels.get('state'),bytes=new ArrayBuffer(13),header=new DataView(bytes);
    header.setUint32(0,1);header.setUint32(4,8*1024*1024);header.setUint32(8,0);
    channel.onmessage({data:bytes});assert.equal(entry.parts.size,1);assert.equal(entry.retained,8*1024*1024);
    peer.close();peer.close();assert.equal(entry.parts.size,0);assert.equal(entry.retained,0);assert.equal(peer.channels.size,0);assert.equal(closed,1);
    for(const event of ['onopen','onclose','onerror','onmessage'])assert.equal(channel[event],null);
  }finally{globalThis.RTCPeerConnection=previous;}
});
test('closing a peer during queued decode does not deliver data or underflow accounting',async()=>{
  const previous=globalThis.RTCPeerConnection;globalThis.RTCPeerConnection=class {close(){}};
  try{
    let deliveries=0;const peer=new PeerLink({signal(){},message(){deliveries++;}}),channel={label:'state',close(){}};peer.channel(channel);
    const entry=peer.channels.get('state'),json=new TextEncoder().encode('{"type":"dom"}'),buffer=new ArrayBuffer(13+json.length),view=new DataView(buffer);
    view.setUint32(0,1);view.setUint32(4,json.length+1);new Uint8Array(buffer)[12]=1;new Uint8Array(buffer).set(json,13);
    channel.onmessage({data:buffer});assert.equal(entry.parts.size,0);peer.close();await entry.decode;
    assert.equal(deliveries,0);assert.equal(entry.retained,0);
  }finally{globalThis.RTCPeerConnection=previous;}
});
