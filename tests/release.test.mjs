import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {artifactNames,selectRelease} from '../.github/scripts/select-release.mjs';
import {prepareRelease} from '../.github/scripts/prepare-release.mjs';

function selection(overrides={}) {
  const outputs={},sha='a'.repeat(40),run={id:123,workflow_id:456,status:'completed',conclusion:'success',head_sha:sha,head_branch:'v0.5.2',head_repository:{full_name:'owner/repo'},event:'push',...overrides};
  const artifacts=artifactNames.map(name=>({name,expired:false}));
  const github={rest:{git:{getRef:async()=>({data:{object:{type:'tag',sha:'b'.repeat(40)}}}),getTag:async()=>({data:{object:{type:'commit',sha}}})},actions:{listWorkflowRuns:'runs',listWorkflowRunArtifacts:'artifacts',getWorkflowRun:async()=>({data:run}),getWorkflow:async()=>({data:{id:456}})}},paginate:async endpoint=>endpoint==='runs'?[run]:artifacts};
  return {github,context:{repo:{owner:'owner',repo:'repo'},eventName:'push',payload:{}},core:{notice(){},info(){},setOutput:(k,v)=>{outputs[k]=v;}},version:'0.5.2',outputs,artifacts,run};
}

test('release backfill resolves annotated tags and selects only their successful tag build',async()=>{
  const s=selection();await selectRelease(s);assert.equal(s.outputs.tag,'v0.5.2');assert.equal(s.outputs.commit,'a'.repeat(40));assert.equal(s.outputs['run-id'],'123');assert.equal(s.outputs.publish,'true');
  const bad=selection({head_sha:'c'.repeat(40)});await assert.rejects(selectRelease(bad),/provenance/);assert.notEqual(bad.outputs.publish,'true');
  const fork=selection({head_repository:{full_name:'other/repo'}});await assert.rejects(selectRelease(fork),/provenance/);
  const workflow=selection({workflow_id:999});await assert.rejects(selectRelease(workflow),/provenance/);
});

test('release refuses expired artifacts and a workflow completion from another branch',async()=>{
  const expired=selection();expired.artifacts[0].expired=true;await assert.rejects(selectRelease(expired),/expired/);
  const branch=selection({head_branch:'main'});branch.context.eventName='workflow_run';branch.context.payload.workflow_run=branch.run;await selectRelease(branch);assert.equal(branch.outputs.publish,'false');
});

test('release verifies all seven checksums before preparing uploads, preserving each checksum',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tabshare-release-')),input=path.join(root,'downloads'),output=path.join(root,'release');
  try{
    await mkdir(input);
    for(const name of artifactNames){const dir=path.join(input,name);await mkdir(dir);const file=name+(name==='tabshare-extension'||name.startsWith('tabshare-windows-')?'.zip':'.tar.gz'),data=Buffer.from('built '+name),hash=createHash('sha256').update(data).digest('hex');await writeFile(path.join(dir,file),data);await writeFile(path.join(dir,'SHA256SUMS.txt'),hash+'  '+file+'\n');}
    const files=await prepareRelease(input,output);assert.equal(files.length,7);assert.equal((await readdir(output)).length,8);assert.equal((await readFile(path.join(output,'SHA256SUMS.txt'),'utf8')).trim().split('\n').length,7);
    await writeFile(path.join(input,'tabshare-windows-arm64','tabshare-windows-arm64.zip'),'corrupted');
    const rejected=path.join(root,'rejected');await assert.rejects(prepareRelease(input,rejected),/Checksum mismatch/);assert.deepEqual(await readdir(rejected),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});
