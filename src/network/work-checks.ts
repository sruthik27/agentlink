import { spawn } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertNotSymlink, withFileLock } from '../atomic.js';
import { boundedWorkWrite } from './work-storage.js';
import { sha256, validateNetworkId } from './types.js';
import { stableWorkValue } from './work-items.js';
import { putWorkArtifact, type WorkArtifact } from './work-artifacts.js';

export interface LocalWorkCheck {
  version: 1; id: string; workspace: string; peerFingerprint: string;
  command: string; args: string[]; timeoutSeconds: number;
}
function validate(input: LocalWorkCheck) {
  if (Object.keys(input).sort().join(',') !== 'args,command,id,peerFingerprint,timeoutSeconds,version,workspace' || input.version !== 1
    || !isAbsolute(input.workspace) || !isAbsolute(input.command) || !/^sha256:[a-f0-9]{64}$/.test(input.peerFingerprint)
    || !Array.isArray(input.args) || input.args.length > 64 || input.args.some(value=>typeof value!=='string' || Buffer.byteLength(value)>4096 || value.includes('\0'))
    || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds<1 || input.timeoutSeconds>120) throw new Error('Invalid local check definition (timeout 1–120 seconds)');
  validateNetworkId(input.id,'local check id');
}
export async function writeLocalWorkCheck(root: string,input: LocalWorkCheck):Promise<void> {
  validate(input); const definition={...input,workspace:await realpath(input.workspace),command:await realpath(input.command)};
  await access(definition.command,constants.X_OK); if(!(await stat(definition.command)).isFile())throw new Error('Local check command must be an executable file');
  await withFileLock(join(root,'locks'),'check-'+input.id,()=>boundedWorkWrite(root,join(root,'work-checks',input.id+'.json'),JSON.stringify(definition)));
}
export async function readLocalWorkCheck(root:string,id:string,workspace:string,peerFingerprint:string):Promise<LocalWorkCheck> {
  const path=join(root,'work-checks',validateNetworkId(id,'local check id')+'.json');await assertNotSymlink(join(root,'work-checks'),'Local checks');await assertNotSymlink(path,'Local check');
  if((await stat(path)).size>512*1024)throw new Error('Local check definition exceeds bound');
  const check=JSON.parse(await readFile(path,'utf8')) as LocalWorkCheck;validate(check);
  if(check.id!==id || check.workspace!==await realpath(workspace) || check.peerFingerprint!==peerFingerprint)throw new Error('Local check belongs to another workspace or peer');
  return check;
}
export interface WorkCheckResult { id:string;passed:boolean;evidence:WorkArtifact;definitionDigest:string;exitCode:number|null;timedOut:boolean;aborted:boolean; }

/** Only locally registered argv executes. No shell and no command supplied by peer data. */
export async function runLocalWorkCheck(root:string,check:LocalWorkCheck,cwd:string,signal?:AbortSignal):Promise<WorkCheckResult> {
  validate(check);signal?.throwIfAborted();
  const env:NodeJS.ProcessEnv={};for(const name of ['PATH','LANG','LC_ALL','TZ','TMPDIR','SYSTEMROOT','SystemRoot'])if(process.env[name])env[name]=process.env[name];
  const result=await new Promise<{exitCode:number|null;timedOut:boolean;aborted:boolean;truncated:boolean;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(check.command,check.args,{cwd,env,detached:true,shell:false,stdio:['ignore','pipe','pipe']});
    let timedOut=false,aborted=false,truncated=false,bytes=0,killing=false;const out:Buffer[]=[],err:Buffer[]=[];
    let force:NodeJS.Timeout|undefined;
    const kill=()=>{if(killing)return;killing=true;try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch{/* Child already gone. */}force=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},1000);force.unref();};
    const collect=(chunks:Buffer[])=> (chunk:Buffer)=>{const remaining=Math.max(0,256*1024-bytes);if(chunk.length>remaining){truncated=true;kill();}chunks.push(chunk.subarray(0,remaining));bytes+=Math.min(chunk.length,remaining);};
    child.stdout.on('data',collect(out));child.stderr.on('data',collect(err));
    const timer=setTimeout(()=>{timedOut=true;kill();},check.timeoutSeconds*1000);
    const abort=()=>{aborted=true;kill();};signal?.addEventListener('abort',abort,{once:true});
    const cleanup=()=>{clearTimeout(timer);if(force)clearTimeout(force);signal?.removeEventListener('abort',abort);};
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',exitCode=>{cleanup();resolve({exitCode,timedOut,aborted,truncated,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8')});});
  });
  const definitionDigest=sha256(stableWorkValue(check)),passed=result.exitCode===0 && !result.timedOut && !result.aborted && !result.truncated;
  const evidence=await putWorkArtifact(root,Buffer.from(JSON.stringify({version:1,check:check.id,definitionDigest,passed,...result})),`checks/${check.id}.json`,'application/json');
  return {id:check.id,passed,evidence,definitionDigest,exitCode:result.exitCode,timedOut:result.timedOut,aborted:result.aborted};
}
