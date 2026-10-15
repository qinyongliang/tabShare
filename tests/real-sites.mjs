import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sites={
 google:{url:'https://www.google.com/search?q=VIVANT&hl=zh-CN',title:'VIVANT',next:'https://www.google.com/search?q=VIVANT+season+2&hl=zh-CN'},
 github:{url:'https://github.com/microsoft/TypeScript/issues',title:'TypeScript',input:'#issues-index-filter-input',query:'is:issue is:open browser',next:'https://github.com/microsoft/TypeScript'},
 go:{url:'https://go.dev/doc/',title:'Documentation',expectDOM:true,next:'https://go.dev/doc/faq'},
 youtube:{url:'https://www.youtube.com/',title:'YouTube',input:'input[name="search_query"]',query:'Chromium browser'},
 wikipedia:{url:'https://en.wikipedia.org/wiki/Web_browser',title:'Web browser',next:'https://en.wikipedia.org/wiki/Browser_extension'}
};
const safeError=error=>String(error?.message||error).split('\n')[0].replace(/https?:\/\/\S+\/s\/\S+/g,'[private share link]').slice(0,350);
async function until(check,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check())return;}catch{}await sleep(150);}throw Error('Timed out: '+label);}
async function preflight(url){
 try{const {stdout}=await exec('curl',['--head','--location','--silent','--show-error','--max-time','20','--output','/dev/null','--write-out','%{http_code}',url],{timeout:25000});const status=Number(stdout);return {status,ok:status>=200&&status<400};}
 catch(error){return {ok:false,status:Number(error.stdout)||0,reason:/CONNECT tunnel failed, response 403/.test(error.stderr||'')?'cloud-domain-policy':safeError(error)};}
}

