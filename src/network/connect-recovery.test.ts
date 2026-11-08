import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { connectAction,readConnection,runConnectCli } from './connect.js';
import { exportPublicIdentity } from './identity.js';
import { listLocalGrantSummaries,revokeGrant } from './trust.js';
test('paired relationship reconnects after process death, preserves identity/history and renews finite access only through owner CLI',async t=>{
  const base=await mkdtemp(join(tmpdir(),'connect-recovery-')),repos=[join(base,'a'),join(base,'b')];await Promise.all(repos.map(path=>mkdir(path)));
  const previousHome=process.env.AGENTLINK_CONNECTION_HOME,previousActor=process.env.AGENTLINK_PARTICIPANT_ID;process.env.AGENTLINK_CONNECTION_HOME=join(base,'private');delete process.env.AGENTLINK_PARTICIPANT_ID;
  let id:string|undefined;
  t.after(async()=>{if(id)for(const repo of repos)await connectAction(repo,{action:'stop',connection:id}).catch(()=>{});await pause(500);if(previousHome===undefined)delete process.env.AGENTLINK_CONNECTION_HOME;else process.env.AGENTLINK_CONNECTION_HOME=previousHome;if(previousActor===undefined)delete process.env.AGENTLINK_PARTICIPANT_ID;else process.env.AGENTLINK_PARTICIPANT_ID=previousActor;await rm(base,{recursive:true,force:true});});
  const invitation=await connectAction(repos[0]!,{action:'invite',to:'partner',ip:'127.0.0.1'});id=invitation.id as string;await connectAction(repos[1]!,{action:'accept',code:invitation.code});
  const old=await readConnection(repos[0]!,id),identity=await exportPublicIdentity(old.root),trustBefore=await readFile(join(old.root,'trust.json'),'utf8');
  await connectAction(repos[1]!,{action:'send',connection:id,body:'Persisted before crash',requestId:'before-crash'});
  process.kill(old.pid!,'SIGKILL');
  for(let i=0;i<50;i++){try{process.kill(old.pid!,0);await pause(20);}catch{break;}}
  const resumed=await Promise.all([connectAction(repos[0]!,{action:'reconnect',connection:id}),connectAction(repos[0]!,{action:'reconnect',connection:id})]);
  assert.ok(resumed.every(result=>result.status==='connected'));
  const current=await readConnection(repos[0]!,id);assert.notEqual(current.pid,old.pid);assert.equal(current.address,old.address);assert.equal(current.expiresAt,old.expiresAt);assert.deepEqual(await exportPublicIdentity(current.root),identity);assert.equal(await readFile(join(current.root,'trust.json'),'utf8'),trustBefore);
  const history=await connectAction(repos[0]!,{action:'receive',connection:id});assert.ok((history.snapshot as {audit:Array<{requestId:string}>}).audit.some(row=>row.requestId==='before-crash'));
  for(const repo of repos)await connectAction(repo,{action:'stop',connection:id});await pause(600);
  await assert.rejects(connectAction(repos[0]!,{action:'reconnect',connection:id}),/owner stop/);
  await assert.rejects(connectAction(repos[0]!,{action:'authorize',connection:id,ttl:'2h'}),/Unsupported|Arguments/);
  for(const repo of repos){let output='';const args=['authorize','--connection',id,'--request-id','owner-window-1','--ttl','3h'];await runConnectCli(args,repo,{log:value=>output=value});const granted=JSON.parse(output);assert.equal(granted.status,'authorized-stopped');assert.ok(Date.parse(granted.expiresAt)>Date.parse(old.expiresAt));const until=granted.expiresAt;await runConnectCli(args,repo,{log:value=>output=value});assert.equal(JSON.parse(output).expiresAt,until);await assert.rejects(runConnectCli(['authorize','--connection',id,'--request-id','owner-window-1','--ttl','4h'],repo,{log:()=>{}}),/Conflicting/);await connectAction(repo,{action:'resume',connection:id});}
  await connectAction(repos[1]!,{action:'send',connection:id,body:'Same peer after owner renewal',requestId:'after-renewal'});
  assert.equal((await exportPublicIdentity(current.root)).fingerprint,identity.fingerprint);
  assert.equal((await listLocalGrantSummaries(current.root,current.actor)).length,1);
  await connectAction(repos[0]!,{action:'stop',connection:id});await pause(600);await revokeGrant(current.root,'connection');
  await assert.rejects(connectAction(repos[0]!,{action:'resume',connection:id}),/authorization/);
  await assert.rejects(runConnectCli(['authorize','--connection',id,'--request-id','revoked-window','--ttl','3h'],repos[0]!,{log:()=>{}}),/revoked/);
});
