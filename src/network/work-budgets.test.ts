import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkItem,operateWorkItem,authorizeWorkBudget,readWorkItem,type NewWork } from './work-items.js';
import { putWorkArtifact } from './work-artifacts.js';
import { writeWorkPolicy } from './work-policy.js';
import { parseWorkBudget } from './work-budgets.js';
const origin={nodeId:'a',actorId:'author',fingerprint:'sha256:'+'a'.repeat(64)},owner={nodeId:'b',actorId:'reviewer',fingerprint:'sha256:'+'b'.repeat(64)};
test('authoritative review budgets pause repeated disagreement, notify once and require local owner authorization to continue',async t=>{
  const root=await mkdtemp(join(tmpdir(),'work-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));const workspace=join(root,'repo');await mkdir(workspace);
  const ref=await putWorkArtifact(root,Buffer.from('selected source'),'source.txt'),evidence=await putWorkArtifact(root,Buffer.from('review evidence'),'review.txt');
  const draft:NewWork={id:'review',kind:'review',title:'Review boundary behavior',goal:'Resolve findings',criteria:['Independent review'],origin,owner,scope:{paths:['src'],permissions:['read'],checks:[]},reviewRequired:true,dependencies:[],context:{summary:'Context',nextAction:'Review',artifacts:[ref]},limits:{maxReviewRounds:3,maxRepeatedFindings:2,maxElapsedSeconds:3600}};
  const author={actor:origin,local:false,sessionId:'a',workspace},reviewer={actor:owner,local:true,sessionId:'b',workspace};let serial=0;
  const op=async(ctx:typeof author,type:string,extra:Record<string,unknown>={})=>{const item=await readWorkItem(root,draft.id,ctx.actor);return operateWorkItem(root,draft.id,ctx,{type,requestId:'op-'+(++serial),expectedVersion:item.version,...extra});};
  await createWorkItem(root,draft,author,'create');await op(reviewer,'accept');
  let item=await readWorkItem(root,draft.id,origin);
  for(let round=0;round<2;round++) {
    item=await op(reviewer,'review',{revision:item.outputRevision,digest:item.outputDigest,accepted:false,findings:[{id:'boundary',content:'Still missing boundary check',status:'open'}],evidence,leaseToken:null});
    if(round===0)item=await op(author,'revise',{artifacts:[ref],testArtifact:evidence,summary:'First repair'});
  }
  assert.match(item.budget!.escalation!.reason,/finding boundary/);const escalationId=item.budget!.escalation!.id,revision=item.outputRevision;
  const blocked=await op(author,'revise',{artifacts:[ref],testArtifact:evidence,summary:'Another automatic round'});
  assert.equal(blocked.outputRevision,revision);assert.equal(blocked.events.at(-1)!.type,'budget-exceeded');assert.equal(blocked.budget!.escalation!.id,escalationId);
  await assert.rejects(op(author,'budget-notice',{escalationId}),/local work owner/);
  item=await op(reviewer,'budget-notice',{escalationId});const notifiedAt=item.budget!.escalation!.notifiedAt;
  assert.ok(notifiedAt);assert.equal((await op(reviewer,'budget-notice',{escalationId})).budget!.escalation!.notifiedAt,notifiedAt);
  const authorization={requestId:'owner-continue',limits:{maxReviewRounds:4,maxRepeatedFindings:4,maxElapsedSeconds:3600},deadline:new Date(Date.now()+3600000).toISOString()};
  await assert.rejects(authorizeWorkBudget(root,draft.id,origin,authorization),/local recipient owner/);
  item=await authorizeWorkBudget(root,draft.id,owner,authorization);assert.equal(item.budget!.escalation,undefined);
  assert.equal((await authorizeWorkBudget(root,draft.id,owner,authorization)).version,item.version);
  await assert.rejects(authorizeWorkBudget(root,draft.id,owner,{...authorization,limits:{...authorization.limits,maxReviewRounds:5}}),/Conflicting/);
  item=await op(author,'revise',{artifacts:[ref],testArtifact:evidence,summary:'Owner-authorized repair'});
  item=await op(reviewer,'review',{revision:item.outputRevision,digest:item.outputDigest,accepted:true,findings:[{id:'boundary',content:'Verified fixed',status:'resolved'}],evidence,leaseToken:null});
  assert.equal((await op(reviewer,'complete',{summary:'Verified result'})).state,'done');
});

test('elapsed and round budgets preserve safe cancellation and do not allow peer-proposed larger limits',async t=>{
  const root=await mkdtemp(join(tmpdir(),'work-budget-elapsed-'));t.after(()=>rm(root,{recursive:true,force:true}));const workspace=join(root,'repo');await mkdir(workspace);
  await writeWorkPolicy(root,{version:1,id:'local',workspace,peerFingerprint:origin.fingerprint,paths:['src'],permissions:['read'],checks:[],revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString()});
  const draft:NewWork={id:'handoff',kind:'handoff',title:'Timed handoff',goal:'Finish',criteria:['done'],origin,owner,scope:{paths:['src'],permissions:['read'],checks:[]},reviewRequired:false,dependencies:[],context:{summary:'Context',nextAction:'Inspect',artifacts:[]},limits:{maxReviewRounds:1,maxRepeatedFindings:1,maxElapsedSeconds:60}};
  const author={actor:origin,local:false,sessionId:'a',workspace},recipient={actor:owner,local:true,sessionId:'b',workspace,policyId:'local'};
  let item=await createWorkItem(root,draft,author,'create');await operateWorkItem(root,draft.id,recipient,{type:'accept',requestId:'accept',expectedVersion:1});
  t.mock.method(Date,'now',()=>Date.parse(item.budget!.deadline)+1);
  item=await operateWorkItem(root,draft.id,recipient,{type:'claim',requestId:'expired-claim',expectedVersion:2,leaseSeconds:60});
  assert.equal(item.claim,undefined);assert.match(item.budget!.escalation!.reason,/time budget/);
  item=await operateWorkItem(root,draft.id,author,{type:'cancel',requestId:'cancel',expectedVersion:item.version,summary:'Stop this work'});
  assert.equal((await operateWorkItem(root,draft.id,recipient,{type:'cancelled',requestId:'confirm',expectedVersion:item.version,leaseToken:null,summary:'Stopped safely'})).state,'cancelled');
  await assert.rejects(createWorkItem(root,{...draft,id:'too-large',limits:{...draft.limits!,maxReviewRounds:99}},author,'larger'),/local defaults/);
});

test('distinct review findings still stop at the total round limit across retained state',async t=>{
  const root=await mkdtemp(join(tmpdir(),'work-budget-rounds-'));t.after(()=>rm(root,{recursive:true,force:true}));const workspace=join(root,'repo');await mkdir(workspace);
  const ref=await putWorkArtifact(root,Buffer.from('source'),'source.txt'),evidence=await putWorkArtifact(root,Buffer.from('actual review'),'review.txt');
  const draft:NewWork={id:'rounds',kind:'review',title:'Review rounds',goal:'Resolve findings',criteria:['Reviewed'],origin,owner,scope:{paths:['src'],permissions:['read'],checks:[]},reviewRequired:true,dependencies:[],context:{summary:'Context',nextAction:'Review',artifacts:[ref]},limits:{maxReviewRounds:2,maxRepeatedFindings:3,maxElapsedSeconds:3600}};
  const author={actor:origin,local:false,sessionId:'a',workspace},reviewer={actor:owner,local:true,sessionId:'b',workspace};
  let item=await createWorkItem(root,draft,author,'create');
  item=await operateWorkItem(root,draft.id,reviewer,{type:'accept',requestId:'accept',expectedVersion:item.version});
  for(let round=0;round<2;round++) {
    item=await operateWorkItem(root,draft.id,reviewer,{type:'review',requestId:'review-'+round,expectedVersion:item.version,revision:item.outputRevision,digest:item.outputDigest,accepted:false,findings:[{id:round===0?'constructor':'different-finding',content:'Different finding',status:'open'}],evidence,leaseToken:null});
    if(round===0)item=await operateWorkItem(root,draft.id,author,{type:'revise',requestId:'repair',expectedVersion:item.version,artifacts:[ref],testArtifact:evidence,summary:'Repair'});
  }
  item=await readWorkItem(root,draft.id,owner);
  assert.match(item.budget!.escalation!.reason,/2-round/);
  assert.equal(item.budget!.reviewRounds,2);assert.equal(item.budget!.repeatedFindings.constructor,1);
  assert.equal(parseWorkBudget(item.budget).reviewRounds,2);
  assert.throws(()=>parseWorkBudget({...item.budget,reviewRounds:-1}),/Invalid recorded/);
  assert.throws(()=>parseWorkBudget({...item.budget,repeatedFindings:{bad:'untrusted'}}),/Invalid recorded/);
  const revision=item.outputRevision;
  item=await operateWorkItem(root,draft.id,author,{type:'revise',requestId:'blocked',expectedVersion:item.version,artifacts:[ref],testArtifact:evidence,summary:'Over budget'});
  assert.equal(item.outputRevision,revision);assert.equal(item.events.at(-1)!.type,'budget-exceeded');
});
