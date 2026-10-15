import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTab, cdpInput, serverOrigin, targetURL, rasterFrame} from '../extension/controller.js';

function tabs(initial = []) {
  const values = new Map(initial.map(t => [t.id, t]));
  let created = 0;
  return {
    get: async id => { if (!values.has(id)) throw new Error('closed'); return values.get(id); },
    query: async () => [...values.values()],
    create: async info => { created++; const tab = {id: 100 + created, ...info}; values.set(tab.id, tab); return tab; },
    reload: async () => {},
    remove: id => values.delete(id),
    get created() { return created; }
  };
}
test('URL sharing reuses mapped tab after navigation, opens once after closure', async () => {
  const api = tabs([{id: 1, url: 'https://example.com/next'}]);
  const session = {kind: 'url', url: 'https://example.com/'};
  assert.equal((await resolveTab(api, session, {tabId: 1, epoch: 'one'}, 'one')).id, 1);
  api.remove(1);
  const opened = await resolveTab(api, session, {tabId: 1, epoch: 'one'}, 'one');
  assert.equal(opened.active, false);
  assert.equal((await resolveTab(api, session, {tabId: opened.id, epoch: 'one'}, 'one')).id, opened.id);
  assert.equal(api.created, 1);
});
test('URL sharing finds an already open matching URL', async () => {
  const api = tabs([{id: 9, url: 'https://example.com/#section'}]);
  assert.equal((await resolveTab(api, {kind: 'url', url: 'https://example.com/'}, undefined, 'epoch')).id, 9);
  assert.equal(api.created, 0);
});
test('tab sharing does not open a replacement or reuse IDs across browser restarts', async () => {
  const api = tabs([{id: 1, url: 'https://other.example/'}]);
  await assert.rejects(resolveTab(api, {kind: 'tab', tabId: 1, tabEpoch: 'old'}, undefined, 'new'));
  await assert.rejects(resolveTab(api, {kind: 'tab', tabId: 7, tabEpoch: 'new'}, undefined, 'new'));
  assert.equal(api.created, 0);
});
test('only explicit page control commands are translated', () => {
  assert.deepEqual(cdpInput({action: 'text', text: '你好'}), ['Input.insertText', {text: '你好'}]);
  assert.equal(cdpInput({action:'mouseMoved',x:1,y:1,button:'none',buttons:1})[1].button,'left');
  assert.equal(cdpInput({action:'mouseMoved',x:1,y:1,button:'none',buttons:2})[1].button,'right');
  assert.equal(cdpInput({action: 'mouseWheel', x: 10, y: 20, deltaY: 80})[1].deltaY, 80);
  assert.deepEqual(cdpInput({action:'navigate',url:'https://example.com/path?q=one#section'}),['Page.navigate',{url:'https://example.com/path?q=one#section'}]);
  assert.throws(() => cdpInput({action: 'Runtime.evaluate'}));
  assert.throws(() => cdpInput({action: 'navigate', url: 'file:///secret'}));
});
test('server requires TLS except loopback and URL reuse preserves query strings', () => {
  assert.equal(serverOrigin('http://localhost:8080/'), 'http://localhost:8080');
  assert.throws(() => serverOrigin('http://remote.example/'));
  assert.throws(() => serverOrigin('https://user:password@remote.example/'));
  assert.equal(targetURL('https://EXAMPLE.com?b=2&a=1#part'), 'https://example.com/?b=2&a=1');
});

test('large screenshots lower JPEG quality to stay within the relay frame budget',async()=>{
 const qualities=[],oversized='x'.repeat(2*1024*1024),clip={x:10,y:20,width:200,height:80,scale:1};
 const frame=await rasterFrame(async options=>{qualities.push(options.quality);assert.deepEqual(options.clip,clip);return {data:options.quality>15?oversized:'frame'};},{clip,format:'jpeg',captureBeyondViewport:false});
 assert.equal(frame.data,'frame');assert.deepEqual(qualities,[65,40,15]);
 await assert.rejects(()=>rasterFrame(async()=>({data:oversized}),{}),/传输预算/);
});
