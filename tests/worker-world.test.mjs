import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DocumentState} from '../extension/document-state.js';
import {compressPacket} from '../extension/peer.js';
import {installDOM,captureDOM} from '../extension/dom-capture.js';

const source=(await readFile(new URL('../extension/worker.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
async function worker(command,clock){
  const listeners={onEvent:[],onDetach:[]},event=key=>({addListener:fn=>listeners[key]?.push(fn)}),calls=[],writes=[];
  class Bridge{constructor() {this.done=new Map();}async scan(){}dispose(){this.disposed=true;}transfer(){return Promise.resolve();}}
  const chrome={storage:{session:{get:async()=>({epoch:'test-epoch'}),set:async()=>{}},local:{get:async()=>({enabled:false,agentId:'test-agent',server:'http://localhost'}),set:async()=>{}}},
    debugger:{onEvent:event('onEvent'),onDetach:event('onDetach'),sendCommand:async({tabId},method,params)=>{calls.push({tabId,method,params});return command(method,params);}},
    tabs:{onCreated:event(),onRemoved:event(),onUpdated:event()},runtime:{onMessage:event(),onStartup:event()},alarms:{create(){},onAlarm:event()}};
  class Socket{static OPEN=1;}
  const sandbox={chrome,crypto,TextEncoder,TextDecoder,console,DocumentState,compressPacket,ResourceBridge:Bridge,installDOM,captureDOM,WebSocket:Socket,setTimeout,clearTimeout,setInterval,clearInterval,writes,...clock?.globals};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);await vm.runInContext('boot',sandbox);
  vm.runInContext("targets.set(7,{sessions:new Set(['room']),document:new DocumentState(),mode:'dom',contextId:null,nextSend:0});socket={readyState:WebSocket.OPEN,bufferedAmount:0,send:text=>writes.push(JSON.parse(text))}",sandbox);
  return {calls,writes,target:vm.runInContext('targets.get(7)',sandbox),run:code=>vm.runInContext(code,sandbox),event:(method,params)=>listeners.onEvent[0]({tabId:7},method,params),navigate:()=>listeners.onEvent[0]({tabId:7},'Page.frameNavigated',{frame:{id:'next'}})};
}
function fakeClock(){let now=1000,next=0;const timers=new Map();return {globals:{Date:class extends Date{static now(){return now;}},setTimeout(fn,ms){const id=++next;timers.set(id,{fn,due:now+ms});return id;},clearTimeout(id){timers.delete(id);}},advance(ms){const end=now+ms;for(;;){const entry=[...timers].filter(([,v])=>v.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!entry)break;now=entry[1].due;timers.delete(entry[0]);entry[1].fn();}now=end;}};}
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
 const evaluations=w.calls.filter(c=>c.method==='Runtime.evaluate');
 assert.ok(evaluations.every(c=>c.params.contextId===42||c.params.contextId===undefined&&c.params.expression.includes('tabshare.downloadHook')),'old world must not execute after navigation');
 assert.equal(evaluations.filter(c=>c.params.contextId===undefined).length,1,'only the scoped native download hook runs in the page world');
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

test('interactive wake preempts polling and background video without postponement',async()=>{
 const clock=fakeClock(),w=await worker(normal,clock);
 w.run('globalThis.captured=[];snapshot=()=>captured.push(Date.now());targets.get(7).lastSent=Date.now();targets.get(7).nextSend=Date.now()+1000;targets.get(7).videoFPS=2');
 w.run('requestSnapshot(7,false)');clock.advance(10);w.run('requestSnapshot(7,true)');
 for(let i=0;i<5;i++){clock.advance(1);w.run('requestSnapshot(7,true)');}
 assert.equal(w.run('captured.length'),0);clock.advance(1);assert.equal(w.run('captured[0]'),1016,'continuous changes cannot debounce away the first frame deadline');
});
test('wakeups preserve byte backpressure and reject other execution contexts or retired documents',async()=>{
 const clock=fakeClock(),w=await worker(normal,clock);
 w.run('globalThis.captured=[];snapshot=()=>captured.push(Date.now());Object.assign(targets.get(7),{contextId:42,documentReady:true,lastSent:1000,byteDelayUntil:1500});targets.get(7).document.version="live"');
 for(const [context,version] of [[41,'live'],[42,'old']])w.event('Runtime.bindingCalled',{name:'__tabShareWake',executionContextId:context,payload:JSON.stringify({version,urgent:true})});
 clock.advance(100);assert.equal(w.run('captured.length'),0);assert.equal(w.target.wakeTimer,undefined);
 w.event('Runtime.bindingCalled',{name:'__tabShareWake',executionContextId:42,payload:JSON.stringify({version:'live',urgent:true})});
 clock.advance(399);assert.equal(w.run('captured.length'),0);clock.advance(1);assert.equal(w.run('captured[0]'),1500);
});
