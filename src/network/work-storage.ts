import { mkdir,readFile,readdir,stat,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile,assertNotSymlink,withFileLock } from '../atomic.js';
import { sha256 } from './types.js';

export const WORK_STORAGE_LIMITS={artifactBytes:256*1024*1024,metadataBytes:128*1024*1024,artifactFiles:16384,metadataFiles:262144,archiveItems:4096,pendingUploads:32,artifactRetentionMs:30*86400_000,snapshotRetentionMs:86400_000,incompleteUploadMs:86400_000};
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const temporary=(name:string)=>/^\.[a-f0-9-]{36}\.tmp$/.test(name);
async function entries(path:string) {await assertNotSymlink(path,'Work storage directory');try{return await readdir(path);}catch(error){if(!missing(error))throw error;return [];}}
async function details(path:string){await assertNotSymlink(path,'Work storage entry');return stat(path);}
export async function withWorkRetention<T>(root:string,fn:()=>Promise<T>):Promise<T> {return withFileLock(join(root,'locks'),'work-retention',fn);}
export async function withWorkArtifactBudget<T>(root:string,extraBytes:number,extraFiles:number,fn:()=>Promise<T>):Promise<T> {
  return withFileLock(join(root,'locks'),'work-artifact-budget',async()=>{
    const dir=join(root,'work-artifacts'),files=(await entries(dir)).filter(name=>name.endsWith('.json') || temporary(name));let total=0;
    for(const name of files)total+=(await details(join(dir,name))).size;
    if((extraBytes>0 || extraFiles>0) && (total+extraBytes>WORK_STORAGE_LIMITS.artifactBytes || files.length+extraFiles>WORK_STORAGE_LIMITS.artifactFiles))throw new Error('Work artifact storage budget reached; run work maintenance and retain active/replay evidence');
    return fn();
  });
}
export async function boundedWorkWrite(root:string,file:string,content:string,terminal=false):Promise<void> {
  await withFileLock(join(root,'locks'),'work-metadata-budget',async()=>{
    let bytes=0,count=0;
    const visit=async(path:string)=>{for(const name of await entries(path)){if(name==='locks' || name==='trees')continue;const full=join(path,name),s=await details(full);if(s.isDirectory())await visit(full);else if(name.endsWith('.json') || temporary(name)){bytes+=s.size;count++;}}};
    for(const name of ['work-items','work-client','work-inbox','work-policies','work-packages','work-integrations','work-checks','work-check-results','work-budgets'])await visit(join(root,name));
    let previous=0,present=false;try{previous=(await details(file)).size;present=true;}catch(error){if(!missing(error))throw error;}
    if(bytes-previous+Buffer.byteLength(content)>WORK_STORAGE_LIMITS.metadataBytes-(terminal?0:2*1024*1024) || count+(present?0:1)>WORK_STORAGE_LIMITS.metadataFiles)throw new Error('Work metadata budget reached; replay receipts are retained, not silently evicted');
    await atomicWriteFile(file,content);
  });
}
async function json(path:string){if((await details(path)).size>2*1024*1024)throw new Error('Work retention record exceeds bound');return JSON.parse(await readFile(path,'utf8'));}

