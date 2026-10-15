import {PeerLink} from './peer.js';
import {videoLayout} from './video-layout.js';
import {drawFrame,NativeCapture} from './video-capture.js';
const peers=new Map(),captures=new Map(),layouts=new Map(),epochs=new Map();
const tell=message=>chrome.runtime.sendMessage({target:'worker',...message}).catch(()=>{});
const key=m=>m.sessionId+':'+m.viewerId;
function remove(k){const p=peers.get(k);if(p){peers.delete(k);p.close();}}
function videoBudget(tabId){const members=[...peers.values()].filter(p=>p.tabId===tabId&&p.ready),fps=members.some(p=>p.profile.visible)?30:2;captures.get(tabId)?.setFPS?.(fps);tell({type:'video-budget',tabId,fps});}
async function handle(m) {
  if(m.type==='clipboard-image'){
    try{const raw=atob(m.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));let blob=new Blob([bytes],{type:m.mime});if(m.mime!=='image/png'){const image=await createImageBitmap(blob);if(image.width*image.height>16000000){image.close();return false;}const canvas=new OffscreenCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);image.close();blob=await canvas.convertToBlob({type:'image/png'});}await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);return true;}catch{return false;}
  }
  if(m.type==='layout'){const layout=videoLayout(m.info);layouts.set(m.tabId,layout);captures.get(m.tabId)?.setLayout?.(layout);return layout;}
  if(m.type==='inspect')return {peers:[...peers.values()].map(p=>({tabId:p.tabId,ready:p.ready,track:p.sender?.track?.readyState,profile:p.profile,stats:p.stats,queued:p.queued,video:p.sender?.getParameters().encodings?.[0]})),captures:[...captures].map(([tabId,c])=>({tabId,width:c.canvas?.width,height:c.canvas?.height,state:c.track.readyState}))};
  if(m.type==='download-chunk'){const p=peers.get(key(m));if(!p?.ready)return false;return p.sendAsset(m.meta,Uint8Array.from(atob(m.data),c=>c.charCodeAt(0)));}
  if(m.type==='peer'){
    const k=key(m);remove(k);
    const p=new PeerLink({host:true,iceServers:m.iceServers,signal:signal=>tell({type:'signal',sessionId:m.sessionId,viewerId:m.viewerId,signal}),
      message:(message,channel)=>{if(channel==='input')tell({type:'peer-input',sessionId:m.sessionId,viewerId:m.viewerId,attempt:p.attempt,message});},
      profileChanged:()=>videoBudget(p.tabId),
      asset:(meta,bytes)=>{if(meta?.kind!=='clipboard-image'||!['image/png','image/jpeg','image/webp','image/gif'].includes(meta.mime)||bytes.length>4*1024*1024)return;let raw='';for(let i=0;i<bytes.length;i+=4096)raw+=String.fromCharCode(...bytes.subarray(i,i+4096));tell({type:'peer-clipboard',sessionId:m.sessionId,viewerId:m.viewerId,attempt:p.attempt,image:{...meta,data:btoa(raw)}});},
      state:status=>{tell({type:'peer-state',sessionId:m.sessionId,viewerId:m.viewerId,attempt:p.attempt,status});if(status==='down'&&peers.get(k)===p)peers.delete(k);videoBudget(p.tabId);}
    });p.sessionId=m.sessionId;p.viewerId=m.viewerId;p.tabId=m.tabId;peers.set(k,p);
    const capture=captures.get(m.tabId);if(capture)await p.video(capture.native&&!capture.track.enabled?null:capture.track);
    await p.offer();
  }
  if(m.type==='signal')await peers.get(key(m))?.accept(m.signal);
  if(m.type==='peer-left')remove(key(m));
  if(m.type==='send')for(const p of peers.values())if(p.sessionId===m.sessionId&&p.ready&&(!m.viewerId||m.viewerId===p.viewerId))void p.send(m.message);
  if(m.type==='send-packet'){
    const bytes=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));
    for(const p of peers.values())if(p.sessionId===m.sessionId&&p.ready)void p.bytes(bytes,'state');
  }
  if(m.type==='asset'){
    const raw=atob(m.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    const todo=[...m.viewerIds||[m.viewerId]],delivered=[];
    await Promise.all(Array.from({length:Math.min(4,todo.length)},async()=>{while(todo.length){const viewerId=todo.shift(),p=peers.get(key({...m,viewerId}));if(p?.ready&&await p.sendAsset(m.meta,bytes))delivered.push(viewerId);}}));
    return delivered;
  }
  if(m.type==='bind')for(const p of peers.values())if(p.sessionId===m.sessionId){p.tabId=m.tabId;await p.video(captures.get(m.tabId)?.track||null);}
  if(m.type==='capture-native'){
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.streamId}}});
    const old=captures.get(m.tabId);if(old?.stop)old.stop();else old?.track.stop();epochs.set(m.tabId,{});
    const c=new NativeCapture(stream.getVideoTracks()[0],{
      changed:()=>{if(captures.get(m.tabId)!==c)return;for(const p of peers.values())if(p.tabId===m.tabId)void p.video(c.active?c.track:null).catch(()=>{});},
      ended:()=>{if(captures.get(m.tabId)!==c)return;captures.delete(m.tabId);tell({type:'native-ended',tabId:m.tabId});}
    });captures.set(m.tabId,c);if(layouts.has(m.tabId))c.setLayout(layouts.get(m.tabId));
  }
  if(m.type==='active-video'){const c=captures.get(m.tabId);if(c?.native)c.setActive(m.active);}
  if(m.type==='frame'){
    if(!epochs.has(m.tabId))epochs.set(m.tabId,{});const epoch=epochs.get(m.tabId);let c=captures.get(m.tabId);
    const raw=atob(m.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    c=captures.get(m.tabId);
    if(epochs.get(m.tabId)!==epoch||c?.native){image.close();return false;}
    if(!c){const canvas=document.createElement('canvas'),track=canvas.captureStream(0).getVideoTracks()[0];track.contentHint='detail';c={canvas,track};captures.set(m.tabId,c);for(const p of peers.values())if(p.tabId===m.tabId)void p.video(track).then(()=>{if(c.track.readyState==='live'){c.canvas.getContext('2d',{alpha:false}).drawImage(c.canvas,0,0);c.track.requestFrame();}}).catch(()=>{});}
    if(drawFrame(c.canvas,image,layouts.get(m.tabId)))for(const p of peers.values())if(p.tabId===m.tabId)p.updateVideoPolicy?.();
    c.track.requestFrame();image.close();
  }
  if(m.type==='stop-video'){epochs.delete(m.tabId);layouts.delete(m.tabId);const c=captures.get(m.tabId);if(c){captures.delete(m.tabId);for(const p of peers.values())if(p.tabId===m.tabId)await p.video(null);if(c.stop)c.stop();else c.track.stop();}}
  if(m.type==='stop'){epochs.clear();for(const k of [...peers.keys()])remove(k);for(const c of captures.values())if(c.stop)c.stop();else c.track.stop();captures.clear();layouts.clear();}
  return true;
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{if(sender.id!==chrome.runtime.id||m.target!=='offscreen')return false;handle(m).then(respond).catch(error=>{console.warn('TabShare offscreen '+m.type+': '+error.message);respond(false);});return true;});
