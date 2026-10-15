import {createHash} from 'node:crypto';
import {readdir,readFile,lstat,mkdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {artifactNames} from './select-release.mjs';

export async function prepareRelease(input,output) {
  const directories=await readdir(input);
  if(directories.length!==artifactNames.length||artifactNames.some(name=>!directories.includes(name)))throw Error('Expected exactly seven platform/extension artifacts');
  await mkdir(output,{recursive:true});
  if((await readdir(output)).length)throw Error('Release output directory must be empty');
  const sums=[];
  // Validate the entire build before preparing any upload files.
  for(const artifact of artifactNames) {
    const file=artifact==='tabshare-extension'?artifact+'.zip':artifact+(artifact.startsWith('tabshare-windows-')?'.zip':'.tar.gz');
    const directory=path.join(input,artifact),entries=await readdir(directory);
    if(entries.length!==2||!entries.includes(file)||!entries.includes('SHA256SUMS.txt'))throw Error(`Unexpected contents in ${artifact}`);
    for(const name of entries)if(!(await lstat(path.join(directory,name))).isFile())throw Error(`Non-file artifact entry in ${artifact}`);
    const checksum=(await readFile(path.join(directory,'SHA256SUMS.txt'),'utf8')).trim();
    const match=/^([a-f0-9]{64}) [ *]([^\r\n]+)$/.exec(checksum);
    if(!match||match[2]!==file)throw Error(`Invalid checksum manifest for ${artifact}`);
    const bytes=await readFile(path.join(directory,file));
    if(createHash('sha256').update(bytes).digest('hex')!==match[1])throw Error(`Checksum mismatch: ${file}`);
    sums.push({file,checksum:match[1],source:path.join(directory,file)});
  }
  for(const item of sums)await copyFile(item.source,path.join(output,item.file));
  await writeFile(path.join(output,'SHA256SUMS.txt'),sums.map(({checksum,file})=>`${checksum}  ${file}\n`).join(''));
  return sums.map(({file})=>file);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const files=await prepareRelease(process.argv[2]||'downloads',process.argv[3]||'release-files');
  console.log(`Verified ${files.length} packages; prepared SHA256SUMS.txt`);
}
