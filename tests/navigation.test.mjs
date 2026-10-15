import test from 'node:test';
import assert from 'node:assert/strict';
import {shareKey,routeHash,SharedNavigation} from '../web/navigation.js';

function browser(){
 const listeners={},records=[{state:null,hash:'#secret'}];let index=0;
 const win={location:{hash:'#secret'},addEventListener:(type,fn)=>listeners[type]=fn};
 win.history={get state(){return records[index].state;},replaceState(state,_,hash){records[index]={state,hash};win.location.hash=hash;},pushState(state,_,hash){records.splice(++index);records.push({state,hash});win.location.hash=hash;},go(delta){index+=delta;assert.ok(index>=0&&index<records.length);win.location.hash=records[index].hash;listeners.popstate();}};
 return {win,records,get index(){return index;}};
}
test('hash routing keeps the capability separate and preserves source query/fragment',()=>{
 const url='https://example.com/page?q=中文&sort=new#section';
 const hash=routeHash('secret',url);assert.equal(shareKey(hash),'secret');assert.equal(new URLSearchParams(hash.slice(1).split('&').slice(1).join('&')).get('url'),url);
});
test('native back/forward controls remote entries without an echo navigation',()=>{
 const b=browser(),sent=[],nav=new SharedNavigation(b.win,'secret',m=>sent.push(m));
 const meta=(entryId,path)=>({url:'https://example.com/'+path,navigation:{entryId}});
 nav.update(meta(10,'one'));nav.update(meta(20,'two'));nav.update(meta(30,'three'));
 b.win.history.go(-2);assert.deepEqual(sent,[{action:'history',entryId:10}]);
 nav.update(meta(30,'three'));assert.equal(b.index,0,'stale in-flight snapshots do not undo browser back');
 nav.update(meta(10,'one'));assert.equal(b.records.length,3);
 b.win.history.go(2);nav.update(meta(30,'three'));assert.equal(b.index,2);assert.equal(sent.length,2);
 nav.update(meta(20,'two'));assert.equal(b.index,1,'another visitor going back aligns native history');assert.equal(sent.length,2,'remote history alignment does not send another input');
 nav.update(meta(20,'replacement#anchor'));assert.equal(b.records.length,3);assert.ok(decodeURIComponent(b.win.location.hash).endsWith('replacement#anchor'));
 nav.update(meta(40,'new'));assert.equal(b.records.length,3,'new navigation prunes old forward history');
});
test('refresh adopts the active hash route without adding a duplicate history entry',()=>{
 const b=browser(),sent=[],meta={url:'https://example.com/current',navigation:{entryId:8}};
 new SharedNavigation(b.win,'secret',m=>sent.push(m)).update(meta);
 new SharedNavigation(b.win,'secret',m=>sent.push(m)).update(meta);
 assert.equal(b.records.length,1);assert.deepEqual(sent,[]);
});

test('a remote-pruned history entry recovers to the authoritative page',()=>{
 const b=browser(),nav=new SharedNavigation(b.win,'secret',()=>{});
 nav.update({url:'https://example.com/a',navigation:{entryId:1}});nav.update({url:'https://example.com/b',navigation:{entryId:2}});
 b.win.history.go(-1);nav.update({url:'https://example.com/new',navigation:{entryId:3,entries:[2,3]}});
 assert.ok(decodeURIComponent(b.win.location.hash).endsWith('/new'));assert.equal(nav.pending,null);
});
