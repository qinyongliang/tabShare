import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTab, cdpInput, serverOrigin, targetURL} from '../extension/controller.js';

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
  assert.equal(cdpInput({action: 'mouseWheel', x: 10, y: 20, deltaY: 80})[1].deltaY, 80);
  assert.throws(() => cdpInput({action: 'Runtime.evaluate'}));
  assert.throws(() => cdpInput({action: 'navigate', url: 'file:///secret'}));
});
test('server requires TLS except loopback and URL reuse preserves query strings', () => {
  assert.equal(serverOrigin('http://localhost:8080/'), 'http://localhost:8080');
  assert.throws(() => serverOrigin('http://remote.example/'));
  assert.throws(() => serverOrigin('https://user:password@remote.example/'));
  assert.equal(targetURL('https://EXAMPLE.com?b=2&a=1#part'), 'https://example.com/?b=2&a=1');
});
