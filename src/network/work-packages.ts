import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { assertNotSymlink, withFileLock } from '../atomic.js';
import { putWorkArtifact, getWorkArtifact, parseWorkArtifact, type WorkArtifact } from './work-artifacts.js';
import { withWorkPolicy, readWorkPolicy } from './work-policy.js';
import { workGit, selectedWorkPath, readSelectedFile, workBaseFile, makeWorkPatch, type PatchFile } from './work-git.js';
import { stableWorkValue } from './work-items.js';
import { sha256, validateNetworkId } from './types.js';
import { boundedWorkWrite, withWorkRetention } from './work-storage.js';

export interface ContextFile {
  path: string; baseDigest: string | null; headDigest: string | null;
  baseExecutable: boolean; executable: boolean; artifact: WorkArtifact | null;
}
export interface ContextPackage {
  version: 1; kind: 'agentlink-context'; repository: { name: string; baseCommit: string | null; branch: string | null };
  summary: string; decisions: string[]; nextAction: string; files: ContextFile[];
  subjectDigest: string; patch: WorkArtifact; checks: Array<{ id: string; passed: boolean; evidence: WorkArtifact }>;
  createdAt: string;
}
function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error('Invalid package ' + label);
  return value;
}
export function packageSubject(baseCommit: string | null, files: ContextFile[]): string {
  return sha256(stableWorkValue({ baseCommit, files: files.map(({ path, headDigest, executable }) => ({ path, headDigest, executable })).sort((a,b) => a.path < b.path ? -1 : 1) }));
}
export function parseContextPackage(value: unknown): ContextPackage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid context manifest');
  const p = value as ContextPackage;
  if (Object.keys(p).sort().join(',') !== 'checks,createdAt,decisions,files,kind,nextAction,patch,repository,subjectDigest,summary,version' || p.version !== 1 || p.kind !== 'agentlink-context'
    || !p.repository || Object.keys(p.repository).sort().join(',') !== 'baseCommit,branch,name'
    || p.repository.baseCommit !== null && !/^[a-f0-9]{40,64}$/.test(p.repository.baseCommit)
    || !Array.isArray(p.files) || !p.files.length || p.files.length > 60 || !Array.isArray(p.decisions) || p.decisions.length > 32 || !Array.isArray(p.checks) || p.checks.length > 32) throw new Error('Invalid context manifest fields');
  text(p.repository.name,'repository',256); if (p.repository.branch !== null) text(p.repository.branch,'branch',256);
  text(p.summary,'summary'); text(p.nextAction,'next action'); p.decisions.forEach(x=>text(x,'decision'));
  if (!Number.isFinite(Date.parse(p.createdAt))) throw new Error('Invalid context manifest timestamp');
  parseWorkArtifact(p.patch);
  for (const file of p.files) {
    if (Object.keys(file).sort().join(',') !== 'artifact,baseDigest,baseExecutable,executable,headDigest,path') throw new Error('Invalid context file fields');
    selectedWorkPath(file.path);
    for (const digest of [file.baseDigest,file.headDigest]) if (digest !== null && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid context file digest');
    if (typeof file.executable !== 'boolean' || typeof file.baseExecutable !== 'boolean' || file.baseDigest === null && file.headDigest === null
      || (file.artifact === null) !== (file.headDigest === null)) throw new Error('Invalid context file change');
    if (file.artifact && parseWorkArtifact(file.artifact).digest !== file.headDigest) throw new Error('Manifest file artifact digest mismatch');
  }
  const paths = p.files.map(file=>file.path);
  if (new Set(paths).size !== paths.length || paths.some(path=>paths.some(other=>other!==path && path.startsWith(other+'/')))) throw new Error('Overlapping context file paths');
  for (const check of p.checks) {
    if (Object.keys(check).sort().join(',') !== 'evidence,id,passed' || typeof check.passed !== 'boolean') throw new Error('Invalid package check evidence');
    validateNetworkId(check.id,'local check'); parseWorkArtifact(check.evidence);
  }
  if (new Set(p.checks.map(check=>check.id)).size !== p.checks.length) throw new Error('Duplicate package check ids');
  if (packageSubject(p.repository.baseCommit,p.files) !== p.subjectDigest) throw new Error('Context subject digest mismatch');
  return p;
}

