import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncFeedback} from '../web/feedback.js';
import {validPeerInput} from '../extension/controller.js';
function fixture(){
 let now=1000000000000,serial=0;const timers=new Map(),label={textContent:''},element={hidden:true,dataset:{},querySelector:()=>label,setAttribute(){}};
 const root={dataset:{}};const feedback=new SyncFeedback(element,root,{now:()=>now,later:(fn,ms)=>{timers.set(++serial,{fn,due:now+ms});return serial;},cancel:id=>timers.delete(id)});
 const advance=ms=>{now+=ms;for(const [id,t] of [...timers])if(t.due<=now){timers.delete(id);t.fn();}};
 return {feedback,element,root,label,advance,timers};
}
test('interaction immediately animates and only the current request ACK clears it',()=>{
 const {feedback,element,label,advance}=fixture();const old=feedback.begin(),current=feedback.begin();
 assert.equal(element.hidden,false);assert.equal(element.dataset.busy,'true');assert.match(label.textContent,/发送/);
 feedback.acknowledge(old,'accepted');assert.equal(feedback.requestId,current);
 feedback.acknowledge(current,'accepted');assert.equal(element.dataset.busy,'false');assert.match(label.textContent,/送达/);
 advance(500);assert.equal(element.hidden,true);
});
test('slow inputs remain truthful; disconnect removes stale feedback and timers',()=>{
 const {feedback,label,advance,element,root,timers}=fixture();feedback.begin();advance(5000);assert.match(label.textContent,/等待/);
 feedback.progress({version:'doc',meta:{pending:true}});assert.equal(root.dataset.initialSync,'true');
 feedback.disconnect();assert.equal(element.hidden,true);assert.equal(root.dataset.initialSync,undefined);assert.equal(timers.size,0);
});
test('initial tree is held until complete but continuously changing pages are bounded',()=>{
 const {feedback,root,element,advance}=fixture();feedback.progress({version:'one',meta:{pending:true}});assert.equal(root.dataset.initialSync,'true');
 feedback.progress({version:'one',meta:{pending:false,loading:false}});assert.equal(root.dataset.initialSync,undefined);assert.equal(element.hidden,true);
 feedback.progress({version:'two',meta:{pending:true}});advance(2500);assert.equal(root.dataset.initialSync,undefined);assert.equal(element.hidden,false);
});
test('source loading persists independently of an input delivery ACK',()=>{
 const {feedback,element,label,advance}=fixture();feedback.progress({version:'doc',meta:{pending:false,loading:true}});
 const id=feedback.begin();feedback.acknowledge(id,'accepted');advance(1000);
 assert.equal(element.hidden,false);assert.match(label.textContent,/正在加载/);
 feedback.progress({version:'doc',meta:{pending:false,loading:false}});assert.equal(element.hidden,true);
});
test('peer input correlation IDs are bounded and cannot carry arbitrary data',()=>{
 assert.equal(validPeerInput({action:'reload',requestId:'request_123'}),true);
 assert.equal(validPeerInput({action:'reload',requestId:'x'.repeat(65)}),false);
 assert.equal(validPeerInput({action:'reload',requestId:'<script>'}),false);
});
