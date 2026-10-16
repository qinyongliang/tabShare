export const artifactNames=['tabshare-extension',...['linux','darwin','windows'].flatMap(os=>['amd64','arm64'].map(arch=>`tabshare-${os}-${arch}`))];

export async function selectRelease({github,context,core,requestedTag,version}) {
  const {owner,repo}=context.repo;
  const completed=context.eventName==='workflow_run'?context.payload.workflow_run:null;
  const mainBuild=completed?.head_branch==='main';
  const tag=mainBuild?`v${version}`:completed?completed.head_branch.replace(/^refs\/tags\//,''):requestedTag||`v${version}`;
  const skip=message=>{core.notice(message);core.setOutput('publish','false');};
  if(!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag)) {
    if(context.eventName==='workflow_dispatch')throw Error('Use a version tag such as v0.5.2');
    return skip('No version tag to publish');
  }
  let object,createTag=false;
  try{object=(await github.rest.git.getRef({owner,repo,ref:`tags/${tag}`})).data.object;}
  catch(error){if(error.status===404&&mainBuild){object={type:'commit',sha:completed.head_sha};createTag=true;}else if(error.status===404&&context.eventName==='push')return skip(`Tag ${tag} has not been built yet`);else throw error;}
  for(let i=0;object.type==='tag'&&i<8;i++)object=(await github.rest.git.getTag({owner,repo,tag_sha:object.sha})).data.object;
  if(object.type!=='commit')throw Error('Release tag must reference a commit');
  const commit=object.sha;
  let run;
  if(completed)run=(await github.rest.actions.getWorkflowRun({owner,repo,run_id:completed.id})).data;
  else {
    const runs=await github.paginate(github.rest.actions.listWorkflowRuns,{owner,repo,workflow_id:'tag-build.yml',head_sha:commit,status:'success',per_page:100});
    run=runs.find(r=>r.head_branch?.replace(/^refs\/tags\//,'')===tag&&['push','workflow_dispatch'].includes(r.event));
    if(!run&&context.eventName==='push')return skip(`No successful build for ${tag}; its next successful build will publish it`);
  }
  const workflow=(await github.rest.actions.getWorkflow({owner,repo,workflow_id:'tag-build.yml'})).data;
  if(!run||run.workflow_id!==workflow.id||run.status!=='completed'||run.conclusion!=='success'||run.head_sha!==commit||run.head_branch?.replace(/^refs\/tags\//,'')!==(mainBuild?'main':tag)||run.head_repository?.full_name!==`${owner}/${repo}`||!['push','workflow_dispatch'].includes(run.event))throw Error('Build provenance does not match the successful version-tag build');
  const artifacts=await github.paginate(github.rest.actions.listWorkflowRunArtifacts,{owner,repo,run_id:run.id,per_page:100});
  for(const name of artifactNames){const matches=artifacts.filter(a=>a.name===name);if(matches.length!==1||matches[0].expired)throw Error(`Missing or expired build artifact: ${name}; rebuild this tag first`);}
  if(createTag)await github.rest.git.createRef({owner,repo,ref:`refs/tags/${tag}`,sha:commit});
  core.setOutput('tag',tag);core.setOutput('commit',commit);core.setOutput('run-id',String(run.id));core.setOutput('prerelease',String(tag.includes('-')));core.setOutput('publish','true');
  core.info(`Publishing ${tag} from verified build ${run.id} at ${commit}`);
}