/** Preserve active references and replay metadata; collect only expired exported bytes and old snapshots. */
export async function maintainWorkStorage(root:string,options:{force?:boolean;now?:number}={}) {
  const now=options.now??Date.now(),stamp=join(root,'work-maintenance.json');
  return withWorkRetention(root,async()=>{
    try{const last=await json(stamp);if(!options.force && typeof last.at==='number' && now-last.at<3600_000)return {...last,skipped:true};}catch(error){if(!missing(error))throw error;}
    let removedUploads=0,removedArtifacts=0,removedTemporaries=0,reclaimedBytes=0;const blobDir=join(root,'work-artifacts'),incoming=join(blobDir,'incoming');
    const cleanTemporary=async(path:string)=>{for(const name of await entries(path)){if(name==='locks' || name==='incoming')continue;const full=join(path,name),s=await details(full);if(s.isDirectory())await cleanTemporary(full);else if(temporary(name) && now-s.mtimeMs>WORK_STORAGE_LIMITS.incompleteUploadMs){await rm(full);removedTemporaries++;reclaimedBytes+=s.size;}}};
    for(const dir of ['work-items','work-client','work-inbox','work-policies','work-artifacts'])await cleanTemporary(join(root,dir));
    for(const digest of await entries(incoming)) {
      if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('Unexpected work upload entry');
      const path=join(incoming,digest);
      if(now-(await details(path)).mtimeMs>WORK_STORAGE_LIMITS.incompleteUploadMs)await withFileLock(join(blobDir,'locks'),'upload-'+digest,async()=>{
        try{if(now-(await details(path)).mtimeMs>WORK_STORAGE_LIMITS.incompleteUploadMs){await rm(path,{recursive:true});removedUploads++;}}catch(error){if(!missing(error))throw error;}
      });
    }
    const keep=new Set<string>();
    const collect=(value:unknown):void=>{
      if(!value || typeof value!=='object')return;
      const row=value as Record<string,unknown>;
      if(typeof row.digest==='string' && /^sha256:[a-f0-9]{64}$/.test(row.digest) && Number.isSafeInteger(row.bytes))keep.add(row.digest);
      for(const nested of Object.values(row))if(nested && typeof nested==='object')collect(nested);
    };
    for(const category of ['active','archive'])for(const name of await entries(join(root,'work-items',category))) {
      if(!name.endsWith('.json'))continue;
      const path=join(root,'work-items',category,name),item=await json(path);
      const age=now-Date.parse(item.updatedAt);
      if(!Number.isFinite(age))throw new Error('Invalid work retention timestamp');
      if(category==='active' || age<=WORK_STORAGE_LIMITS.artifactRetentionMs){collect(item);keep.add(sha256(JSON.stringify(item)));}
    }
    for(const name of await entries(join(root,'work-client','cache'))) {
      if(!name.endsWith('.json'))continue;
      const record=await json(join(root,'work-client','cache',name)),item=record.item;
      if(!item || !Array.isArray(item.events))throw new Error('Invalid retained work cache');
      if(!['done','declined','cancelled'].includes(item.state) || now-Date.parse(record.observedAt)<=WORK_STORAGE_LIMITS.artifactRetentionMs)collect(item);
    }
    for(const name of await entries(join(root,'work-integrations')))if(name.endsWith('.json')) {
      const record=await json(join(root,'work-integrations',name));
      if(!record.releasedAt || now-Date.parse(record.releasedAt)<=WORK_STORAGE_LIMITS.artifactRetentionMs)collect(record);
    }
    // Older client versions duplicated full snapshots in every receipt. Keep compact replay metadata instead.
    for(const name of await entries(join(root,'work-client','requests'))) {
      if(!name.endsWith('.json'))continue;const path=join(root,'work-client','requests',name),record=await json(path);
      if(record.status==='received' && record.item){const event=record.item.events?.find((event:{requestId:string})=>event.requestId===record.requestId);if(!event)throw new Error('Stored work receipt has no corresponding event');const {item,...rest}=record;await boundedWorkWrite(root,path,JSON.stringify({...rest,receiptHash:event.hash,version:item.version}));}
    }
    await withWorkArtifactBudget(root,0,0,async()=>{
      for(const name of await entries(blobDir)) {
        if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const digest='sha256:'+name.slice(0,-5);if(keep.has(digest))continue;
        const path=join(blobDir,name),s=await details(path),record=await json(path);
        const ttl=typeof record.name==='string' && record.name.startsWith('work-state/')?WORK_STORAGE_LIMITS.snapshotRetentionMs:WORK_STORAGE_LIMITS.artifactRetentionMs;
        if(now-s.mtimeMs>ttl){await rm(path);removedArtifacts++;reclaimedBytes+=s.size;}
      }
    });
    const result={at:now,removedUploads,removedArtifacts,removedTemporaries,reclaimedBytes,activeReferences:keep.size,replayMetadataRetained:true};
    await atomicWriteFile(stamp,JSON.stringify(result));return result;
  });
}

export async function allocateWorkUpload(root:string,staging:string):Promise<void> {
  await withFileLock(join(root,'locks'),'work-upload-budget',async()=>{
    try{await details(staging);return;}catch(error){if(!missing(error))throw error;}
    if((await entries(join(root,'work-artifacts','incoming'))).length>=WORK_STORAGE_LIMITS.pendingUploads)throw new Error('Pending work artifact capacity reached');
    await mkdir(staging,{mode:0o700});
  });
}
