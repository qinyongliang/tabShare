import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {GeolocationBroker,geolocationHook,validPosition} from '../extension/geolocation.js';
import {VisitorGeolocation} from '../web/geolocation.js';
const owner={sessionId:'room',viewerId:'visitor'},epoch='epoch-1234',id='request-1234';
const position={coords:{latitude:30,longitude:104,accuracy:20,altitude:null,altitudeAccuracy:null,heading:null,speed:null},timestamp:12345};
test('position bounds reject malformed, non-finite and out-of-range results',()=>{
 assert.equal(validPosition(position),true);
 for(const value of [null,{...position,coords:{...position.coords,latitude:91}},{...position,coords:{...position.coords,longitude:Infinity}},{...position,timestamp:NaN},{...position,coords:{...position.coords,accuracy:-1}}])assert.equal(!!validPosition(value),false);
});
test('geolocation broker targets one visitor and rejects unrelated or stale responses',()=>{
 const sent=[],delivered=[],broker=new GeolocationBroker({epoch,origin:'https://source.example',send:(owner,request)=>sent.push({owner,request}),deliver:value=>delivered.push(value)});
 try{
  broker.request({kind:'request',epoch,id,watch:false,options:{timeout:5000}},owner);
  assert.equal(sent.length,1);assert.equal(sent[0].owner,owner);
  assert.equal(broker.respond({...owner,viewerId:'other'},{epoch,id,...position}),false);
  assert.equal(broker.respond(owner,{epoch:'old',id,...position}),false);assert.equal(delivered.length,0);
  assert.equal(broker.respond(owner,{epoch,id,...position}),true);assert.equal(delivered.length,1);assert.equal(broker.pending.size,0);
  assert.equal(sent.at(-1).request.kind,'cancel');
  broker.request({kind:'request',epoch,id,watch:true,options:{}},owner);broker.leave(owner);assert.equal(broker.pending.size,0);assert.equal(delivered.at(-1).error.code,1);
 }finally{broker.dispose();}
});
test('ambiguous visitor selection fails closed without requesting any device location',()=>{
 const sent=[],delivered=[],broker=new GeolocationBroker({epoch,origin:'https://source.example',send:v=>sent.push(v),deliver:v=>delivered.push(v)});
 broker.request({kind:'request',epoch,id,watch:false},null);assert.equal(sent.length,0);assert.equal(delivered[0].error.code,2);broker.dispose();
});
test('source hook proxies one-shot/watch callbacks and restores native methods',()=>{
 const calls=[],timers=new Map();let next=0,nativeCalls=0;
 const geo={getCurrentPosition(){nativeCalls++;},watchPosition(){nativeCalls++;},clearWatch(){nativeCalls++;}},original=geo.getCurrentPosition;
 const context={navigator:{geolocation:geo},isSecureContext:true,queueMicrotask:fn=>fn(),setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),binding:raw=>calls.push(JSON.parse(raw))};context.top=context;
 vm.createContext(context);vm.runInContext('('+geolocationHook.toString()+')('+JSON.stringify(epoch)+',"binding")',context);
 let received;geo.getCurrentPosition(value=>received=value);const request=calls.at(-1);
 assert.equal(nativeCalls,0);assert.equal(request.kind,'request');context.__tabShareGeolocation.resolve({epoch,id:request.id,...position});assert.equal(received.coords.latitude,30);
 assert.equal(received.toJSON().timestamp,12345);
 const watch=geo.watchPosition(()=>{});geo.clearWatch(watch);assert.equal(calls.at(-1).kind,'cancel');
 context.__tabShareGeolocation.dispose();assert.equal(geo.getCurrentPosition,original);assert.equal(timers.size,0);
});
function fakeDocument(){
 class Element{constructor(tag){this.tag=tag;this.children=[];}setAttribute(){}append(...children){this.children.push(...children);}remove(){this.removed=true;}}
 return {createElement:tag=>new Element(tag),body:new Element('body'),defaultView:{navigator:{}}};
}
test('visitor location is opt-in, refusal sends no coordinates, watches stop on reset',()=>{
 const sent=[],calls=[],cleared=[];let success;
 const geo={getCurrentPosition(ok){calls.push('once');ok(position);},watchPosition(ok){calls.push('watch');success=ok;return 7;},clearWatch:id=>cleared.push(id)};
 const bridge=new VisitorGeolocation(fakeDocument(),value=>sent.push(value),geo);
 try{
  bridge.receive({kind:'request',epoch,id,origin:'https://source.example',watch:false,options:{}});assert.equal(calls.length,0);
  bridge.pending.get(id).deny.onclick();assert.equal(calls.length,0);assert.equal(JSON.parse(sent[0].text).error.code,1);
  bridge.receive({kind:'request',epoch,id,origin:'https://source.example',watch:true,options:{}});bridge.pending.get(id).allow.onclick();assert.deepEqual(calls,['watch']);
  success(position);assert.equal(JSON.parse(sent.at(-1).text).coords.latitude,30);
  bridge.reset();assert.deepEqual(cleared,[7]);const count=sent.length;success(position);assert.equal(sent.length,count,'late result after closing never sends coordinates');
 }finally{bridge.reset();}
});
