import {PeerLink} from './peer.js';
import {videoLayout} from './video-layout.js';
const peers=new Map(),captures=new Map(),layouts=new Map(),epochs=new Map();
const tell=message=>chrome.runtime.sendMessage({target:'worker',...message}).catch(()=>{});
const key=m=>m.sessionId+':'+m.viewerId;
function remove(k){const p=peers.get(k);if(p){peers.delete(k);p.close();}}
function videoBudget(tabId){const members=[...peers.values()].filter(p=>p.tabId===tabId&&p.ready);tell({type:'video-budget',tabId,fps:members.some(p=>p.profile.visible)?30:2});}
async function handle(m) {
  if(m.type==='layout'){const layout=videoLayout(m.info,!captures.get(m.tabId)?.native);layouts.set(m.tabId,layout);return layout;}
  if(m.type==='inspect')return {peers:[...peers.values()].map(p=>({tabId:p.tabId,ready:p.ready,track:p.sender?.track?.readyState,profile:p.profile,stats:p.stats,queued:p.queued,video:p.sender?.getParameters().encodings?.[0]})),captures:[...captures].map(([tabId,c])=>({tabId,width:c.canvas?.width,height:c.canvas?.height,state:c.track.readyState}))};
  if(m.type==='peer'){
    const k=key(m);remove(k);
    const p=new PeerLink({host:true,iceServers:m.iceServers,signal:signal=>tell({type:'signal',sessionId:m.sessionId,viewerId:m.viewerId,signal}),
      message:(message,channel)=>{if(channel==='input')tell({type:'peer-input',sessionId:m.sessionId,viewerId:m.viewerId,attempt:p.attempt,message});},
      profileChanged:()=>videoBudget(p.tabId),
      state:status=>{tell({type:'peer-state',sessionId:m.sessionId,viewerId:m.viewerId,attempt:p.attempt,status});if(status==='down'&&peers.get(k)===p)peers.delete(k);videoBudget(p.tabId);}
    });p.sessionId=m.sessionId;p.viewerId=m.viewerId;p.tabId=m.tabId;peers.set(k,p);
    const capture=captures.get(m.tabId);if(capture)await p.video(capture.native&&!capture.track.enabled?null:capture.track);
    await p.offer();
  }
  if(m.type==='signal')await peers.get(key(m))?.accept(m.signal);
  if(m.type==='peer-left')remove(key(m));
  if(m.type==='send')for(const p of peers.values())if(p.sessionId===m.sessionId&&p.ready&&(!m.viewerId||m.viewerId===p.viewerId))void p.send(m.message);
  if(m.type==='asset'){
    const raw=atob(m.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    const todo=[...m.viewerIds||[m.viewerId]],delivered=[];
    await Promise.all(Array.from({length:Math.min(4,todo.length)},async()=>{while(todo.length){const viewerId=todo.shift(),p=peers.get(key({...m,viewerId}));if(p?.ready&&await p.sendAsset(m.meta,bytes))delivered.push(viewerId);}}));
    return delivered;
  }
  if(m.type==='bind')for(const p of peers.values())if(p.sessionId===m.sessionId){p.tabId=m.tabId;await p.video(captures.get(m.tabId)?.track||null);}
  if(m.type==='capture-native'){
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.streamId}}});
    const track=stream.getVideoTracks()[0];track.contentHint='detail';track.enabled=false;
    const old=captures.get(m.tabId);old?.track.stop();captures.set(m.tabId,{track,native:true});
    track.onended=()=>{if(captures.get(m.tabId)?.track!==track)return;captures.delete(m.tabId);tell({type:'native-ended',tabId:m.tabId});};
  }
  if(m.type==='active-video'){const c=captures.get(m.tabId);if(c){c.track.enabled=m.active;for(const p of peers.values())if(p.tabId===m.tabId)await p.video(m.active?c.track:null);}}
  if(m.type==='frame'){
    if(!epochs.has(m.tabId))epochs.set(m.tabId,{});const epoch=epochs.get(m.tabId);let c=captures.get(m.tabId);
    const raw=atob(m.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    if(epochs.get(m.tabId)!==epoch||c?.native){image.close();return false;}
    const layout=layouts.get(m.tabId),width=layout?.frameWidth||image.width,height=layout?.frameHeight||image.height;
    const scale=layout?Math.min(image.width/layout.width,image.height/layout.height,2,4096/width,4096/height,Math.sqrt(8294400/(width*height))):1;
    const outputWidth=Math.max(1,Math.ceil(width*scale)),outputHeight=Math.max(1,Math.ceil(height*scale));
    if(!c){const canvas=document.createElement('canvas');canvas.width=outputWidth;canvas.height=outputHeight;const stream=canvas.captureStream(0),track=stream.getVideoTracks()[0];track.contentHint='detail';c={canvas,track};captures.set(m.tabId,c);for(const p of peers.values())if(p.tabId===m.tabId)void p.video(track).then(()=>{if(c.track.readyState==='live'){c.canvas.getContext('2d',{alpha:false}).drawImage(c.canvas,0,0);c.track.requestFrame();}}).catch(()=>{});}
    if(c.canvas.width!==outputWidth||c.canvas.height!==outputHeight){c.canvas.width=outputWidth;c.canvas.height=outputHeight;for(const p of peers.values())if(p.tabId===m.tabId)p.updateVideoPolicy?.();}
    const ctx=c.canvas.getContext('2d',{alpha:false});
    if(layout&&!layout.full&&layout.regions.length){
      ctx.clearRect(0,0,c.canvas.width,c.canvas.height);
      const sx=image.width/layout.width,sy=image.height/layout.height;
      for(const r of layout.regions)ctx.drawImage(image,(r.x-layout.scrollX)*sx,(r.y-layout.scrollY)*sy,r.width*sx,r.height*sy,r.videoX*scale,r.videoY*scale,r.videoWidth*scale,r.videoHeight*scale);
    }else ctx.drawImage(image,0,0,c.canvas.width,c.canvas.height);c.track.requestFrame();image.close();
  }
  if(m.type==='stop-video'){epochs.delete(m.tabId);layouts.delete(m.tabId);const c=captures.get(m.tabId);if(c){captures.delete(m.tabId);for(const p of peers.values())if(p.tabId===m.tabId)await p.video(null);c.track.stop();}}
  if(m.type==='stop'){epochs.clear();for(const k of [...peers.keys()])remove(k);for(const c of captures.values())c.track.stop();captures.clear();layouts.clear();}
  return true;
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{if(sender.id!==chrome.runtime.id||m.target!=='offscreen')return false;handle(m).then(respond).catch(error=>{console.warn('TabShare offscreen '+m.type+': '+error.message);respond(false);});return true;});
