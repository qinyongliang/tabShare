// Metadata stays in source CSS pixels; video can pack multiple unsupported regions.
export function videoLayout(info,crop=true){
  const regions=info.regions||[];
  if(info.full||!crop||!regions.length)return {...info,frameWidth:info.width,frameHeight:info.height,regions:regions.map(r=>({...r,videoX:r.x-info.scrollX,videoY:r.y-info.scrollY,videoWidth:r.width,videoHeight:r.height}))};
  const horizontal={width:regions.reduce((n,r)=>n+Math.ceil(r.width),0),height:Math.max(...regions.map(r=>Math.ceil(r.height)))};
  const vertical={width:Math.max(...regions.map(r=>Math.ceil(r.width))),height:regions.reduce((n,r)=>n+Math.ceil(r.height),0)};
  const score=s=>Math.max(s.width,s.height)+s.width*s.height/16777216;
  const across=score(horizontal)<=score(vertical),size=across?horizontal:vertical;let offset=0;
  return {...info,frameWidth:size.width,frameHeight:size.height,regions:regions.map(r=>{const part={...r,videoX:across?offset:0,videoY:across?0:offset,videoWidth:r.width,videoHeight:r.height};offset+=Math.ceil(across?r.width:r.height);return part;})};
}
