// Bounded, ordered SCTP streams. Keep this file identical in the extension and viewer.
const CHUNK=16*1024,LIMIT=12*1024*1024,QUEUE=24*1024*1024;
let outstanding=0;
async function streamBytes(stream,limit){
  const reader=stream.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Expanded packet exceeds budget');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export async function compressPacket(bytes){
  if(bytes.length<8192||bytes[0]!==1||typeof CompressionStream!=='function')return bytes;
  let gzip;try{gzip=await streamBytes(new Blob([bytes.subarray(1)]).stream().pipeThrough(new CompressionStream('gzip')),LIMIT);}catch{return bytes;}
  if(gzip.length+5>=bytes.length*.9)return bytes;
  const packet=new Uint8Array(gzip.length+5);packet[0]=3;new DataView(packet.buffer).setUint32(1,bytes.length-1);packet.set(gzip,5);return packet;
}
export async function decodeJSONPacket(bytes,limit=LIMIT){
  let json=bytes.subarray(1);
  if(bytes[0]===3){
    if(bytes.length<6||typeof DecompressionStream!=='function')throw Error('Unsupported compressed packet');
    const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(1);
    if(size<1||size>limit-1)throw Error('Expanded packet exceeds budget');
    json=await streamBytes(new Blob([bytes.subarray(5)]).stream().pipeThrough(new DecompressionStream('gzip')),size);
    if(json.length!==size)throw Error('Compressed packet length mismatch');
  }else if(bytes[0]!==1||bytes.length>limit)throw Error('Invalid JSON packet');
  return JSON.parse(new TextDecoder().decode(json));
}
export function encodingPolicy(size,profile,network={}){
  const width=size.width||1920,height=size.height||1080;
  const down=Math.min(8,Math.max(1,width/profile.width,height/profile.height,width/4096,height/4096,Math.sqrt(width*height/8294400))),pixels=width*height/(down*down);
  const weak=network.rtt>.3||network.loss>.05||network.encodeMs>35||network.cpu;
  return {scaleResolutionDownBy:down,maxFramerate:profile.visible?(weak?15:30):2,maxBitrate:profile.visible?Math.round(Math.max(150000,Math.min(4000000,pixels*3,network.available>0?network.available*.8:4000000))):150000};
}
export class PeerLink {
  constructor({host=false,iceServers=[],attempt=crypto.randomUUID(),signal,message,asset,track,state,profileChanged}){
    Object.assign(this,{host,attempt,signal,message,asset,state,profileChanged});
    this.channels=new Map();this.pendingICE=[];this.closed=false;this.ready=false;this.serial=0;this.queued=0;this.waiters=new Set();this.profile={width:1920,height:1080,visible:true};this.stats={sent:0,received:0,compressed:0,saved:0};
    this.pc=new RTCPeerConnection({iceServers,bundlePolicy:'max-bundle'});
    this.pc.onicecandidate=e=>{if(e.candidate)this.signal({attempt:this.attempt,candidate:e.candidate.toJSON()});};
    this.pc.ontrack=e=>{try{e.receiver.jitterBufferTarget=0;e.receiver.playoutDelayHint=0;}catch{}track?.(new MediaStream([e.track]));};
    this.pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(this.pc.connectionState))this.close();if(this.pc.connectionState==='disconnected'){clearTimeout(this.lost);this.lost=setTimeout(()=>this.close(),8000);}else clearTimeout(this.lost);};
    this.pc.ondatachannel=e=>this.channel(e.channel);this.timeout=setTimeout(()=>this.close(),15000);
    if(host){this.sender=this.pc.addTransceiver('video',{direction:'sendonly'}).sender;for(const name of ['state','input','assets'])this.channel(this.pc.createDataChannel(name,{ordered:true}));}
  }
  channel(c){
    if(!['state','input','assets'].includes(c.label)||this.channels.has(c.label)){c.close();return;}
    const entry={c,tail:Promise.resolve(),decode:Promise.resolve(),parts:new Map(),retained:0};this.channels.set(c.label,entry);c.binaryType='arraybuffer';c.bufferedAmountLowThreshold=65536;
    c.onopen=()=>{if(this.ready||this.channels.size!==3||![...this.channels.values()].every(e=>e.c.readyState==='open'))return;
      clearTimeout(this.timeout);this.ready=true;
      if(this.host)this.policyTimer=setInterval(()=>void this.sampleNetwork(),5000);
      this.state?.('up');
    };
    c.onclose=()=>this.close();c.onerror=()=>this.close();
    c.onmessage=e=>{
      try{
        if(this.host&&!['input','assets'].includes(c.label)||!this.host&&c.label==='input')throw Error('Unexpected channel direction');
        if(!(e.data instanceof ArrayBuffer)||e.data.byteLength<13||e.data.byteLength>CHUNK+12)throw Error('Invalid fragment');
        const view=new DataView(e.data),id=view.getUint32(0),total=view.getUint32(4),offset=view.getUint32(8),payload=new Uint8Array(e.data,12),limit=c.label==='input'?16384:this.host&&c.label==='assets'?4*1024*1024+4101:LIMIT;
        if(total<1||total>limit||offset+payload.length>total)throw Error('Invalid size');
        let part=entry.parts.get(id);
        if(!part){if(offset!==0||entry.parts.size>=4||entry.retained+total>QUEUE)throw Error('Receive budget');part={bytes:new Uint8Array(total),next:0,timer:setTimeout(()=>this.close(),c.label==='assets'?120000:30000)};entry.parts.set(id,part);entry.retained+=total;}
        if(offset!==part.next||part.bytes.length!==total)throw Error('Out of order');part.bytes.set(payload,offset);part.next+=payload.length;this.stats.received+=e.data.byteLength;
        if(part.next===total){
          clearTimeout(part.timer);entry.parts.delete(id);
          entry.decode=entry.decode.then(async()=>{
            if(this.closed)return;
            if(part.bytes[0]===1||part.bytes[0]===3){
              const m=await decodeJSONPacket(part.bytes,limit);
              if(this.host&&m.type==='peer-profile'){
                const p=m.profile;if(!p||!Number.isInteger(p.width)||!Number.isInteger(p.height)||p.width<1||p.width>4096||p.height<1||p.height>4096||typeof p.visible!=='boolean')return;
                this.profile=p;
                if(!this.profileTimer)this.profileTimer=setTimeout(()=>{this.profileTimer=null;this.updateVideoPolicy();this.profileChanged?.(this.profile);},100);
                return;
              }
              this.message?.(m,c.label);
            }else if(part.bytes[0]===2&&c.label==='assets'){
              const size=new DataView(part.bytes.buffer).getUint32(1);if(size>4096||size+5>total)throw Error('Asset metadata');
              const meta=JSON.parse(new TextDecoder().decode(part.bytes.subarray(5,5+size)));this.asset?.(meta,part.bytes.slice(5+size));
            }else throw Error('Invalid packet');
          }).catch(()=>this.close()).finally(()=>{entry.retained-=total;});
        }
      }catch{this.close();}
    };
  }
  async offer(){await this.pc.setLocalDescription(await this.pc.createOffer());if(!this.closed)this.signal({attempt:this.attempt,description:this.pc.localDescription.toJSON()});}
  async accept(s){
    if(this.closed||s.attempt!==this.attempt)return;
    try{if(s.description){await this.pc.setRemoteDescription(s.description);for(const c of this.pendingICE.splice(0))await this.pc.addIceCandidate(c);if(s.description.type==='offer'){await this.pc.setLocalDescription(await this.pc.createAnswer());this.signal({attempt:this.attempt,description:this.pc.localDescription.toJSON()});}}
      else if(s.candidate){if(this.pc.remoteDescription)await this.pc.addIceCandidate(s.candidate);else if(this.pendingICE.length<128)this.pendingICE.push(s.candidate);}
    }catch(error){console.warn('TabShare RTC negotiation:',error.message);this.close();}
  }
  send(m,channel='state'){const json=new TextEncoder().encode(JSON.stringify(m)),bytes=new Uint8Array(json.length+1);bytes[0]=1;bytes.set(json,1);return this.bytes(bytes,channel);}
  sendAsset(meta,data){const json=new TextEncoder().encode(JSON.stringify(meta)),bytes=new Uint8Array(data.length+json.length+5);bytes[0]=2;new DataView(bytes.buffer).setUint32(1,json.length);bytes.set(json,5);bytes.set(data,5+json.length);return this.bytes(bytes,'assets');}
  drained(entry){
    if(this.closed)return Promise.resolve(false);if(entry.c.bufferedAmount<=256*1024)return Promise.resolve(true);
    return new Promise(resolve=>{
      const done=ok=>{clearTimeout(timer);entry.c.removeEventListener('bufferedamountlow',low);entry.c.removeEventListener('close',closed);this.waiters.delete(done);resolve(ok);};
      const low=()=>{if(entry.c.bufferedAmount<=65536)done(true);},closed=()=>done(false);
      const timer=setTimeout(()=>{done(false);this.close();},10000);this.waiters.add(done);
      entry.c.addEventListener('bufferedamountlow',low);entry.c.addEventListener('close',closed);if(this.closed)closed();else low();
    });
  }
  bytes(bytes,name){
    const entry=this.channels.get(name);if(!this.ready||!entry||bytes.length>LIMIT)return Promise.resolve(false);
    if(this.queued+bytes.length>QUEUE||outstanding+bytes.length>64*1024*1024){this.close();return Promise.resolve(false);}this.queued+=bytes.length;outstanding+=bytes.length;
    const retained=bytes.length,id=++this.serial;
    const job=entry.tail.then(async()=>{
      if(this.closed)return false;
      if(name==='state'&&bytes[0]===1){const packed=await compressPacket(bytes);if(packed!==bytes){this.stats.compressed++;this.stats.saved+=bytes.length-packed.length;bytes=packed;}}
      for(let offset=0;offset<bytes.length;offset+=CHUNK){
        if(!await this.drained(entry)||this.closed)return false;
        const count=Math.min(CHUNK,bytes.length-offset),packet=new Uint8Array(count+12),header=new DataView(packet.buffer);header.setUint32(0,id);header.setUint32(4,bytes.length);header.setUint32(8,offset);packet.set(bytes.subarray(offset,offset+count),12);entry.c.send(packet);this.stats.sent+=packet.length;
      }return true;
    }).catch(()=>{this.close();return false;}).finally(()=>{this.queued-=retained;outstanding-=retained;});entry.tail=job;return job;
  }
  video(track){
    this.videoTail=(this.videoTail||Promise.resolve()).catch(()=>{}).then(async()=>{if(!this.sender||this.closed)return;await this.policyTask;await this.sender.replaceTrack(track);return this.updateVideoPolicy();});return this.videoTail;
  }
  updateVideoPolicy(){
    this.policyDirty=true;if(this.policyTask)return this.policyTask;
    this.policyTask=(async()=>{
      while(this.policyDirty&&!this.closed){this.policyDirty=false;const track=this.sender?.track;if(!track)continue;
        const params=this.sender.getParameters();params.degradationPreference='maintain-framerate';if(!params.encodings?.length)params.encodings=[{}];
        Object.assign(params.encodings[0],encodingPolicy(track.getSettings(),this.profile,this.network));
        await this.sender.setParameters(params).catch(()=>{});
      }
    })().finally(()=>{this.policyTask=null;if(this.policyDirty&&!this.closed)this.updateVideoPolicy();});return this.policyTask;
  }
  async sampleNetwork(){
    if(this.closed||!this.sender?.track||this.sampling)return;this.sampling=true;
    try{
      const reports=await this.pc.getStats(),network={};let encoded,remote;
      for(const r of reports.values()){
        if(r.type==='candidate-pair'&&r.state==='succeeded'&&(r.nominated||r.selected))Object.assign(network,{rtt:r.currentRoundTripTime,available:r.availableOutgoingBitrate});
        if(r.type==='outbound-rtp'&&(r.kind||r.mediaType)==='video')encoded=r;
        if(r.type==='remote-inbound-rtp'&&(r.kind||r.mediaType)==='video')remote=r;
      }
      if(encoded){
        const previous=this.videoSample,frames=previous?.id===encoded.id?Math.max(0,encoded.framesEncoded-previous.framesEncoded):0;
        if(frames)network.encodeMs=Math.max(0,(encoded.totalEncodeTime-previous.totalEncodeTime)*1000/frames);
        network.cpu=encoded.qualityLimitationReason==='cpu';
        if(remote&&previous?.remote?.id===remote.id){const lost=Math.max(0,remote.packetsLost-previous.remote.packetsLost),sent=Math.max(0,encoded.packetsSent-previous.packetsSent);network.loss=sent?Math.min(1,lost/sent):0;}
        this.videoSample={...encoded,remote:remote?{id:remote.id,packetsLost:remote.packetsLost}:null};
        this.stats.video={frames:encoded.framesEncoded,bytes:encoded.bytesSent,encodeMs:network.encodeMs||0,loss:network.loss||0,rtt:network.rtt||0,quality:encoded.qualityLimitationReason||'none'};
      }
      this.network=network;this.updateVideoPolicy();
    }catch{}finally{this.sampling=false;}
  }
  async route(){const stats=await this.pc.getStats();for(const r of stats.values())if(r.type==='transport'&&r.selectedCandidatePairId){const pair=stats.get(r.selectedCandidatePairId),local=stats.get(pair?.localCandidateId),remote=stats.get(pair?.remoteCandidateId);return local?.candidateType==='relay'||remote?.candidateType==='relay'?'TURN 中继':'P2P 直连';}return 'WebRTC';}
  close(){if(this.closed)return;this.closed=true;this.ready=false;clearTimeout(this.timeout);clearTimeout(this.lost);clearTimeout(this.profileTimer);clearInterval(this.policyTimer);for(const done of [...this.waiters])done(false);for(const e of this.channels.values())for(const p of e.parts.values())clearTimeout(p.timer);this.channels.clear();this.pc.close();this.state?.('down');}
}
