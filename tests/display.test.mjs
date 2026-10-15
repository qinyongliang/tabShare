import test from 'node:test';
import assert from 'node:assert/strict';
import {displayLayout,sourcePoint,viewportSize,wheelPixels} from '../web/display.js';

test('fit handles tiny windows and large source displays without a minimum-scale crop',()=>{
  const fit=displayLayout({width:3840,height:2160},{width:300,height:100});
  assert.ok(fit.scale<.1);assert.ok(fit.width<=300&&fit.height<=100);
  assert.equal(fit.width/fit.height,3840/2160);
  assert.equal(displayLayout({width:0,height:500},{width:300,height:200}),null);
});
test('width and original-size views retain a scrollable area instead of cropping',()=>{
  const width=displayLayout({width:1600,height:1200},{width:400,height:200},'width');
  assert.equal(width.width,400);assert.equal(width.areaHeight,300);
  const original=displayLayout({width:1600,height:1200},{width:400,height:200},'actual');
  assert.equal(original.scale,1);assert.equal(original.areaWidth,1600);assert.equal(original.areaHeight,1200);
  assert.equal(displayLayout({width:800,height:600},{width:1600,height:1200}).scale,2);
});
test('pointer coordinates account for scale, centering and pan independently of bitmap DPR',()=>{
  const source={width:1600,height:800,devicePixelRatio:2},rect={left:50,top:100,width:400,height:200};
  assert.deepEqual(sourcePoint({clientX:150,clientY:150},rect,source),{x:400,y:200});
  assert.deepEqual(sourcePoint({clientX:1000,clientY:-10},rect,source),{x:1599,y:0});
  assert.equal(sourcePoint({clientX:0,clientY:0},{width:0,height:10},source),null);
});
test('requested shared viewports bound both CSS size and bitmap memory',()=>{
  assert.deepEqual(viewportSize({width:390,height:700},2),{width:390,height:700,deviceScaleFactor:2});
  for(const size of [{width:9999,height:9999},{width:2560,height:1440},{width:1,height:1}]){
    const v=viewportSize(size,3);assert.ok(v.width>=320&&v.width<=3840&&v.height>=240&&v.height<=2160);
    assert.ok(v.width*v.deviceScaleFactor<=4096&&v.height*v.deviceScaleFactor<=4096);
    assert.ok(v.width*v.height*v.deviceScaleFactor**2<=8294400);
  }
});
test('wheel line and page units become bounded CSS-pixel deltas',()=>{
  assert.deepEqual(wheelPixels({deltaX:2,deltaY:3,deltaMode:1},800),{deltaX:32,deltaY:48});
  assert.deepEqual(wheelPixels({deltaX:0,deltaY:2,deltaMode:2},800),{deltaX:0,deltaY:1600});
});
