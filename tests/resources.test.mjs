import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ResourceBridge} from '../extension/resources.js';
import {Resources} from '../web/resources.js';

test('early assets survive compressed DOM and rapid navigation; retired documents are discarded',async()=>{
  const resources=new Resources('room','key',()=>{}),bytes=new Uint8Array([1,2,3]);
  const sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const add=async version=>{await resources.add({id:version+'_0',size:bytes.length,mime:'image/png',sha256},bytes);await Promise.all(resources.pending.values());};
  try{
    resources.keepVersion('v1');await add('v1');await add('v2');await add('v3');
    resources.keepVersion('v2');assert.ok(resources.resolve('ts-asset:v2_0').startsWith('blob:'));
    assert.equal(resources.resolve('ts-asset:v1_0'),'');
    resources.keepVersion('v3');assert.ok(resources.resolve('ts-asset:v3_0').startsWith('blob:'));
    await add('v1');await add('v2');assert.equal(resources.urls.size,1);
    assert.equal(resources.bytes,bytes.length,'identical bytes share one blob');
    for(let i=4;i<12;i++)await add('v'+i);
    assert.equal(resources.future.size,4);assert.equal(resources.urls.size,5,'future document staging is bounded');
  }finally{resources.dispose();}
});

test('already delivered resources do not consume the transfer budget',async()=>{
  const bridge=new ResourceBridge(async()=>{},async()=>{});bridge.scan=async()=>{};
  const waits=[];bridge.wait=async ms=>waits.push(ms);
  bridge.done.set('cached',{bytes:new Uint8Array(256*1024),mime:'image/png',sent:new Set(['room'])});
  await bridge.transfer([{id:'cached'}],['room'],{deliver:async()=>({relay:false,sentBytes:0})});
  assert.deepEqual(waits,[]);
  await bridge.transfer([{id:'cached'}],['room'],{deliver:async()=>({relay:false,sentBytes:256*1024})});
  assert.deepEqual(waits,[1000]);
  bridge.dispose();
});

test('overlapping resource requests are deduplicated and disposal cancels budget waits',async()=>{
  const bridge=new ResourceBridge(async()=>{},async()=>{});let release;
  bridge.scan=()=>new Promise(resolve=>{release=resolve;});let deliveries=0;
  bridge.done.set('cached',{bytes:new Uint8Array(1024),mime:'image/png',sent:new Set()});
  const config={deliver:async()=>{deliveries++;return {relay:false,sentBytes:0};}};
  const first=bridge.transfer([{id:'cached'}],['room'],config);
  const second=bridge.transfer([{id:'cached'}],['room'],config);release();
  await Promise.all([first,second]);assert.equal(deliveries,1);
  const waiting=bridge.wait(30000);bridge.dispose();await waiting;
  assert.equal(bridge.pendingTransfers.size,0);
});

test('a discarded relay upload or transport switch cannot leave a stale delivered mark',async()=>{
  const bridge=new ResourceBridge(async()=>{},async()=>{}),fetch=globalThis.fetch;bridge.scan=async()=>{};bridge.wait=async()=>{};
  const item={bytes:new Uint8Array([1]),mime:'image/png',sent:new Set()};bridge.done.set('doc_0',item);
  try{
    for(const [status,needed,expected] of [[202,true,false],[200,false,false],[201,true,true]]){
      item.sent.clear();globalThis.fetch=async()=>new Response('{}',{status});
      await bridge.transfer([{id:'doc_0'}],['room'],{server:'http://localhost',relayNeeded:()=>needed,deliver:async()=>({relay:true,sentBytes:0})});
      assert.equal(item.sent.has('room'),expected);
    }
  }finally{globalThis.fetch=fetch;bridge.dispose();}
});