export async function packageWorkContext(root: string, workspace: string, peerFingerprint: string, input: {
  policyId: string; requestId: string; paths?: string[]; summary: string; decisions: string[]; nextAction: string;
}): Promise<{ manifest: WorkArtifact; artifacts: WorkArtifact[]; context: ContextPackage }> {
  validateNetworkId(input.requestId,'package request'); validateNetworkId(input.policyId,'policy id');
  text(input.summary,'summary'); text(input.nextAction,'next action');
  if (!Array.isArray(input.decisions) || input.decisions.length>32) throw new Error('Invalid package decisions');
  input.decisions.forEach(value=>text(value,'decision'));
  if (input.paths && (!Array.isArray(input.paths) || !input.paths.length || input.paths.length>60)) throw new Error('Select 1–60 package paths');
  const hash=sha256(stableWorkValue(input)),receipt=join(root,'work-packages',input.requestId+'.json');
  return withFileLock(join(root,'locks'),'package-'+input.requestId,()=>withWorkRetention(root,async()=>{
    await assertNotSymlink(receipt,'Context package receipt');
    let previous;
    try { previous=JSON.parse(await readFile(receipt,'utf8')); }
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if (previous) {
      if (previous.hash!==hash) throw new Error('Conflicting context package request');
      const context=parseContextPackage(previous.context);
      for (const artifact of previous.artifacts) await getWorkArtifact(root,artifact);
      return {manifest:parseWorkArtifact(previous.manifest),artifacts:previous.artifacts as WorkArtifact[],context};
    }
    const policy=await readWorkPolicy(root,input.policyId);
    const allowed=(path:string)=>policy.paths.some(prefix=>path===prefix || path.startsWith(prefix+'/'));
    const requested=input.paths?.map(selectedWorkPath)??policy.paths;
    return withWorkPolicy(root,input.policyId,workspace,peerFingerprint,{paths:requested,permissions:['read'],checks:[]},async()=>{
      const deadline=Date.now()+30000;
      let commit:string|null=null,branch:string|null=null;
      try{commit=(await workGit(workspace,['rev-parse','--verify','HEAD^{commit}'])).toString().trim();}catch(error){if(![1,128].includes((error as {code:number}).code))throw error;}
      try{branch=(await workGit(workspace,['symbolic-ref','--short','HEAD'])).toString().trim();}catch(error){if((error as {code:number}).code!==1)throw error;}
      const candidates=input.paths?.map(selectedWorkPath)??[...new Set((await workGit(workspace,['ls-files','-z','--cached','--others','--exclude-standard','--',...policy.paths])).toString('utf8').split('\0').filter(Boolean))];
      if(candidates.length>512)throw new Error('Too many authorized candidate files; select narrower package paths');
      const files:ContextFile[]=[],patchFiles:PatchFile[]=[],artifacts:WorkArtifact[]=[];let total=0;
      for(const value of candidates.sort()) {
        if(Date.now()>deadline)throw new Error('Context packaging time budget reached; select fewer paths');
        const path=selectedWorkPath(value);if(!allowed(path))throw new Error('Context package exceeds locally authorized paths');
        const [before,after]=await Promise.all([workBaseFile(workspace,commit,path),readSelectedFile(workspace,path)]);
        if(!before && !after || before && after && before.bytes.equals(after.bytes) && before.executable===after.executable)continue;
        if(files.length>=60)throw new Error('Context package contains more than 60 changed files');
        total+=(after?.bytes.length??0)+(before?.bytes.length??0);if(total>4*1024*1024)throw new Error('Context package exceeds 4 MiB; select fewer paths');
        const artifact=after?await putWorkArtifact(root,after.bytes,'files/'+path):null;if(artifact)artifacts.push(artifact);
        files.push({path,baseDigest:before?sha256(before.bytes):null,headDigest:after?sha256(after.bytes):null,baseExecutable:before?.executable??false,executable:after?.executable??false,artifact});
        patchFiles.push({path,before,after});
      }
      if(!files.length)throw new Error('No selected changes to package');
      const patch=await putWorkArtifact(root,await makeWorkPatch(patchFiles),'context/changes.patch','text/plain');artifacts.push(patch);
      const subjectDigest=packageSubject(commit,files),checks:ContextPackage['checks']=[];
      let results:string[]=[];try{results=await readdir(join(root,'work-check-results'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      for(const name of results)if(name.endsWith('.json')) {
        const path=join(root,'work-check-results',name);await assertNotSymlink(path,'Recorded local check');
        if((await stat(path)).size>1024*1024)throw new Error('Recorded local check exceeds bound');
        const result=JSON.parse(await readFile(path,'utf8'));
        if(result.subjectDigest===subjectDigest)for(const check of result.checks as ContextPackage['checks']){await getWorkArtifact(root,check.evidence);checks.push(check);artifacts.push(check.evidence);}
      }
      const context=parseContextPackage({version:1,kind:'agentlink-context',repository:{name:basename(workspace),baseCommit:commit,branch},summary:input.summary,decisions:input.decisions,nextAction:input.nextAction,files,subjectDigest,patch,checks,createdAt:new Date().toISOString()});
      const manifest=await putWorkArtifact(root,Buffer.from(JSON.stringify(context)),'context/manifest.json','application/json');artifacts.push(manifest);
      if(artifacts.length>64)throw new Error('Context package artifact capacity exceeded');
      await boundedWorkWrite(root,receipt,JSON.stringify({hash,manifest,artifacts,context}));
      return {manifest,artifacts,context};
    });
  }));
}
