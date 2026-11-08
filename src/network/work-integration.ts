import { mkdir, readFile, readdir, realpath, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { assertNotSymlink, withFileLock } from '../atomic.js';
import { readWorkPolicy, withWorkPolicy } from './work-policy.js';
import { getWorkArtifact, putWorkArtifact, type WorkArtifact } from './work-artifacts.js';
import { parseContextPackage, packageSubject, type ContextFile } from './work-packages.js';
import { workGit, workBaseFile, readSelectedFile, makeWorkPatch, type PatchFile } from './work-git.js';
import { readLocalWorkCheck, runLocalWorkCheck, type WorkCheckResult } from './work-checks.js';
import { boundedWorkWrite } from './work-storage.js';
import { stableWorkValue } from './work-items.js';
import { sha256, validateNetworkId } from './types.js';

export interface IntegrationResult {
  version:1;id:string;requestHash:string;workId:string;workVersion:number;manifest:WorkArtifact;
  state:'preparing'|'checking'|'passed'|'failed'|'conflict'|'interrupted';
  targetHead:string;worktree:string;conflicts:string[];checks:WorkCheckResult[];
  patch?:WorkArtifact;report?:WorkArtifact;subjectDigest?:string;error?:string;
  packageManifest?:WorkArtifact;artifacts?:WorkArtifact[];
  releasedAt?:string;
}
export async function integrateWorkPackage(root:string,workspace:string,peerFingerprint:string,input:{
  id:string;requestId:string;workId:string;workVersion:number;manifest:WorkArtifact;policyId:string;checks:string[];
},assertClaim:()=>Promise<void>,signal?:AbortSignal):Promise<IntegrationResult> {
  validateNetworkId(input.id,'integration id');validateNetworkId(input.requestId,'integration request');validateNetworkId(input.workId,'work id');
  if(!Number.isSafeInteger(input.workVersion) || input.workVersion<1 || !Array.isArray(input.checks) || !input.checks.length || input.checks.length>8 || new Set(input.checks).size!==input.checks.length)throw new Error('Integration requires 1–8 distinct locally configured checks');
  input.checks.forEach(id=>validateNetworkId(id,'local check'));
  const manifest=parseContextPackage(JSON.parse((await getWorkArtifact(root,input.manifest)).toString('utf8')));
  const requestHash=sha256(stableWorkValue(input)),record=join(root,'work-integrations',input.id+'.json');
  return withFileLock(join(root,'locks'),'integrate-'+input.workId,async()=>{
    await assertNotSymlink(join(root,'work-integrations'),'Integration store');await assertNotSymlink(record,'Integration receipt');
    try {
      const previous=JSON.parse(await readFile(record,'utf8')) as IntegrationResult;
      if(previous.requestHash!==requestHash)throw new Error('Conflicting integration request; uncertain effects must not be replayed');
      return previous;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    let records:string[]=[];try{records=await readdir(join(root,'work-integrations'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    for(const name of records.filter(name=>name.endsWith('.json'))) {
      const path=join(root,'work-integrations',name);await assertNotSymlink(path,'Integration receipt');if((await stat(path)).size>1024*1024)throw new Error('Integration receipt exceeds bound');
      const previous=JSON.parse(await readFile(path,'utf8')) as IntegrationResult;
      if(previous.workId===input.workId && ['preparing','checking'].includes(previous.state))throw new Error('Previous integration is running or uncertain; reconcile it before starting another request');
    }
    await assertClaim();signal?.throwIfAborted();
    const paths=manifest.files.map(file=>file.path),requested={paths,permissions:['read','edit','test'] as ['read','edit','test'],checks:input.checks};
    const policy=await readWorkPolicy(root,input.policyId);
    if(policy.workspace!==await realpath(workspace))throw new Error('Integration policy belongs to another workspace');
    const definitions=await Promise.all(input.checks.map(id=>readLocalWorkCheck(root,id,workspace,peerFingerprint)));
    if(definitions.reduce((sum,check)=>sum+check.timeoutSeconds,0)>300)throw new Error('Integration check time budget exceeds five minutes');
    const repository=(await workGit(workspace,['rev-parse','--show-toplevel'])).toString().trim();
    const prefix=relative(await realpath(repository),await realpath(workspace));
    if(prefix==='..' || prefix.startsWith('..'+sep) || isAbsolute(prefix))throw new Error('Integration workspace escapes its repository');
    const targetHead=(await workGit(workspace,['rev-parse','--verify','HEAD^{commit}'])).toString().trim();
    const trees=join(root,'work-integrations','trees');await assertNotSymlink(trees,'Integration worktrees');await mkdir(trees,{recursive:true,mode:0o700});
    if((await readdir(trees)).length>=8)throw new Error('Integration worktree capacity reached; release a finished integration after retaining its evidence');
    const tree=join(trees,input.id);await assertNotSymlink(tree,'Integration worktree');
    const result:IntegrationResult={version:1,id:input.id,requestHash,workId:input.workId,workVersion:input.workVersion,manifest:input.manifest,state:'preparing',targetHead,worktree:tree,conflicts:[],checks:[]};
    const save=()=>boundedWorkWrite(root,record,JSON.stringify(result),true);
    await save(); // Durable intent precedes worktree creation and every check.
    try {
      await withWorkPolicy(root,input.policyId,workspace,peerFingerprint,requested,async()=>{
        await workGit(repository,['worktree','add','--detach','--no-checkout','--',tree,targetHead]);
        await workGit(tree,['reset','--hard',targetHead]);
        const staged=join(tree,prefix),before=new Map<string,Awaited<ReturnType<typeof readSelectedFile>>>();
        // Check every base before changing any selected file.
        for(const file of manifest.files) {
          const value=await readSelectedFile(staged,file.path);before.set(file.path,value);
          if((value?sha256(value.bytes):null)!==file.baseDigest || (value?.executable??false)!==file.baseExecutable)result.conflicts.push(file.path);
        }
        if(result.conflicts.length){result.state='conflict';await save();return;}
        for(const file of manifest.files) {
          await assertClaim();signal?.throwIfAborted();
          const path=join(staged,file.path);
          if(file.artifact) {
            const bytes=await getWorkArtifact(root,file.artifact);if(sha256(bytes)!==file.headDigest)throw new Error('Integration file digest mismatch');
            // Parents are verified by readSelectedFile above; new parents cannot be peer symlinks.
            await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);await chmod(path,file.executable?0o755:0o644);
          }else await rm(path);
        }
      });
      if(result.state==='conflict')return result;
      const staged=join(tree,prefix);result.state='checking';await save();
      const gitLink=await readFile(join(tree,'.git'),'utf8');
      const assertTree=async()=>{
        await assertNotSymlink(tree,'Integration worktree');await assertNotSymlink(join(tree,'.git'),'Integration Git link');
        if(await readFile(join(tree,'.git'),'utf8')!==gitLink
          || await realpath((await workGit(tree,['rev-parse','--show-toplevel'])).toString().trim())!==await realpath(tree)
          || await realpath(staged)!==join(await realpath(tree),prefix)
          || (await workGit(tree,['rev-parse','HEAD'])).toString().trim()!==targetHead)throw new Error('Check changed integration repository identity or HEAD; reconcile before continuing');
        for(const file of manifest.files) {
          const current=await readSelectedFile(staged,file.path);
          if((current?sha256(current.bytes):null)!==file.headDigest || (current?.executable??false)!==file.executable)throw new Error('Check changed selected integration bytes; retain the changes and verify a new package explicitly');
        }
      };
      for(const definition of definitions) {
        await assertClaim();await assertTree();signal?.throwIfAborted();
        const check=await withWorkPolicy(root,input.policyId,workspace,peerFingerprint,{paths,permissions:['read','test'],checks:[definition.id]},()=>runLocalWorkCheck(root,definition,staged,signal));
        result.checks.push(check);await save();
        await assertTree();
        if(!check.passed){result.state=check.aborted?'interrupted':'failed';break;}
      }
      await assertClaim();
      const patchFiles:PatchFile[]=[],files:ContextFile[]=[];
      for(const file of manifest.files) {
        const before=await readSelectedFile(join(tree,prefix),file.path);
        // The base is read from Git rather than the potentially dirty original workspace.
        const base=await workBaseFile(workspace,targetHead,file.path);
        patchFiles.push({path:file.path,before:base,after:before});
        files.push({...file,baseDigest:base?sha256(base.bytes):null,baseExecutable:base?.executable??false,headDigest:before?sha256(before.bytes):null,executable:before?.executable??false,artifact:before?await putWorkArtifact(root,before.bytes,'integrated/'+file.path):null});
      }
      const changes=(await workGit(tree,['diff','--name-only','--no-ext-diff','--no-textconv','-z','HEAD','--'])).toString('utf8').split('\0').filter(Boolean);
      const allowed=paths.map(path=>prefix?prefix.split(sep).join('/')+'/'+path:path);
      if(changes.some(path=>!allowed.includes(path)))throw new Error('Checks changed tracked files outside the selected integration package');
      result.patch=await putWorkArtifact(root,await makeWorkPatch(patchFiles),'integration/verified.patch','text/plain');
      result.subjectDigest=packageSubject(targetHead,files);
      if(result.state==='checking')result.state='passed';
      const evidence={version:1,workId:input.workId,workVersion:input.workVersion,targetHead,manifest:input.manifest,files,checks:result.checks,subjectDigest:result.subjectDigest,state:result.state};
      result.report=await putWorkArtifact(root,Buffer.from(JSON.stringify(evidence)),'integration/report.json','application/json');
      if(result.state==='passed') {
        const packaged=parseContextPackage({...manifest,repository:{...manifest.repository,baseCommit:targetHead},files,patch:result.patch,subjectDigest:result.subjectDigest,checks:result.checks.map(({id,passed,evidence})=>({id,passed,evidence})),createdAt:new Date().toISOString()});
        result.packageManifest=await putWorkArtifact(root,Buffer.from(JSON.stringify(packaged)),'integration/manifest.json','application/json');
        result.artifacts=[...files.flatMap(file=>file.artifact?[file.artifact]:[]),result.patch,...result.checks.map(check=>check.evidence),result.report,result.packageManifest];
      }
      await boundedWorkWrite(root,join(root,'work-check-results',result.subjectDigest.slice(7)+'.json'),JSON.stringify({subjectDigest:result.subjectDigest,checks:result.checks.map(({id,passed,evidence})=>({id,passed,evidence})),at:new Date().toISOString()}));
      await save();return result;
    }catch(error){result.state='interrupted';result.error=(error as Error).message.slice(0,512);await save();return result;}
  },{timeoutMs:1000});
}

export async function releaseWorkIntegration(root:string,workspace:string,id:string,expectedReport:string|null):Promise<IntegrationResult> {
  validateNetworkId(id,'integration id');const record=join(root,'work-integrations',id+'.json');
  await assertNotSymlink(record,'Integration receipt');if((await stat(record)).size>1024*1024)throw new Error('Integration receipt exceeds bound');
  const initial=JSON.parse(await readFile(record,'utf8')) as IntegrationResult;
  return withFileLock(join(root,'locks'),'integrate-'+validateNetworkId(initial.workId,'work id'),async()=>{
    const result=JSON.parse(await readFile(record,'utf8')) as IntegrationResult;
    if(result.id!==id || result.worktree!==join(root,'work-integrations','trees',id) || !['passed','failed','conflict'].includes(result.state))throw new Error('Only a settled known integration worktree can be released');
    if((result.report?.digest??null)!==expectedReport)throw new Error('Integration release must bind the exact retained report');
    if(result.releasedAt)return result;
    const repository=(await workGit(workspace,['rev-parse','--show-toplevel'])).toString().trim(),prefix=relative(await realpath(repository),await realpath(workspace));
    if(result.report) {
      const report=JSON.parse((await getWorkArtifact(root,result.report)).toString('utf8')) as {files:ContextFile[]};
      for(const file of report.files) {
        const current=await readSelectedFile(join(result.worktree,prefix),file.path);
        if((current?sha256(current.bytes):null)!==file.headDigest || (current?.executable??false)!==file.executable)throw new Error('Integration worktree changed since verification; retain new evidence before release');
      }
      const selected=report.files.map(file=>prefix?prefix.split(sep).join('/')+'/'+file.path:file.path);
      const untracked=(await workGit(result.worktree,['ls-files','--others','-z'])).toString('utf8').split('\0').filter(Boolean);
      const changed=(await workGit(result.worktree,['diff','--name-only','--no-ext-diff','--no-textconv','-z','HEAD','--'])).toString('utf8').split('\0').filter(Boolean);
      if([...untracked,...changed].some(path=>!selected.includes(path)))throw new Error('Integration has additional files or changes; preserve them before releasing this worktree');
    }
    await workGit(repository,['worktree','remove',...(result.report?['--force']:[]),'--',result.worktree]);
    result.releasedAt=new Date().toISOString();await boundedWorkWrite(root,record,JSON.stringify(result),true);return result;
  });
}
