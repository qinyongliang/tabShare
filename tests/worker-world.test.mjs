import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DocumentState} from '../extension/document-state.js';
import {installDOM,captureDOM} from '../extension/dom-capture.js';

const source=(await readFile(new URL('../extension/worker.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
async function worker(command){
  const listeners={onEvent:[],onDetach:[]},event=key=>({addListener:fn=>listeners[key]?.push(fn)}),calls=[],writes=[];
  class Bridge{constructor() {this.done=new Map();}async scan(){}dispose(){this.disposed=true;}transfer(){return Promise.resolve();}}
  const chrome={storage:{session:{get:async()=>({epoch:'test-epoch'}),set:async()=>{}},local:{get:async()=>({enabled:false,agentId:'test-agent',server:'http://localhost'}),set:async()=>{}}},
    debugger:{onEvent:event('onEvent'),onDetach:event('onDetach'),sendCommand:async({tabId},method,params)=>{calls.push({tabId,method,params});return command(method,params);}},
    tabs:{onCreated:event(),onRemoved:event(),onUpdated:event()},runtime:{onMessage:event(),onStartup:event()},alarms:{create(){},onAlarm:event()}};
  class Socket{static OPEN=1;}
  const sandbox={chrome,crypto,TextEncoder,TextDecoder,console,DocumentState,ResourceBridge:Bridge,installDOM,captureDOM,WebSocket:Socket,setTimeout,clearTimeout,setInterval,clearInterval,writes};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);await vm.runInContext('boot',sandbox);
  vm.runInContext("targets.set(7,{sessions:new Set(['room']),document:new DocumentState(),mode:'dom',contextId:null,nextSend:0});socket={readyState:WebSocket.OPEN,bufferedAmount:0,send:text=>writes.push(JSON.parse(text))}",sandbox);
  return {calls,writes,target:vm.runInContext('targets.get(7)',sandbox),run:code=>vm.runInContext(code,sandbox),navigate:()=>listeners.onEvent[0]({tabId:7},'Page.frameNavigated',{frame:{id:'next'}})};
}
const normal=(method)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'frame'}}}:method==='Page.createIsolatedWorld'?{executionContextId:42}:method==='DOM.getDocument'?{root:{}}:{result:{value:null}};

test('parallel capture, raster and input wait for one fully initialized isolated world',async()=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const w=await worker(async(method,p)=>{if(method==='Page.createIsolatedWorld'){entered();await gate;}return normal(method,p);});
 const a=w.run('world(7)'),b=w.run('world(7)'),c=w.run('world(7)');await ready;
 assert.equal(w.calls.filter(c=>c.method==='Page.createIsolatedWorld').length,1);release();
 assert.deepEqual(await Promise.all([a,b,c]),[42,42,42]);
 assert.equal(w.calls.filter(c=>c.method==='Runtime.evaluate'&&c.params.expression===installDOM).length,1);
 w.target.contextId=null;const before=w.calls.length;
 await assert.rejects(w.run('evaluate(7,"1")'),/正在切换/);assert.equal(w.calls.length,before,'null context must never reach CDP');
});

test('navigation discards an initializing world and the next attempt creates a fresh one',async()=>{
 let entered,release,created=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const w=await worker(async(method,p)=>{if(method==='Page.createIsolatedWorld'){created++;if(created===1){entered();await gate;}return {executionContextId:40+created};}return normal(method,p);});
 const first=w.run('world(7)');await ready;w.navigate();release();await assert.rejects(first,/正在切换/);
 assert.equal(w.target.contextId,null);assert.equal(await w.run('world(7)'),42);
 assert.ok(w.calls.filter(c=>c.method==='Runtime.evaluate').every(c=>c.params.contextId===42),'old world must not execute after navigation');
});

test('capture timeout retries bounded DOM without switching the page to video',async()=>{
 const delta={version:'live',sequence:1,reset:true,root:'1',nodes:[{id:'1',tag:'body',children:[]}],meta:{mode:'dom',truncated:true,width:1280,height:720}};
 let calls=0;const w=await worker(async(method,p)=>{
  if(method==='Runtime.evaluate'&&p.expression===captureDOM){if(++calls===1)throw Error('Runtime.evaluate: Execution was terminated');return {result:{value:delta}};}
  return normal(method,p);
 });
 await w.run('snapshot(7)');assert.equal(w.target.captureLimited,true);assert.equal(w.target.contextId,42);
 await w.run('snapshot(7)');assert.equal(w.target.document.nodes.size,1);assert.equal(w.writes.at(-1).type,'dom');
 assert.equal(w.calls.filter(c=>c.method==='Page.createIsolatedWorld').length,1);
});

test('foreground screencast updates stop the old capture before applying a new frame interval',async()=>{
 const w=await worker(normal);w.target.streaming=true;w.target.videoFPS=2;
 await w.run('configureScreencast(7)');w.target.videoFPS=30;await w.run('configureScreencast(7)');
 const commands=w.calls.filter(c=>c.method==='Page.startScreencast'||c.method==='Page.stopScreencast');
 assert.deepEqual(commands.map(c=>c.method),['Page.stopScreencast','Page.startScreencast','Page.stopScreencast','Page.startScreencast']);
 assert.equal(commands[1].params.everyNthFrame,15);assert.equal(commands[3].params.everyNthFrame,1);
});

test('destroyed execution contexts recover without publishing the raw CDP error',async()=>{
 let captures=0;const delta={version:'new',sequence:1,reset:true,root:'1',nodes:[{id:'1',tag:'body',children:[]}],meta:{mode:'dom',width:100,height:100}};
 const w=await worker(async(method,p)=>{if(method==='Runtime.evaluate'&&p.expression===captureDOM){if(++captures===1)throw Error('{"code":-32000,"message":"Cannot find context with specified id"}');return {result:{value:delta}};}return normal(method,p);});
 await w.run('snapshot(7)');assert.equal(w.target.contextId,null);assert.ok(!w.writes.some(m=>m.type==='status'&&m.status==='error'));
 await w.run('snapshot(7)');assert.equal(w.target.document.version,'new');assert.equal(w.target.documentReady,true);
});
