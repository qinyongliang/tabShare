// npm install --prefix /tmp/tabshare-protocol-bench --ignore-scripts protobufjs@8.8.1
// PROTOBUF_MODULE=/tmp/tabshare-protocol-bench/node_modules/protobufjs/index.js node benchmarks/protocol.mjs
// Synthetic packet subset; not full protocol interoperability or browser latency.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
const {default:protobuf}=await import(pathToFileURL(process.env.PROTOBUF_MODULE||'/tmp/tabshare-protocol-bench/node_modules/protobufjs/index.js'));
const schema=protobuf.parse(await readFile(new URL('./protocol.proto',import.meta.url),'utf8')).root.lookupType('tabshare.benchmark.Packet');
function node(value){return {...value,...Object.fromEntries(['style','attrs'].filter(k=>value[k]).map(k=>[k,Object.fromEntries(Object.entries(value[k]).map(([name,v])=>[name,v===null?{deleted:true}:{text:v}]))]))};}
function encode(value){return schema.encode({...value,...(value.styles?{styles:value.styles.map(style=>({values:node({style}).style}))}:{}),...(value.nodes?{nodes:value.nodes.map(node)}:{}),...(value.updates?{updates:value.updates.map(u=>({id:u.id,changes:node(u.changes)}))}:{})}).finish();}
function unpackNode(value){return {...value,...Object.fromEntries(['style','attrs'].filter(k=>value[k]).map(k=>[k,Object.fromEntries(Object.entries(value[k]).map(([name,v])=>[name,v.deleted?null:v.text??'']))]))};}
function decode(bytes){const value=schema.toObject(schema.decode(bytes));return {...value,...(value.styles?{styles:value.styles.map(style=>unpackNode({style:style.values}).style)}:{}),...(value.nodes?{nodes:value.nodes.map(unpackNode)}:{}),...(value.updates?{updates:value.updates.map(u=>({id:u.id,changes:unpackNode(u.changes)}))}:{})};}
const cases={
  input:{type:'input',action:'text',nodeId:'23',text:'中文输入 latency'},
  textDiff:{type:'dom',version:'doc-1',sequence:42,updates:[{id:'23',changes:{text:'实时更新 123'}}]},
  stylesDiff:{type:'dom',version:'doc-1',sequence:43,updates:Array.from({length:20},(_,i)=>({id:String(i+1),changes:{style:{color:'rgb(23, 45, 67)',width:null},attrs:{title:'row '+i}}}))},
  initial:{type:'dom',version:'doc-1',sequence:1,reset:true,root:'1',nodes:Array.from({length:300},(_,i)=>({id:String(i+1),tag:'div',text:'内容 '+i,style:{display:'block',color:'rgb(23, 45, 67)',width:'100px'},attrs:{title:'row '+i}}))}
};
cases.initialPooled={...cases.initial,styles:[cases.initial.nodes[0].style],nodes:cases.initial.nodes.map(({style,...node})=>({...node,styleRef:0}))};
const report={runtime:process.version,protobufVersion:'8.8.1',scope:'Synthetic subset; map/null adapter costs included; initialPooled includes production-style pooling; prototype is not the full schema',cases:[]};
for(const [name,value] of Object.entries(cases)){
  const json=Buffer.from(JSON.stringify(value)),proto=encode(value);assert.deepEqual(decode(proto),value);
  const rounds=name.startsWith('initial')?100:1000;
  const timing=fn=>{const samples=[];for(let pass=0;pass<8;pass++){const start=performance.now();for(let i=0;i<rounds;i++)fn();if(pass)samples.push((performance.now()-start)/rounds);}return samples.sort((a,b)=>a-b)[3];};
  report.cases.push({name,jsonBytes:json.length,protobufBytes:proto.length,jsonGzipBytes:gzipSync(json).length,protobufGzipBytes:gzipSync(proto).length,jsonRoundtripMs:timing(()=>JSON.parse(JSON.stringify(value))),protobufRoundtripMs:timing(()=>decode(encode(value)))});
}
console.log(JSON.stringify(report,null,2));