export async function runRealSites({root,request,view,cdp,chrome,getTabs,sessions,packets,videoGeometries,errors,commandFailures,resourceReads}){
 const output=path.join(root,'test-results/real-sites');await mkdir(output,{recursive:true});
 const selected=(process.env.TEST_SITES||'github,go,youtube,wikipedia').split(',').map(s=>s.trim());
 for(const name of selected)assert.ok(sites[name],'Unknown TEST_SITES entry: '+name);
 const report={startedAt:new Date().toISOString(),scope:'Live public websites, original worker through Chrome API adapter, real CDP, two real visitors and built-in TURN/TCP; extension installation/permissions are not covered.',sites:[]};
 let currentTab,active;
 const network=new Map();
 cdp.listeners.push(event=>{
   if(!active||![...sessions].some(([id,s])=>id===currentTab&&s===event.sessionId))return;
   const p=event.params||{};
   if(event.method==='Network.requestWillBeSent'){try{network.set(p.requestId,{host:new URL(p.request.url).hostname,type:p.type});}catch{}}
   if(event.method==='Network.loadingFailed'){const request=network.get(p.requestId);if(request)active.networkFailures.push({...request,error:p.errorText});}
   if(event.method==='Network.responseReceived'&&p.response.status>=400){try{active.networkFailures.push({host:new URL(p.response.url).hostname,type:p.type,status:p.response.status});}catch{}}
 });
 for(const name of selected){
   const site=sites[name],entry={name,url:site.url,checks:[],networkFailures:[]};report.sites.push(entry);active=entry;currentTab=null;network.clear();
   entry.preflight=await preflight(site.url);
   if(!entry.preflight.ok){entry.verdict='blocked';console.log('BLOCKED real site:',name,entry.preflight.reason||('HTTP '+entry.preflight.status));continue;}
   const started=Date.now(),packetStart=packets.length,geometryStart=videoGeometries.length,errorStart=errors.length,readStart=resourceReads.length;
   let one,two,share;
   const check=async(label,fn)=>{const t=Date.now();try{await fn();entry.checks.push({name:label,status:'passed',ms:Date.now()-t});}catch(error){entry.checks.push({name:label,status:'failed',error:safeError(error)});throw error;}};
   const evaluate=expression=>cdp.evaluate(sessions.get(currentTab),expression);
   const sourceInfo=()=>evaluate(`(()=>{const images=[...document.images];return {title:document.title,url:location.origin+location.pathname,ready:document.readyState,nodes:document.querySelectorAll('*').length,bodyChars:document.body?.innerText.length||0,svg:document.querySelectorAll('svg').length,video:document.querySelectorAll('video').length,customElements:[...document.querySelectorAll('*')].filter(n=>n.localName.includes('-')).length,images:{total:images.length,loaded:images.filter(n=>n.complete&&n.naturalWidth>0).length},styleSheets:document.styleSheets.length,width:innerWidth,height:innerHeight,scrollX,scrollY,scrollHeight:document.scrollingElement.scrollHeight};})()`);
   const full=()=>one.locator('#mirror').isHidden();
   const box=selector=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,value:n.value};})()`);
   async function click(selector){
     if(!await full()){await one.frameLocator('#mirror').locator(selector).first().click({timeout:10000});return;}
     for(let i=0;i<12;i++){
       const r=await box(selector);if(!r)throw Error('Source element missing: '+selector);
       if(r.width>0&&r.height>0&&r.y+r.height/2>0&&r.y+r.height/2<r.viewportHeight){
         const bounds=await one.locator('#stream').boundingBox();if(!bounds)throw Error('Shared video is not ready');
         await one.mouse.click(bounds.x+(r.x+r.width/2)/r.viewportWidth*bounds.width,bounds.y+(r.y+r.height/2)/r.viewportHeight*bounds.height);return;
       }
       await one.locator('#surface').hover();await one.mouse.wheel(0,Math.sign(r.y)*Math.min(1800,Math.max(400,Math.abs(r.y)-200)));await sleep(400);
     }
     throw Error('Remote scroll did not bring element into view');
   }
   async function screenshots(suffix){
     await chrome.debugger.sendCommand({tabId:currentTab},'Page.bringToFront');
     const shot=await chrome.debugger.sendCommand({tabId:currentTab},'Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
     await writeFile(path.join(output,name+'-'+suffix+'-source.png'),Buffer.from(shot.data,'base64'));
     await one.screenshot({path:path.join(output,name+'-'+suffix+'-visitor.png')});
     await one.locator('#surface').screenshot({path:path.join(output,name+'-'+suffix+'-surface.png')});
   }
   try{
     share=await request({type:'share',kind:'url',url:site.url});assert.equal(share.ok,true,safeError(share.error));
     const firstView=view(share.value.shareUrl).then(page=>({page}),error=>({error}));
     await until(async()=>{const t=(await getTabs()).find(t=>{try{return new URL(t.url).hostname===new URL(site.url).hostname;}catch{return false;}});currentTab=t?.id;return !!t&&sessions.has(t.id);},'real source browser tab');
     const first=await firstView;if(first.error)throw first.error;one=first.page;two=await view(share.value.shareUrl);
     await chrome.debugger.sendCommand({tabId:currentTab},'Page.bringToFront');
     await check('two authenticated live WebRTC visitors',async()=>{await until(async()=>{const status=await Promise.all([one,two].map(p=>p.locator('#status').textContent()));return status.every(s=>s.includes('TURN 中继'));},'live TURN visitors');});
     await sleep(2500);entry.source=await sourceInfo();
     await check('real source content',async()=>{assert.ok(entry.source.title.includes(site.title), 'Unexpected source page (consent/challenge/error)');assert.ok(entry.source.nodes>100,'Source did not load website content');});
     await check('both visitors render live content',async()=>{
       await until(async()=>{
         if(await full()){const states=await Promise.all([one,two].map(p=>p.locator('#stream').evaluate(v=>({frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,hidden:v.hidden,ready:v.readyState,paused:v.paused}))));return states.every(v=>v.frames>=1&&v.width>0&&!v.hidden&&v.ready>=2&&!v.paused);}
         const text=await Promise.all([one,two].map(p=>p.frameLocator('#mirror').locator('body').innerText()));return text.every(t=>t.includes(site.title));
       },'real content in DOM or decoded website video');
       entry.render=await full()?'whole-page-video':'dom';entry.initialDOMTruncated=!!packets.at(-1)?.document.meta?.truncated;
       assert.equal(entry.render,'dom','Every website must retain native DOM rendering');
       assert.ok(!videoGeometries.slice(geometryStart).some(i=>i.full),'Only regional video is allowed');
     });
     await until(()=>one.locator('#surface').getAttribute('data-syncing').then(v=>v==='false'),'initial progressive DOM complete',45000);
     entry.mirror=await one.frameLocator('#mirror').locator('body').evaluate(n=>({margin:getComputedStyle(n).margin,style:n.getAttribute('style'),id:n.dataset.nodeId,css:n.ownerDocument.getElementById('ts-page-css')?.textContent.slice(0,600),rules:n.ownerDocument.getElementById('ts-page-css')?.sheet?.cssRules.length}));
     await screenshots('initial');
     if(site.input){
       await check('remote typing changes real source field',async()=>{
         await one.bringToFront();
         const frames=await Promise.all([one,two].map(p=>p.locator('#stream').evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames)));
         await until(()=>box(site.input).then(Boolean),'website search input');await click(site.input);await one.keyboard.press('Control+A');await one.keyboard.insertText(site.query);
         await until(()=>box(site.input).then(r=>r?.value===site.query),'source receives exact query');
         if(await full())await until(async()=>{const after=await Promise.all([one,two].map(p=>p.locator('#stream').evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames)));return after.every((n,i)=>n>frames[i]);},'typing refreshes both decoded website videos');
         else await until(()=>two.frameLocator('#mirror').locator(site.input).inputValue().then(v=>v===site.query),'second visitor receives same field value');
       });
       const blockedScript=entry.networkFailures.some(f=>f.type==='Script');
       if(blockedScript)entry.checks.push({name:'website search submission',status:'blocked',reason:'Website JavaScript requests failed; a search result cannot establish application compatibility.'});
       else await check('website search submission',async()=>{
         await one.keyboard.press('Enter');await until(()=>evaluate('location.href').then(url=>name==='youtube'?url.includes('/results?search_query='):url.includes('q=')),'website search navigation');
       });
       await screenshots('search');
     }
     await check('remote scrolling changes real source viewport',async()=>{
       const before=await sourceInfo();await one.locator('#surface').hover();await one.mouse.wheel(0,before.scrollY>300?-600:600);
       await until(()=>sourceInfo().then(after=>Math.abs(after.scrollY-before.scrollY)>10),'real page scrolled');
     });
     if(name==='go')await check('native mirrored link navigates real source',async()=>{
       await one.frameLocator('#mirror').getByRole('link',{name:'Installing Go',exact:true}).click();
       await until(()=>evaluate('location.pathname').then(path=>path==='/doc/install'),'native link opens installation guide');
       await until(()=>two.locator('#address').inputValue().then(url=>url==='https://go.dev/doc/install'),'second visitor follows native link');
     });
     if(site.next)await check('remote address navigation reaches real next page',async()=>{
       await one.locator('#share-settings-toggle').click();await one.locator('#address').fill(site.next);await one.locator('#address').press('Enter');await one.locator('#share-settings-toggle').click();await until(()=>evaluate('location.origin+location.pathname').then(url=>url===site.next),'source navigated');
       await until(()=>two.locator('#address').inputValue().then(url=>url.startsWith(site.next)),'second visitor follows navigation');
     });
     if(name==='youtube')await check('real YouTube watch page and playback control',async()=>{
       await one.locator('#share-settings-toggle').click();await one.locator('#address').fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');await one.locator('#address').press('Enter');await one.locator('#share-settings-toggle').click();
       await until(()=>evaluate('(()=>{const v=document.querySelector("video");return v?.readyState>=2&&v.duration>=15&&v.duration<=30&&!document.querySelector("#movie_player")?.classList.contains("ad-showing");})()'),'YouTube public clip loaded without an ad',45000);
       if(!await evaluate('document.querySelector("video").paused')){await click('.ytp-play-button');await until(()=>evaluate('document.querySelector("video").paused'),'remote pause before playback');}
       await click('.ytp-play-button');await until(()=>evaluate('!document.querySelector("video").paused&&!document.querySelector("video").ended'),'remote starts playback');
       const before=await evaluate('document.querySelector("video").currentTime');
       await until(()=>evaluate('document.querySelector("video").currentTime').then(t=>t>before+.5),'YouTube playback advances',30000);
       await click('.ytp-play-button');await until(()=>evaluate('document.querySelector("video").paused'),'remote pauses playback');
     });
     await screenshots('final');entry.after=await sourceInfo();
     const rtcStats=p=>p.evaluate(async()=>{
       const all=(await Promise.all(globalThis.__rtc.map(p=>p.getStats()))).flatMap(s=>[...s.values()]);
       const sum=(type,key,predicate=()=>true)=>all.filter(s=>s.type===type&&predicate(s)).reduce((n,s)=>n+(s[key]||0),0);
       return {receivedICEBytes:sum('candidate-pair','bytesReceived',s=>s.nominated&&s.state==='succeeded'),receivedVideoBytes:sum('inbound-rtp','bytesReceived',s=>s.kind==='video'),receivedDataBytes:sum('data-channel','bytesReceived'),decodedFrames:sum('inbound-rtp','framesDecoded',s=>s.kind==='video')};
     });
     await until(()=>one.locator('#surface').getAttribute('data-syncing').then(v=>v==='false'),'navigation DOM settled before traffic sample',60000);
     await until(()=>evaluate("document.readyState==='complete'&&document.fonts.status==='loaded'"),'website resources settled',45000);
     const batchStart=packets.length,before=await Promise.all([one,two].map(rtcStats)),idleStart=Date.now();await sleep(5000);
     const after=await Promise.all([one,two].map(rtcStats)),batches=packets.slice(batchStart);
     entry.fiveSecondTraffic={elapsedMs:Date.now()-idleStart,batches:batches.length,rawDOMBytes:batches.reduce((n,p)=>n+p.bytes,0),resets:batches.filter(p=>p.document.reset).length,visitors:after.map((s,i)=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v-before[i][k]])))};
     entry.viewerErrors=errors.slice(errorStart);assert.deepEqual(entry.viewerErrors,[],'visitor script errors');
   }catch(error){entry.error=safeError(error);entry.commandFailures=commandFailures.filter(f=>f.tabId===currentTab);if(one){entry.viewerStatus=await one.locator('#status').textContent().catch(()=>null);if(currentTab)await screenshots('failure').catch(()=>{});}}
   finally{
     entry.elapsedMs=Date.now()-started;
     entry.commandFailures=commandFailures.filter(f=>f.tabId===currentTab);
     entry.resourceReadFailures=resourceReads.slice(readStart).filter(r=>r.error).map(r=>({name:r.kind.split('?')[0],error:safeError(r.error)}));
     if(one)entry.viewerRender=await Promise.all([one,two].filter(Boolean).map(p=>p.locator('#stream').evaluate(v=>({frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,hidden:v.hidden,ready:v.readyState,paused:v.paused})).catch(()=>null)));
     const captured=packets.slice(packetStart);entry.capture={batches:captured.length,rawDOMBytes:captured.reduce((n,p)=>n+p.bytes,0),resets:captured.filter(p=>p.document.reset).length,truncated:captured.some(p=>p.document.meta?.truncated)};
     entry.videoFallbacks=videoGeometries.slice(geometryStart).map(i=>({full:i.full,regions:i.regions?.length||0})).filter((v,i,a)=>!i||JSON.stringify(v)!==JSON.stringify(a[i-1]));
     entry.networkFailures=[...new Map(entry.networkFailures.map(f=>[JSON.stringify(f),f])).values()];
     entry.verdict=entry.error?'failed':entry.networkFailures.some(f=>['Script','Stylesheet','Font','Image'].includes(f.type)&&f.error!=='net::ERR_ABORTED')||entry.checks.some(c=>c.status==='blocked')?'partial-network-blocked':'passed';
     await one?.close().catch(()=>{});await two?.close().catch(()=>{});if(share?.value?.session?.id)await request({type:'revoke',id:share.value.session.id}).catch(()=>{});
     console.log('REAL SITE:',name,entry.verdict,JSON.stringify({render:entry.render,nodes:entry.source?.nodes,checks:entry.checks.map(c=>({name:c.name,status:c.status})),error:entry.error,failedHosts:[...new Set(entry.networkFailures.map(f=>f.host))]}));
     await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');active=null;
   }
 }
 report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
 if(report.sites.some(site=>site.verdict!=='passed'))throw Error('Real-site verification incomplete: '+report.sites.filter(s=>s.verdict!=='passed').map(s=>s.name+'='+s.verdict).join(', '));
}
