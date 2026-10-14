import {PeerLink} from './peer.js';
const peers=new Map(),captures=new Map();
const tell=message=>chrome.runtime.sendMessage({target:'worker',...message}).catch(()=>{});
const key=m=>m.sessionId+':'+m.viewerId;
function remove(k){const p=peers.get(k);if(p){peers.delete(k);p.close();}}
async function handle(m) {
  if(m.type==='inspect')return {peers:[...peers.values()].map(p=>({tabId:p.tabId,ready:p.ready,track:p.sender?.track?.readyState})),captures:[...captures].map(([tabId,c])=>({tabId,width:c.canvas?.width,height:c.canvas?.height,state:c.track.readyState}))};
  if(m.type==='peer'){
    const k=key(m);remove(k);
    const p=new PeerLink({host:true,iceServers:m.iceServers,signal:signal=>tell({type:'signal',sessionId:m.sessionId,viewerId:m.viewerId,signal}),
      message:(message,channel)=>{if(channel==='input')tell({type:'peer-input',sessionId:m.sessionId,viewerId:m.viewerId,attempt:p.attempt,message});},
      state:status=>{tell({type:'peer-state',sessionId:m.sessionId,viewerId:m.viewerId,attempt:p.attempt,status});if(status==='down'&&peers.get(k)===p)peers.delete(k);}
    });p.sessionId=m.sessionId;p.viewerId=m.viewerId;p.tabId=m.tabId;peers.set(k,p);
    const capture=captures.get(m.tabId);if(capture)await p.video(capture.native&&!capture.track.enabled?null:capture.track);
    await p.offer();
  }
  if(m.type==='signal')await peers.get(key(m))?.accept(m.signal);
  if(m.type==='peer-left')remove(key(m));
  if(m.type==='send')for(const p of peers.values())if(p.sessionId===m.sessionId&&p.ready&&(!m.viewerId||m.viewerId===p.viewerId))void p.send(m.message);
  if(m.type==='asset'){
    const raw=atob(m.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));const p=peers.get(key(m));return p?.ready?await p.sendAsset(m.meta,bytes):false;
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
    let c=captures.get(m.tabId);
    const raw=atob(m.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    if(!c){const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const stream=canvas.captureStream(30),track=stream.getVideoTracks()[0];track.contentHint='detail';c={canvas,track};captures.set(m.tabId,c);for(const p of peers.values())if(p.tabId===m.tabId)void p.video(track).then(()=>{if(c.track.readyState==='live'){c.canvas.getContext('2d',{alpha:false}).drawImage(c.canvas,0,0);c.track.requestFrame();}}).catch(()=>{});}
    if(c.canvas.width!==image.width||c.canvas.height!==image.height){c.canvas.width=image.width;c.canvas.height=image.height;}
    c.canvas.getContext('2d',{alpha:false}).drawImage(image,0,0);c.track.requestFrame();image.close();
  }
  if(m.type==='stop-video'){const c=captures.get(m.tabId);if(c){captures.delete(m.tabId);for(const p of peers.values())if(p.tabId===m.tabId)await p.video(null);c.track.stop();}}
  if(m.type==='stop'){for(const k of [...peers.keys()])remove(k);for(const c of captures.values())c.track.stop();captures.clear();}
  return true;
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{if(sender.id!==chrome.runtime.id||m.target!=='offscreen')return false;handle(m).then(respond).catch(error=>{console.warn('TabShare offscreen '+m.type+': '+error.message);respond(false);});return true;});
