import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { connectAction, readConnection } from './connect.js';
import { authenticatedRequest } from './a2a.js';
import { exportPublicIdentity } from './identity.js';
import { getWorkArtifact, getWorkArtifactPart, putWorkArtifact, WORK_ARTIFACT_PART_BYTES } from './work-artifacts.js';
import { operateWorkItem, readWorkItem, type NewWork, type WorkContext } from './work-items.js';
import { writeWorkPolicy } from './work-policy.js';
import { revokeGrant } from './trust.js';
import { sha256 } from './types.js';

test('one-code mTLS transfers real artifacts and hosts recipient-owned work that survives sender listener shutdown', async t => {
  const base = await mkdtemp(join(tmpdir(), 'agentlink-work-wire-')), repos = [join(base,'sender'),join(base,'recipient')];
  await Promise.all(repos.map(path => mkdir(path)));
  const previousHome = process.env.AGENTLINK_CONNECTION_HOME, previousActor = process.env.AGENTLINK_PARTICIPANT_ID;
  process.env.AGENTLINK_CONNECTION_HOME = join(base, 'private'); delete process.env.AGENTLINK_PARTICIPANT_ID;
  let id: string | undefined;
  t.after(async () => {
    if (id) for (const workspace of repos) await connectAction(workspace,{ action:'stop',connection:id }).catch(()=>{});
    await pause(500);
    if (previousHome === undefined) delete process.env.AGENTLINK_CONNECTION_HOME; else process.env.AGENTLINK_CONNECTION_HOME = previousHome;
    if (previousActor === undefined) delete process.env.AGENTLINK_PARTICIPANT_ID; else process.env.AGENTLINK_PARTICIPANT_ID = previousActor;
    await rm(base,{recursive:true,force:true});
  });
  const invitation = await connectAction(repos[0]!,{action:'invite',to:'teammate',ip:'127.0.0.1'}); id=invitation.id as string;
  await connectAction(repos[1]!,{action:'accept',code:invitation.code});
  const [sender, recipient] = await Promise.all(repos.map(repo=>readConnection(repo,id!)));
  const [senderIdentity, recipientIdentity] = await Promise.all([exportPublicIdentity(sender!.root),exportPublicIdentity(recipient!.root)]);
  const source = {nodeId:senderIdentity.nodeId,actorId:sender!.actor,fingerprint:senderIdentity.fingerprint};
  const target = {nodeId:recipientIdentity.nodeId,actorId:recipient!.actor,fingerprint:recipientIdentity.fingerprint};
  const wire = async (request: Record<string,unknown>) => {
    const input={senderActor:sender!.actor,recipientActor:recipient!.actor,connection:id,request};
    const response=await authenticatedRequest(sender!.root,recipient!.address!+'/v1/work',recipientIdentity,'POST',input) as {requestHash:string;result:Record<string,unknown>};
    assert.equal(response.requestHash,sha256(JSON.stringify(input))); return response.result;
  };
  const bytes=Buffer.from('versioned dirty change\n'.repeat(4000));
  const ref=await putWorkArtifact(sender!.root,bytes,'selected.patch','text/plain');
  const first=await getWorkArtifactPart(sender!.root,ref,0);
  assert.equal((await wire({action:'artifact-put',artifact:ref,offset:0,data:first.data})).complete,false);
  await assert.rejects(wire({action:'artifact-put',artifact:ref,offset:0,data:Buffer.alloc(WORK_ARTIFACT_PART_BYTES).toString('base64')}),/Conflicting/);
  for(let offset=WORK_ARTIFACT_PART_BYTES;offset<bytes.length;offset+=WORK_ARTIFACT_PART_BYTES) {
    const part=await getWorkArtifactPart(sender!.root,ref,offset); await wire({action:'artifact-put',artifact:ref,offset,data:part.data});
  }
  assert.deepEqual(await getWorkArtifact(recipient!.root,ref),bytes);
  const draft:NewWork={id:'handoff-over-wire',kind:'handoff',title:'Continue this dirty change',goal:'Finish independently',criteria:['Tests pass'],origin:source,owner:target,
    scope:{paths:['src'],permissions:['read','edit','test'],checks:['unit']},reviewRequired:false,dependencies:[],context:{summary:'Work and rationale',nextAction:'Inspect diff and finish',artifacts:[ref]}};
  const created=await wire({action:'create',work:draft,requestId:'create-handoff'});
  const snapshotRef=created.snapshot;
  const snapshot=await wire({action:'artifact-get',id:draft.id,artifact:snapshotRef,offset:0});
  assert.equal(JSON.parse(Buffer.from(snapshot.data as string,'base64').toString()).id,draft.id);
  assert.equal((await wire({action:'create',work:draft,requestId:'create-handoff'})).snapshot!==undefined,true);
  await assert.rejects(wire({action:'create',work:{...draft,id:'spoofed',owner:{...target,actorId:'wrong-recipient'}},requestId:'spoof'}),/participants/);
  const unrelated=await putWorkArtifact(recipient!.root,Buffer.from('unexported local bytes'),'not-exported.txt');
  await assert.rejects(wire({action:'artifact-get',id:draft.id,artifact:unrelated,offset:0}),/not exported/);
  const owner:WorkContext={actor:target,local:true,workspace:repos[1]!,sessionId:'recipient-session',policyId:'local-team'};
  const op=async(type:string,extra:Record<string,unknown>={})=>{
    const current=await readWorkItem(recipient!.root,draft.id,target);
    return operateWorkItem(recipient!.root,draft.id,owner,{type,requestId:type+'-'+current.version,expectedVersion:current.version,...extra});
  };
  await writeWorkPolicy(recipient!.root,{version:1,id:'local-team',workspace:repos[1]!,peerFingerprint:source.fingerprint,expiresAt:new Date(Date.now()+60000).toISOString(),revoked:false,...draft.scope});
  await op('accept');
  await connectAction(repos[0]!,{action:'stop',connection:id}); await pause(500);
  await assert.rejects(authenticatedRequest(recipient!.root,sender!.address!+'/v1/work',senderIdentity,'POST',{}));
  const claimed=await op('claim',{leaseSeconds:60});
  const tests=await putWorkArtifact(recipient!.root,Buffer.from('captured local test output'),'tests.txt','text/plain');
  await op('submit',{leaseToken:claimed.claim!.token,artifacts:[ref],testArtifact:tests,summary:'Continued without contacting sender'});
  assert.equal((await op('complete',{summary:'Finished under standing local policy'})).state,'done');
  await revokeGrant(recipient!.root,'connection');
  await assert.rejects(wire({action:'list',offset:0,includeArchived:true}),/rejected/);
});
