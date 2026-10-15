import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoLayout} from '../extension/video-layout.js';
const info={width:1920,height:1080,scrollX:10,scrollY:200,version:'doc',full:false,regions:[{id:'a',x:50,y:400,width:200,height:90},{id:'b',x:1400,y:700,width:100,height:80}]};
test('regional video packs distant source areas without changing input coordinates',()=>{
  const layout=videoLayout(info);assert.ok(layout.frameWidth*layout.frameHeight<1920*1080/20);
  assert.deepEqual(layout.regions.map(r=>({x:r.x,y:r.y})),info.regions.map(r=>({x:r.x,y:r.y})));
  for(const r of layout.regions){assert.ok(r.videoX+r.videoWidth<=layout.frameWidth);assert.ok(r.videoY+r.videoHeight<=layout.frameHeight);}
  assert.equal(info.regions[0].videoX,undefined,'input metadata stays immutable');
});
test('whole-page and native-track layouts preserve the original viewport mapping',()=>{
  const full=videoLayout({...info,full:true});assert.equal(full.frameWidth,1920);
  const native=videoLayout(info,false);assert.equal(native.frameHeight,1080);assert.equal(native.regions[0].videoX,40);assert.equal(native.regions[0].videoY,200);
});
