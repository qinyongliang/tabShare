// Cache-update microbenchmark only: excludes DOM layout, network and video.
// node benchmarks/sparse-mirror.mjs [baseline git ref]
import {execFileSync} from 'node:child_process';
import {Mirror as Current} from '../web/mirror.js';
const ref=process.argv[2]||'330b4229beaee2cb139ee82a9c48d0c9c64172a2';
const source=execFileSync('git',['show',ref+':web/mirror.js'],{encoding:'utf8'});
const {Mirror:Baseline}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const count=20000;
function measure(Type,fields){
  const mirror=new Type({},null),node={nodeType:1,tagName:'INPUT',type:'text',dataset:{nodeId:'1'},value:'',style:{setProperty(){},removeProperty(){}},setAttribute(){},removeAttribute(){}};
  mirror.properties(node,{id:'1',style:Object.fromEntries(Array.from({length:fields},(_,i)=>['property-'+i,'value-'+i])),attrs:{title:'example'},value:'initial'});
  const initial=mirror.states.get('1');let clones=0;const start=performance.now();
  for(let i=0;i<count;i++){mirror.properties(node,{id:'1',value:String(i)});if(mirror.states.get('1').style!==initial.style)clones++;}
  return {ms:performance.now()-start,styleCopies:clones};
}
const report={runtime:process.version,baseline:ref,scope:'20,000 sparse input cache updates; inert DOM adapter, not browser latency',cases:[]};
for(const fields of [0,20,100]){
  for(let i=0;i<3;i++){measure(Baseline,fields);measure(Current,fields);}
  const before=[],after=[];
  for(let i=0;i<7;i++){const pair=i%2?[Current,Baseline]:[Baseline,Current];for(const Type of pair)(Type===Baseline?before:after).push(measure(Type,fields));}
  const median=values=>values.map(v=>v.ms).sort((a,b)=>a-b)[3];
  report.cases.push({fields,baselineMedianMs:median(before),optimizedMedianMs:median(after),baselineStyleCopies:before[0].styleCopies,optimizedStyleCopies:after[0].styleCopies});
}
console.log(JSON.stringify(report,null,2));
