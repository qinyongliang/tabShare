import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InputQueue} from '../extension/input-queue.js';

test('a slow tab does not block another tab; queued moves keep button and key order',async()=>{
  const a=new InputQueue(),b=new InputQueue(),events=[];let release;
  const waiting=a.push(()=>new Promise(resolve=>{release=resolve;}));
  const old=a.push(()=>events.push('old move'),'move:viewer');
  const latest=a.push(()=>events.push('latest move'),'move:viewer');
  const click=a.push(()=>events.push('click'));
  const after=a.push(()=>events.push('after click'),'move:viewer');
  await b.push(()=>events.push('other tab'));assert.deepEqual(events,['other tab']);
  release();await Promise.all([waiting,old,latest,click,after]);
  assert.deepEqual(events,['other tab','latest move','click','after click']);
});

test('input accumulation has a bound and cleared pending operations do not execute',async()=>{
  const queue=new InputQueue(1);let release;const waiting=queue.push(()=>new Promise(resolve=>{release=resolve;}));
  const pending=queue.push(()=>assert.fail('cleared input executed'));
  await assert.rejects(queue.push(()=>{}),/full/);queue.clear();assert.equal(await pending,false);release();await waiting;
});
