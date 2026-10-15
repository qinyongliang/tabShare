// One source-side canvas per shared tab, reused across all peer encoders.
export function drawFrame(canvas,source,layout){
  const sourceWidth=source.videoWidth||source.width,sourceHeight=source.videoHeight||source.height;
  if(!sourceWidth||!sourceHeight)return false;
  const width=layout?.frameWidth||sourceWidth,height=layout?.frameHeight||sourceHeight;
  const scale=layout?Math.min(sourceWidth/layout.width,sourceHeight/layout.height,2,4096/width,4096/height,Math.sqrt(8294400/(width*height))):1;
  const outputWidth=Math.max(1,Math.floor(width*scale)),outputHeight=Math.max(1,Math.floor(height*scale));
  const resized=canvas.width!==outputWidth||canvas.height!==outputHeight;
  if(resized){canvas.width=outputWidth;canvas.height=outputHeight;}
  const ctx=canvas.getContext('2d',{alpha:false});
  if(layout&&!layout.full&&layout.regions.length){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const sx=sourceWidth/layout.width,sy=sourceHeight/layout.height;
    for(const r of layout.regions)ctx.drawImage(source,(r.x-layout.scrollX)*sx,(r.y-layout.scrollY)*sy,r.width*sx,r.height*sy,r.videoX*scale,r.videoY*scale,r.videoWidth*scale,r.videoHeight*scale);
  }else ctx.drawImage(source,0,0,canvas.width,canvas.height);
  return resized;
}

export class NativeCapture {
  constructor(raw,{changed=()=>{},ended=()=>{}}={}){
    this.raw=raw;this.native=true;this.active=false;this.fps=0;this.changed=changed;this.stopped=false;
    this.canvas=document.createElement('canvas');this.canvas.width=this.canvas.height=1;
    this.cropped=this.canvas.captureStream(0).getVideoTracks()[0];this.cropped.contentHint=raw.contentHint='detail';
    this.video=document.createElement('video');this.video.muted=true;this.video.playsInline=true;this.video.srcObject=new MediaStream([raw]);
    raw.enabled=this.cropped.enabled=false;
    this.setFPS(30);
    raw.onended=()=>{if(!this.stopped){this.stop();ended();}};
  }
  get regional(){return !!this.layout&&!this.layout.full&&this.layout.regions.length>0;}
  get track(){return this.regional?this.cropped:this.raw;}
  setLayout(layout){const previous=this.track;this.layout=layout;this.render();this.refresh();if(previous!==this.track)this.changed();}
  setActive(active){if(this.stopped)return;this.active=active;this.raw.enabled=active;this.cropped.enabled=active&&this.regional;this.refresh();this.changed();}
  setFPS(fps){if(this.fps===fps||this.stopped)return;this.fps=fps;void this.raw.applyConstraints({frameRate:{ideal:fps,max:fps}}).catch(()=>{});}
  render(){
    if(!this.active||!this.regional||this.stopped||this.video.readyState<2)return;
    const resized=drawFrame(this.canvas,this.video,this.layout);this.cropped.requestFrame();
    if(resized)this.changed();
  }
  refresh(){
    this.cropped.enabled=this.active&&this.regional;
    if(!this.active||!this.regional||this.stopped){if(this.frame!==undefined)this.video.cancelVideoFrameCallback(this.frame);this.frame=undefined;this.video.pause();return;}
    void this.video.play().catch(()=>{});
    if(this.frame!==undefined)return;
    const next=now=>{
      this.frame=undefined;if(this.stopped||!this.active||!this.regional)return;
      if(!this.lastFrame||now-this.lastFrame>=1000/this.fps){this.lastFrame=now;this.render();}
      this.frame=this.video.requestVideoFrameCallback(next);
    };
    this.frame=this.video.requestVideoFrameCallback(next);
  }
  stop(){
    if(this.stopped)return;this.stopped=true;
    if(this.frame!==undefined)this.video.cancelVideoFrameCallback(this.frame);
    this.video.pause();this.video.srcObject=null;this.raw.stop();this.cropped.stop();
    this.canvas.width=this.canvas.height=1;
  }
}
