// Real browser transport load check. The weak peer uses a bounded local TCP
// shaper in front of the application's TURN/TCP listener; no browser policy changes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {Transform} from 'node:stream';
import {chromium} from 'playwright-core';

const root=path.resolve(import.meta.dirname,'..'),duration=Number(process.env.TEST_SOAK_SECONDS||30);
assert.ok(Number.isFinite(duration)&&duration>=10&&duration<=86400);
const temporary=await mkdtemp(path.join(tmpdir(),'tabshare-transport-')),members=[],connections=new Set();
let app,browser,page,fixture,proxy,log='';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(50);}throw Error('Timed out: '+label);}
async function port(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
class Shaper extends Transform{
  _transform(chunk,encoding,done){
    let offset=0;this.nextAt??=Date.now()+75;
    const schedule=()=>{this.timer=setTimeout(send,Math.max(0,this.nextAt-Date.now()));};
    const send=()=>{if(this.destroyed)return done();const part=chunk.subarray(offset,offset+1024);offset+=part.length;this.push(part);this.nextAt=Math.max(Date.now(),this.nextAt)+1000*part.length/65536;if(offset===chunk.length)done();else schedule();};
    schedule();
  }
  _destroy(error,done){clearTimeout(this.timer);done(error);}
}
try{
 const listen=await port(),turn=await port(),origin='http://localhost:'+listen;
 app=spawn(path.join(root,'bin/tabshare'),['-listen','127.0.0.1:'+listen,'-public-url',origin,'-data',temporary,'-stun','','-turn-listen','127.0.0.1:'+turn,'-turn-allow-private-peers'],{cwd:root,env:{...process.env,TABSHARE_TURN_URLS:'',TABSHARE_TURN_SECRET:'',TABSHARE_TURN_LISTEN:'',TABSHARE_TURN_PUBLIC_IP:''},stdio:['ignore','ignore','pipe']});
 app.stderr.on('data',data=>{log=(log+data.toString()).slice(-2000);});
 await until(async()=>{try{return(await fetch(origin+'/healthz')).ok;}catch{return false;}},'test relay');
 const token=(await readFile(path.join(temporary,'admin-token'),'utf8')).trim();
 const created=await fetch(origin+'/api/sessions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({agentId:'transport-browser',kind:'url',url:'https://example.com'})}).then(r=>r.json());
 const ice=[];
 for(let i=0;i<10;i++){
   const ws=new WebSocket(origin.replace('http','ws')+'/ws/view/'+created.session.id);members.push(ws);
   ice.push(await new Promise((resolve,reject)=>{ws.onopen=()=>ws.send(JSON.stringify({type:'join',key:created.session.key}));ws.onerror=()=>reject(Error('fixture membership failed'));ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='joined')resolve(m.iceServers.filter(s=>s.username).map(s=>({...s,urls:s.urls.filter(u=>u.includes('transport=tcp'))})));if(m.type==='ping')ws.send(JSON.stringify({type:'pong'}));};}));
 }
 proxy=net.createServer(client=>{
   const upstream=net.connect(turn,'127.0.0.1'),out=new Shaper({highWaterMark:65536}),back=new Shaper({highWaterMark:65536});
   connections.add(client);connections.add(upstream);
   const close=()=>{client.destroy();upstream.destroy();out.destroy();back.destroy();connections.delete(client);connections.delete(upstream);};
   client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
   client.pipe(out).pipe(upstream);upstream.pipe(back).pipe(client);
 });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const weak=ice[0].map(s=>({...s,urls:['turn:127.0.0.1:'+proxy.address().port+'?transport=tcp']}));
 fixture=http.createServer(async(req,res)=>{
   if(['/extension/peer.js','/extension/document-state.js','/extension/video-capture.js','/extension/video-layout.js'].includes(req.url)){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(root,req.url)));return;}
   res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>Transport test</body>');
 });await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+fixture.address().port);
 await page.evaluate(async({ice,weak})=>{
   const {PeerLink}=await import('/extension/peer.js'),{DocumentState}=await import('/extension/document-state.js'),{NativeCapture}=await import('/extension/video-capture.js'),{videoLayout}=await import('/extension/video-layout.js');
   const pairs=[];let sequence=1,paintCount=0;
   const source=document.createElement('canvas');source.width=640;source.height=360;document.body.append(source);
   const paint=()=>{const ctx=source.getContext('2d');ctx.fillStyle='blue';ctx.fillRect(0,0,640,360);ctx.fillStyle='rgb('+(paintCount++%255)+',30,0)';ctx.fillRect(100,50,100,60);};paint();
   const capture=new NativeCapture(source.captureStream(30).getVideoTracks()[0],{changed:()=>{for(const p of pairs)void p.host.video(capture.track);}});
   capture.setLayout(videoLayout({width:640,height:360,scrollX:0,scrollY:0,full:false,regions:[{id:'a',x:100,y:50,width:100,height:60}]}));capture.setActive(true);
   const painting=setInterval(paint,33);
   const snapshot=()=>({reset:true,version:'load',sequence,root:'1',nodes:[{id:'1',tag:'body',text:String(sequence),style:{color:'red'},children:['2']},{id:'2',tag:'div',text:'repeated style '.repeat(2000),style:{color:'blue'}}],meta:{width:640,height:360}});
   async function add(index){
     const attempt=crypto.randomUUID(),p={index,state:new DocumentState(),inputs:0,last:0,asset:false,downs:0};
     const video=document.createElement('video');video.muted=true;video.playsInline=true;video.style.cssText='width:100px;height:60px';document.body.append(video);p.video=video;
     p.guest=new PeerLink({attempt,iceServers:index===0?weak:ice[index],signal:s=>void p.host.accept(s),track:stream=>{video.srcObject=stream;void video.play();},message:m=>{if(m.type==='dom'){try{const d=m.document;if(!d.reset&&(d.version!==p.state.version||d.sequence<=p.last))throw Error('unordered state');p.state.apply(d);p.last=d.sequence;if(p.state.nodes.get('1')?.text!==String(p.last))throw Error('lost delta');}catch{p.failed=true;}}},asset:(meta,bytes)=>{(p.assetOrder??=[]).push(meta.id);if(meta.id==='load_0')p.asset=bytes.length===262144&&bytes[0]===0&&bytes[bytes.length-1]===255;},state:s=>{if(s==='down')p.downs++;}});
     p.host=new PeerLink({host:true,attempt,iceServers:ice[index],signal:s=>void p.guest.accept(s),message:m=>{if(m.type==='input')p.inputs++;}});
     for(const link of [p.host,p.guest]){
       // Relay-only is the same deterministic TURN/TCP test configuration used
       // by e2e.mjs. It never changes the managed Chromium policy.
       link.pc.setConfiguration({...link.pc.getConfiguration(),iceTransportPolicy:'relay'});
     }
     pairs[index]=p;await p.host.video(capture.track);await p.host.offer();
   }
   globalThis.loadCheck={pairs,capture,add,sequence:()=>sequence,
     grow:async n=>{const start=pairs.length;await Promise.all(Array.from({length:n-start},(_,j)=>add(start+j)));},
     seed:()=>{for(const p of pairs)void p.host.send({type:'dom',document:snapshot()});},
     tick:()=>{sequence++;for(const p of pairs){void p.host.send({type:'dom',document:{version:'load',sequence,root:'1',updates:[{id:'1',changes:{text:String(sequence)}}],meta:{width:640,height:360}}});void p.guest.send({type:'input',input:{action:'text',text:'tick'}},'input');}},
     weakAsset:()=>{const bytes=Uint8Array.from({length:262144},(_,i)=>i%256);void pairs[0].host.sendAsset({id:'load_0',size:bytes.length,mime:'image/png'},bytes);for(let i=0;i<12;i++)void pairs[0].host.sendAsset({id:'icon_'+i,size:1024,mime:'image/png'},new Uint8Array(1024));},
     mode:full=>capture.setLayout(videoLayout({...capture.layout,full})),
     replace:async index=>{const p=pairs[index];p.host.close();p.guest.close();p.video.remove();await add(index);},
     report:()=>({sequence,peers:pairs.map(p=>({ready:p.host.ready&&p.guest.ready,last:p.last,inputs:p.inputs,failed:!!p.failed,downs:p.downs,asset:p.asset,queued:p.host.queued+p.guest.queued,frames:p.video.getVideoPlaybackQuality().totalVideoFrames,video:p.host.stats.video,encoding:p.host.sender.getParameters().encodings?.[0]}))}),
     stop:()=>{clearInterval(painting);capture.stop();for(const p of pairs){p.host.close();p.guest.close();p.video.srcObject=null;}}
   };
 },{ice,weak});
 for(const count of [1,5,10]){
   await page.evaluate(n=>loadCheck.grow(n),count);
   await until(()=>page.evaluate(n=>loadCheck.report().peers.length===n&&loadCheck.report().peers.every(p=>p.ready),count),count+' ready peers');
   await page.evaluate(()=>loadCheck.seed());
   await until(()=>page.evaluate(()=>loadCheck.report().peers.every(p=>p.last===loadCheck.sequence())),'initial snapshots');
   console.log('PASS:',count,'real TURN/TCP peers with compressed DOM and shared regional video');
 }
 await until(()=>page.evaluate(()=>loadCheck.pairs[9].video.videoWidth===100),'cropped native video decoded');
 await page.evaluate(()=>loadCheck.mode(true));
 await until(()=>page.evaluate(()=>loadCheck.pairs[9].video.videoWidth===640),'full native track decoded');
 await page.evaluate(()=>loadCheck.mode(false));
 await until(()=>page.evaluate(()=>loadCheck.pairs[9].video.videoWidth===100),'native region restored');
 console.log('PASS: native full-frame and cropped track replacement reaches real RTP decoder');
 await page.evaluate(()=>loadCheck.weakAsset());
 const inputStart=Date.now(),before=await page.evaluate(()=>loadCheck.pairs[9].inputs);
 await page.evaluate(()=>loadCheck.tick());
 await until(()=>page.evaluate(n=>loadCheck.pairs[9].inputs>n,before),'normal input while weak peer transfers',3000);
 const inputMs=Date.now()-inputStart;let replaced=false,peakQueue=0;
 const end=Date.now()+duration*1000;
 while(Date.now()<end){
   await page.evaluate(()=>loadCheck.tick());
   if(!replaced&&Date.now()>end-duration*500){await page.evaluate(()=>loadCheck.replace(5));await until(()=>page.evaluate(()=>loadCheck.pairs[5].host.ready&&loadCheck.pairs[5].guest.ready),'replacement peer');await page.evaluate(()=>loadCheck.seed());replaced=true;}
   const report=await page.evaluate(()=>loadCheck.report());
   assert.ok(report.peers.every(p=>!p.failed&&p.downs===0),'state corruption or unexpected disconnect');
   peakQueue=Math.max(peakQueue,...report.peers.map(p=>p.queued));
   await delay(200);
 }
 await until(()=>page.evaluate(()=>{const r=loadCheck.report();return r.peers.every(p=>p.ready&&p.last===r.sequence&&p.inputs>0&&p.frames>1&&p.video?.frames>0)&&r.peers[0].asset;}),'all peers catch up after shaped traffic',30000);
 const assetOrder=await page.evaluate(()=>loadCheck.pairs[0].assetOrder);assert.equal(assetOrder.filter(id=>id.startsWith('icon_')).length,12);assert.ok(assetOrder.indexOf('icon_11')<assetOrder.indexOf('load_0'),'small P2P assets bypass a large asset through fragment interleaving');
 const result=await page.evaluate(()=>loadCheck.report());
 assert.ok(result.peers.every(p=>p.video&&p.video.frames>0),'actual RTP stats are sampled');
 await page.evaluate(()=>loadCheck.stop());
 await until(()=>page.evaluate(()=>loadCheck.report().peers.every(p=>p.queued===0)),'closed peer budgets released');
 assert.deepEqual(errors,[]);
 console.log('PASS:',duration+'s','10-peer sustained deltas/input/video, 64 KiB/s weak TCP peer, reconnect and cleanup;',JSON.stringify({normalInputMs:inputMs,peakQueuedBytes:peakQueue,minDecodedFrames:Math.min(...result.peers.map(p=>p.frames)),lastSequence:result.sequence}));
}catch(error){console.error(error.message);if(page)console.error('Transport state:',await page.evaluate(()=>globalThis.loadCheck?.report()).catch(()=>null));if(log)console.error('Test relay:',log);process.exitCode=1;}
finally{
 if(browser)await browser.close();for(const ws of members)ws.close();for(const c of connections)c.destroy();
 if(proxy)await new Promise(resolve=>proxy.close(resolve));if(fixture)await new Promise(resolve=>fixture.close(resolve));
 if(app&&app.exitCode===null){app.kill('SIGTERM');await new Promise(resolve=>app.once('exit',resolve));}
 await rm(temporary,{recursive:true,force:true});
}
