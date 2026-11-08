import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { connectAction, readConnection } from './connect.js';
import { connectionWorkAction } from './work-client.js';
import { exportPublicIdentity } from './identity.js';
import { writeWorkPolicy } from './work-policy.js';
import type { WorkItem } from './work-items.js';

test('connection work client verifies chunked artifacts, receipts, offline recipient ownership, cache and uncertain reconciliation', async t => {
  const base = await mkdtemp(join(tmpdir(), 'agentlink-work-client-')), repos = [join(base,'sender'),join(base,'recipient')];
  await Promise.all(repos.map(path => mkdir(path)));
  const previousHome = process.env.AGENTLINK_CONNECTION_HOME, previousActor = process.env.AGENTLINK_PARTICIPANT_ID;
  process.env.AGENTLINK_CONNECTION_HOME = join(base, 'private'); delete process.env.AGENTLINK_PARTICIPANT_ID;
  let id: string | undefined;
  t.after(async () => {
    if (id) for (const workspace of repos) await connectAction(workspace,{action:'stop',connection:id}).catch(()=>{});
    await pause(500);
    if (previousHome === undefined) delete process.env.AGENTLINK_CONNECTION_HOME; else process.env.AGENTLINK_CONNECTION_HOME = previousHome;
    if (previousActor === undefined) delete process.env.AGENTLINK_PARTICIPANT_ID; else process.env.AGENTLINK_PARTICIPANT_ID = previousActor;
    await rm(base,{recursive:true,force:true});
  });
  const invitation = await connectAction(repos[0]!,{action:'invite',to:'teammate',ip:'127.0.0.1'}); id=invitation.id as string;
  await connectAction(repos[1]!,{action:'accept',code:invitation.code});
  const [sender, recipient] = await Promise.all(repos.map(repo=>readConnection(repo,id!)));
  const source = await exportPublicIdentity(sender!.root), target = await exportPublicIdentity(recipient!.root);
  const invoke = (host:number,args:Record<string,unknown>,session='session-'+host) => connectionWorkAction(repos[host]!,{connection:id,...args},session);
  const content = 'dirty patch with implementation rationale\n'.repeat(2500);
  const ref = (await invoke(0,{action:'artifact-create',name:'changes.patch',content,mediaType:'text/plain'})).artifact;
  const scope = {paths:['src'],permissions:['read','edit','test'] as const,checks:['unit']};
  const draft = {id:'handoff-client',kind:'handoff',title:'Finish the change',goal:'Continue independently',criteria:['Tests pass'],scope,reviewRequired:false,dependencies:[],context:{summary:'Context and evidence',nextAction:'Inspect the selected patch',artifacts:[ref]}};
  await assert.rejects(invoke(0,{action:'create',requestId:'spoof',work:{...draft,owner:{nodeId:target.nodeId}}}),/derived/);
  const created = await invoke(0,{action:'create',work:draft,requestId:'create-client'});
  assert.equal((created.item as WorkItem).state,'queued');
  const listed=await invoke(0,{action:'list',location:'peer',includeArchived:false,offset:0});
  assert.deepEqual((listed.items as Array<{id:string}>).map(item=>item.id),[draft.id]);
  assert.equal((await invoke(0,{action:'create',work:draft,requestId:'create-client'})).source,'receipt');
  await assert.rejects(invoke(0,{action:'create',work:{...draft,title:'conflicting'},requestId:'create-client'}),/Conflicting/);
  assert.equal((await invoke(1,{action:'get',location:'local',id:draft.id})).source,'local-authority');
  await assert.rejects(invoke(0,{action:'get',location:'local',id:draft.id}),/Unknown/);
  const part = await invoke(1,{action:'artifact',location:'local',id:draft.id,artifact:ref,offset:0});
  assert.equal(Buffer.from(part.data as string,'base64').toString(),content.slice(0,32768));
  await writeWorkPolicy(recipient!.root,{version:1,id:'team',workspace:repos[1]!,peerFingerprint:source.fingerprint,expiresAt:new Date(Date.now()+60000).toISOString(),revoked:false,paths:['src'],permissions:['read','edit','test'],checks:['unit']});
  const local = async(type:string,extra:Record<string,unknown>={},session?:string)=>{
    const item=(await invoke(1,{action:'get',location:'local',id:draft.id})).item as WorkItem;
    return (await invoke(1,{action:'operate',location:'local',id:draft.id,policyId:'team',operation:{type,requestId:type+'-'+item.version,expectedVersion:item.version,...extra}},session)).item as WorkItem;
  };
  await local('accept'); const claimed=await local('claim',{leaseSeconds:60});
  await assert.rejects(local('progress',{leaseToken:claimed.claim!.token,summary:'Wrong live session'},'other-session'),/Matching live/);
  const testRef=(await invoke(1,{action:'artifact-create',name:'tests.txt',content:'actual captured unit output',mediaType:'text/plain'})).artifact;
  await connectAction(repos[0]!,{action:'stop',connection:id}); await pause(500);
  await local('submit',{leaseToken:claimed.claim!.token,artifacts:[ref],testArtifact:testRef,summary:'Completed with sender listener stopped'});
  await local('complete',{summary:'Finished'});
  // Recipient still serves the completed work, including actual output bytes.
  // Its sender-side record is stopped: reads must explicitly use the local cache.
  await assert.rejects(invoke(0,{action:'get',location:'peer',id:draft.id}),/stopped/);
  const cached=await invoke(0,{action:'get',location:'cache',id:draft.id});
  assert.equal(cached.stale,true); assert.equal((cached.item as WorkItem).state,'queued');
  // Simulate response loss after a peer accepted a request, then reconcile by reading.
  const metadata=join(sender!.root,'connection.json'); const stopped=JSON.parse(await readFile(metadata,'utf8'));
  await writeFile(metadata,JSON.stringify({...stopped,status:'connected'}));
  await assert.rejects(invoke(0,{action:'get',location:'peer',id:draft.id}),/stopped/);
  await rm(join(sender!.root,'stop'));
  const requestFile=join(sender!.root,'work-client','requests','create-client.json');
  const receipt=JSON.parse(await readFile(requestFile,'utf8'));
  const createEvent=(created.item as WorkItem).events[0]!;
  await writeFile(requestFile,JSON.stringify({...receipt,status:'uncertain',receiptHash:createEvent.hash}));
  await assert.rejects(invoke(0,{action:'create',work:draft,requestId:'create-client'}),/uncertain/);
  const reconciled=await invoke(0,{action:'reconcile',requestId:'create-client'});
  assert.equal(reconciled.status,'received'); assert.equal((reconciled.item as WorkItem).state,'done');
  const downloaded=await invoke(0,{action:'artifact',location:'peer',id:draft.id,artifact:testRef,offset:0});
  assert.equal(Buffer.from(downloaded.data as string,'base64').toString(),'actual captured unit output');
  // Downgrading the local cache is detected on its next authenticated fetch.
  const cachePath=join(sender!.root,'work-client','cache',draft.id+'.json');
  const row=JSON.parse(await readFile(cachePath,'utf8')); row.item.events[0].summary='tampered history';
  await writeFile(cachePath,JSON.stringify(row));
  await assert.rejects(invoke(0,{action:'get',location:'peer',id:draft.id}),/rollback or conflict/);
});
