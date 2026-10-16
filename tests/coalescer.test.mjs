import test from 'node:test';
import assert from 'node:assert/strict';
import {Coalescer} from '../web/coalescer.js';
function fixture(){let callback,cancelled=0,scheduled=0;const deliveries=[];const queue=new Coalescer((key,value)=>deliveries.push([key,value]),{schedule:fn=>{callback=fn;return ++scheduled;},cancel:()=>cancelled++});return{queue,deliveries,tick:()=>callback(),counts:()=>({cancelled,scheduled})};}
test('continuous scroll publishes latest state without waiting for idle',()=>{const f=fixture();for(let i=0;i<100;i++)f.queue.push('root',i);assert.equal(f.counts().scheduled,1);f.tick();assert.deepEqual(f.deliveries,[['root',99]]);f.queue.push('root',100);f.tick();assert.equal(f.deliveries.length,2);});
test('different scrolling containers keep independent final coordinates',()=>{const f=fixture();f.queue.push('left',1);f.queue.push('right',3);f.queue.push('left',2);f.tick();assert.deepEqual(f.deliveries,[['left',2],['right',3]]);});
test('navigation and disconnect discard pending coordinates',()=>{const f=fixture();f.queue.push('old',1);f.queue.clear();f.tick();assert.deepEqual(f.deliveries,[]);assert.equal(f.counts().cancelled,1);f.queue.push('new',2);f.tick();assert.deepEqual(f.deliveries,[['new',2]]);});
test('reentrant delivery schedules a new batch instead of losing updates',()=>{const callbacks=[],out=[];let q;q=new Coalescer((key,value)=>{out.push(value);if(value===1)q.push(key,2);},{schedule:fn=>{callbacks.push(fn);return callbacks.length;}});q.push('a',1);callbacks.shift()();callbacks.shift()();assert.deepEqual(out,[1,2]);});
