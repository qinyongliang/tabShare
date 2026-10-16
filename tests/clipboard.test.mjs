import test from 'node:test';
import assert from 'node:assert/strict';
import {pasteImage,maxClipboardImage} from '../web/clipboard.js';
test('clipboard images use the authenticated peer asset channel and preserve their target',async()=>{
 let received;const bytes=new Uint8Array([137,80,78,71]),file=new File([bytes],'photo.png',{type:'image/png'});
 await pasteImage(file,{session:'room',key:'secret',viewerId:'viewer',peer:{ready:true,sendAsset:async(meta,data)=>{received={meta,data};return true;}},selection:{version:'v1',nodeId:'3'}});
 assert.equal(received.meta.kind,'clipboard-image');assert.equal(received.meta.nodeId,'3');assert.equal(received.meta.version,'v1');assert.deepEqual(received.data,bytes);
 await assert.rejects(pasteImage(new File(['<svg/>'],'photo.svg',{type:'image/svg+xml'}),{}),/PNG/);
 await assert.rejects(pasteImage(new File([new Uint8Array(maxClipboardImage+1)],'big.png',{type:'image/png'}),{}),/4 MiB/);
});

test('long Unicode paste is lossless and each input packet satisfies existing protocol limits',async()=>{
 const {textPastePackets}=await import('../web/clipboard.js');const {validPeerInput}=await import('../extension/controller.js');
 for(const text of ['中文🙂'.repeat(6000),'a'.repeat(50000),'\u0000\\"\n'.repeat(5000)]){
  const packets=textPastePackets(text,{nodeId:'3',selection:{start:1,end:5}});
  assert.ok(packets.length>1);assert.equal(packets.map(p=>p.text).join(''),text);
  assert.ok(packets.every(validPeerInput));assert.deepEqual(packets[0].selection,{start:1,end:5});
  assert.ok(packets.slice(1).every(p=>!p.selection&&p.nodeId==='3'));
  assert.ok(packets.every(p=>!/[\uD800-\uDBFF]$/.test(p.text)),'never split an emoji surrogate pair');
 }
 assert.deepEqual(textPastePackets(''),[]);
 assert.throws(()=>textPastePackets('x'.repeat(256*1024+1)),/256 KiB/);
 assert.throws(()=>textPastePackets(null),/格式/);
});
test('clipboard key pairs stay local and password selections are not exposed',async()=>{
 const {clipboardShortcut,selectedText}=await import('../web/clipboard.js');
 for(const key of ['c','v','x','C','X'])for(const modifier of ['ctrlKey','metaKey'])assert.equal(clipboardShortcut({key,[modifier]:true}),true);
 assert.equal(clipboardShortcut({key:'x',ctrlKey:true,altKey:true}),false);
 assert.equal(!!clipboardShortcut({key:'x'}),false);
 const doc={getSelection:()=>({toString:()=> 'selected DOM'})};
 assert.equal(selectedText(doc,{tagName:'INPUT',type:'text',value:'abcde',selectionStart:1,selectionEnd:4}),'bcd');
 assert.equal(selectedText(doc,{tagName:'INPUT',type:'password',value:'secret',selectionStart:0,selectionEnd:6}),'');
 assert.equal(selectedText(doc,{}),'selected DOM');
});
test('video input cut sends one deletion pair; clipboard shortcut keyups are not forwarded',async()=>{
 const {RemoteInput}=await import('../web/remote-input.js'),handlers=new Map(),sent=[];
 const box={value:'selected',selectionStart:0,selectionEnd:8,tagName:'TEXTAREA',style:{},setAttribute(){},addEventListener(name,fn){handlers.set(name,fn);},setRangeText(text){this.value=text;}};
 const doc={createElement:()=>box,body:{append(){}},addEventListener(){},getSelection(){return null;}};
 new RemoteInput(doc,{},value=>sent.push(value),()=>{});
 for(const type of ['keydown','keyup'])for(const key of ['c','v','x'])handlers.get(type)({key,ctrlKey:true,preventDefault(){throw Error('native clipboard shortcut blocked');}});
 assert.deepEqual(sent,[]);let copied;
 handlers.get('cut')({preventDefault(){},clipboardData:{setData(type,text){copied={type,text};}}});
 assert.deepEqual(copied,{type:'text/plain',text:'selected'});assert.equal(box.value,'');assert.deepEqual(sent.map(v=>v.action),['keyDown','keyUp']);assert.ok(sent.every(v=>v.key==='Backspace'));
});
