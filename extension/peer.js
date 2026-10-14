// Reliable, bounded SCTP streams. The extension ships the same module.
const CHUNK=16*1024, LIMIT=12*1024*1024, QUEUE=24*1024*1024;
export class PeerLink {
  constructor({host=false,iceServers=[],attempt=crypto.randomUUID(),signal,message,asset,track,state}) {
    this.host=host;this.attempt=attempt;this.signal=signal;this.message=message;this.asset=asset;this.state=state;this.channels=new Map();this.pendingICE=[];this.closed=false;this.ready=false;this.serial=0;this.queued=0;
    this.pc=new RTCPeerConnection({iceServers,bundlePolicy:'max-bundle'});
    this.pc.onicecandidate=e=>{if(e.candidate)this.signal({attempt:this.attempt,candidate:e.candidate.toJSON()});};
    this.pc.ontrack=e=>track?.(new MediaStream([e.track]));
    this.pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(this.pc.connectionState))this.close();if(this.pc.connectionState==='disconnected'){clearTimeout(this.lost);this.lost=setTimeout(()=>this.close(),8000);}else clearTimeout(this.lost);};
    this.pc.ondatachannel=e=>this.channel(e.channel);
    this.timeout=setTimeout(()=>this.close(),15000);
    if(host){this.sender=this.pc.addTransceiver('video',{direction:'sendonly'}).sender;for(const name of ['state','input','assets'])this.channel(this.pc.createDataChannel(name,{ordered:true}));}
  }
  channel(c) {
    if(!['state','input','assets'].includes(c.label)||this.channels.has(c.label)){c.close();return;}
    const entry={c,tail:Promise.resolve(),parts:new Map(),retained:0};this.channels.set(c.label,entry);c.binaryType='arraybuffer';c.bufferedAmountLowThreshold=65536;
    c.onopen=()=>{if(this.channels.size===3&&[...this.channels.values()].every(e=>e.c.readyState==='open')){clearTimeout(this.timeout);this.ready=true;this.state?.('up');}};
    c.onclose=()=>this.close();c.onerror=()=>this.close();
    c.onmessage=e=>{
      try{
        if(this.host&&c.label!=='input'||!this.host&&c.label==='input')throw Error('Unexpected channel direction');
        if(!(e.data instanceof ArrayBuffer)||e.data.byteLength<13||e.data.byteLength>CHUNK+12)throw Error('Invalid fragment');
        const view=new DataView(e.data),id=view.getUint32(0),total=view.getUint32(4),offset=view.getUint32(8),payload=new Uint8Array(e.data,12);
        if(total<1||total>(c.label==='input'?16384:LIMIT)||offset+payload.length>total)throw Error('Invalid size');
        let part=entry.parts.get(id);
        if(!part){if(offset!==0||entry.parts.size>=4||entry.retained+total>QUEUE)throw Error('Receive budget');part={bytes:new Uint8Array(total),next:0,timer:setTimeout(()=>this.close(),30000)};entry.parts.set(id,part);entry.retained+=total;}
        if(offset!==part.next||part.bytes.length!==total)throw Error('Out of order');part.bytes.set(payload,offset);part.next+=payload.length;
        if(part.next===total){clearTimeout(part.timer);entry.parts.delete(id);entry.retained-=total;
          if(part.bytes[0]===1){const m=JSON.parse(new TextDecoder().decode(part.bytes.subarray(1)));this.message?.(m,c.label);}
          else if(part.bytes[0]===2&&c.label==='assets'){const size=new DataView(part.bytes.buffer).getUint32(1);if(size>4096||size+5>total)throw Error('Asset metadata');const meta=JSON.parse(new TextDecoder().decode(part.bytes.subarray(5,5+size)));this.asset?.(meta,part.bytes.slice(5+size));}
          else throw Error('Invalid packet');
        }
      }catch{this.close();}
    };
  }
  async offer() {await this.pc.setLocalDescription(await this.pc.createOffer());if(!this.closed)this.signal({attempt:this.attempt,description:this.pc.localDescription.toJSON()});}
  async accept(s) {
    if(this.closed||s.attempt!==this.attempt)return;
    try{if(s.description){await this.pc.setRemoteDescription(s.description);for(const c of this.pendingICE.splice(0))await this.pc.addIceCandidate(c);if(s.description.type==='offer'){await this.pc.setLocalDescription(await this.pc.createAnswer());this.signal({attempt:this.attempt,description:this.pc.localDescription.toJSON()});}}
      else if(s.candidate){if(this.pc.remoteDescription)await this.pc.addIceCandidate(s.candidate);else if(this.pendingICE.length<128)this.pendingICE.push(s.candidate);}
    }catch(error){console.warn('TabShare RTC negotiation:',error.message);this.close();}
  }
  send(m,channel='state') {const json=new TextEncoder().encode(JSON.stringify(m)),bytes=new Uint8Array(json.length+1);bytes[0]=1;bytes.set(json,1);return this.bytes(bytes,channel);}
  sendAsset(meta,data) {const json=new TextEncoder().encode(JSON.stringify(meta)),bytes=new Uint8Array(data.length+json.length+5);bytes[0]=2;new DataView(bytes.buffer).setUint32(1,json.length);bytes.set(json,5);bytes.set(data,5+json.length);return this.bytes(bytes,'assets');}
  bytes(bytes,name) {
    const entry=this.channels.get(name);if(!this.ready||!entry||bytes.length>LIMIT)return Promise.resolve(false);
    if(this.queued+bytes.length>QUEUE){this.close();return Promise.resolve(false);}this.queued+=bytes.length;
    const id=++this.serial;const job=entry.tail.then(async()=>{
      for(let offset=0;offset<bytes.length;offset+=CHUNK){
        while(!this.closed&&entry.c.bufferedAmount>256*1024)await new Promise(resolve=>setTimeout(resolve,10));
        if(this.closed)return false;
        const count=Math.min(CHUNK,bytes.length-offset),packet=new Uint8Array(count+12),header=new DataView(packet.buffer);header.setUint32(0,id);header.setUint32(4,bytes.length);header.setUint32(8,offset);packet.set(bytes.subarray(offset,offset+count),12);entry.c.send(packet);
      }return true;
    }).catch(()=>{this.close();return false;}).finally(()=>{this.queued-=bytes.length;});entry.tail=job;return job;
  }
  async video(track) {if(!this.sender||this.closed)return;await this.sender.replaceTrack(track);if(track){const p=this.sender.getParameters();if(!p.encodings?.length)p.encodings=[{}];p.encodings[0].maxBitrate=4000000;p.encodings[0].maxFramerate=30;await this.sender.setParameters(p).catch(()=>{});}}
  async route() {const stats=await this.pc.getStats();for(const report of stats.values())if(report.type==='transport'&&report.selectedCandidatePairId){const pair=stats.get(report.selectedCandidatePairId),local=stats.get(pair?.localCandidateId),remote=stats.get(pair?.remoteCandidateId);return local?.candidateType==='relay'||remote?.candidateType==='relay'?'TURN 中继':'P2P 直连';}return 'WebRTC';}
  close() {if(this.closed)return;this.closed=true;this.ready=false;clearTimeout(this.timeout);clearTimeout(this.lost);for(const e of this.channels.values())for(const p of e.parts.values())clearTimeout(p.timer);this.channels.clear();this.pc.close();this.state?.('down');}
}
