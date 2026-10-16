import test from 'node:test';
import assert from 'node:assert/strict';
import {PeerLink} from '../extension/peer.js';
function pair(){
 const previous=globalThis.RTCPeerConnection;globalThis.RTCPeerConnection=class{close(){}};
 const received=[],packets=[],receiver=new PeerLink({signal(){},asset:(meta,data)=>received.push({meta,data})}),sender=new PeerLink({signal(){}});
 const inbound={label:'assets',readyState:'open',bufferedAmount:0,close(){},addEventListener(){},removeEventListener(){}};
 const outbound={...inbound,send(packet){packets.push(new DataView(packet.buffer).getUint32(0));inbound.onmessage({data:packet.buffer.slice(0)});}};
 receiver.channel(inbound);sender.channel(outbound);receiver.ready=sender.ready=true;
 return {sender,receiver,received,packets,close(){sender.close();receiver.close();globalThis.RTCPeerConnection=previous;}};
}
test('P2P assets interleave by fragment; small icons finish ahead of a large image',async()=>{
 const p=pair();try{
  const large=p.sender.sendAsset({id:'large'},new Uint8Array(2*1024*1024));
  const icons=Array.from({length:12},(_,i)=>p.sender.sendAsset({id:'icon_'+i},new Uint8Array(500).fill(i)));
  assert.ok((await Promise.all([large,...icons])).every(Boolean));await p.receiver.channels.get('assets').decode;
  assert.equal(p.received.length,13);assert.notEqual(p.received[0].meta.id,'large');
  assert.equal(p.received.at(-1).meta.id,'large');assert.equal(p.received.find(x=>x.meta.id==='icon_11').data[0],11);
  assert.equal(p.sender.closed,false);assert.equal(p.receiver.closed,false);assert.equal(p.sender.queued,0);
 }finally{p.close();}
});
test('memory pressure waits instead of dropping peers, without a fixed asset count',async()=>{
 const p=pair();try{
  const jobs=Array.from({length:12},(_,i)=>p.sender.sendAsset({id:'image_'+i},new Uint8Array(2*1024*1024)));
  await Promise.resolve();assert.ok(p.sender.queued<=12*1024*1024);assert.equal(p.sender.closed,false);
  assert.ok((await Promise.all(jobs)).every(Boolean));await p.receiver.channels.get('assets').decode;
  assert.equal(p.received.length,12);assert.equal(p.sender.queued,0);assert.equal(p.receiver.closed,false);
 }finally{p.close();}
});
test('disconnect releases both admitted assets and waiting reservations',async()=>{
 const p=pair();try{
  p.sender.drained=()=>new Promise(resolve=>p.sender.waiters.add(resolve));
  const jobs=Array.from({length:8},(_,i)=>p.sender.sendAsset({id:'image_'+i},new Uint8Array(3*1024*1024)));
  await new Promise(resolve=>setImmediate(resolve));p.sender.close();
  assert.ok((await Promise.all(jobs)).every(value=>value===false));assert.equal(p.sender.queued,0);
 }finally{p.close();}
});
