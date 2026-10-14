const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

// All layout and input coordinates use CSS pixels. Bitmap DPR is independent.
export function displayLayout(source,available,mode='fit',zoom=1) {
  const {width,height}=source||{};
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>16384||height>16384)return null;
  if(!Number.isFinite(available.width)||!Number.isFinite(available.height)||available.width<=0||available.height<=0)return null;
  let scale=mode==='actual'?1:mode==='custom'?clamp(zoom,.25,2):mode==='width'?available.width/width:Math.min(available.width/width,available.height/height);
  scale=clamp(scale,.001,4);
  return {scale,width:width*scale,height:height*scale,areaWidth:Math.max(available.width,width*scale),areaHeight:Math.max(available.height,height*scale)};
}

export function sourcePoint(point,rect,source) {
  if(!rect?.width||!rect?.height||!source?.width||!source?.height)return null;
  return {x:clamp((point.clientX-rect.left)*source.width/rect.width,0,source.width-1),y:clamp((point.clientY-rect.top)*source.height/rect.height,0,source.height-1)};
}

export function viewportSize(available,dpr=1) {
  const width=Math.round(clamp(available.width,320,3840)),height=Math.round(clamp(available.height,240,2160));
  const deviceScaleFactor=Math.min(clamp(dpr,1,2),4096/width,4096/height,Math.sqrt(8294400/(width*height)));
  return {width,height,deviceScaleFactor:Math.floor(deviceScaleFactor*100)/100};
}

export function wheelPixels(event,viewportHeight) {
  const unit=event.deltaMode===1?16:event.deltaMode===2?viewportHeight:1;
  return {deltaX:clamp(event.deltaX*unit,-10000,10000),deltaY:clamp(event.deltaY*unit,-10000,10000)};
}
