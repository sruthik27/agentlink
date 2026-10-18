import assert from 'node:assert/strict';
import { readFile, realpath, mkdir, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fixture, mcp, cli, stop } from './network-fixture.mjs';
import { enrollNetworkWake, scanNetworkWake, claimNetworkWake, releaseNetworkWake, networkWakeStatus, controlNetworkWake, NetworkWakeConnection } from '../dist/network/wake.js';
import { callRemoteAgentLinkTool } from '../dist/mcp/remote-tools.js';
import { revokeGrant } from '../dist/network/trust.js';
const f = await fixture();
let worker;
const wait = async (fn, ms = 15000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 200)); } throw Error('Wake verification deadline exceeded'); };
try {
  await f.call(0, 'accept'); await f.call(1, 'accept');
  const s = f.sides[0];
  const enroll = (id, extra={}) => enrollNetworkWake({ id, stateRoot:s.root,workspaceRoot:s.repo,peer:'frontend',remoteAgentId:'frontend',authority:'local',conversations:['orders'],harness:'claude-channel',expiresAt:new Date(Date.now()+600000).toISOString(),policy:'Read peer discussion through MCP. Reply only if asked a concrete question. Never implement. Acknowledge exact observed wake.',mcpEntrypoint:mcp,pollMs:500,...extra });
  const c = await enroll('checks');
  assert((await networkWakeStatus(c.configPath)).jobs.every(j=>j.attempts===0));
  assert.equal(await claimNetworkWake(c,'test'),undefined,'baseline must not wake');
  await f.call(1,'discuss',{content:'Please inspect this concrete wake test.'});
  await scanNetworkWake(c); await scanNetworkWake(c);
  let q=await networkWakeStatus(c.configPath); assert.equal(q.jobs.filter(j=>j.state==='pending').length,1,'deduplicate audit');
  const conn=new NetworkWakeConnection(c);
  await assert.rejects(conn.ack({eventId:'none',outcome:'observed',summary:'unbound'}),/call agentlink_wake_next on this MCP connection first/);
  const e=await conn.next(); assert(e);
  await assert.rejects(conn.authorizeTool('agentlink_collaboration',{...s.target,conversationId:'review'}),/scope/);
  await assert.rejects(conn.authorizeTool('agentlink_collaboration',{...s.target,authority:'peer'}),/scope/);
  await assert.rejects(conn.authorizeTool('agentlink_status',{}),/scope/);
  await assert.rejects(conn.ack({eventId:e.id,outcome:'observed',summary:'unread'}));
  const other=await enroll('other',{replayExisting:true}); assert.equal(await claimNetworkWake(other,'other-owner'),undefined,'cross-enrollment serialization');
  const args={...s.target,operation:{type:'get',requestId:'wake-proof'}};
  const result=await callRemoteAgentLinkTool('agentlink_collaboration',args,{stateRoot:s.root,workspaceRoot:s.repo,agentId:s.agent});
  await conn.observe('agentlink_collaboration',{...args,cached:true},result);
  await assert.rejects(conn.ack({eventId:e.id,outcome:'observed',summary:'cached'}),/await the non-cached/);
  await conn.observe('agentlink_collaboration',args,result);
  await assert.rejects(conn.ack({eventId:'wrong',outcome:'observed',summary:'wrong'}),/event mismatch/);
  await conn.ack({eventId:e.id,outcome:'observed',summary:'Exact peer audit read through connection'});
  assert.equal((await networkWakeStatus(c.configPath)).jobs.find(j=>j.event.id===e.id).state,'observed');
  await controlNetworkWake(other.configPath,'stop');
  await controlNetworkWake(c.configPath,'pause'); await f.call(1,'discuss',{content:'Paused event.'}); assert.equal(await conn.next(),undefined);
  await controlNetworkWake(c.configPath,'resume'); assert(await conn.next());
  await releaseNetworkWake(c,conn.owner); // Explicit test cleanup; uncertain running remains blocked.
  assert.equal(await claimNetworkWake(c,'test'),undefined,'uncertain running job must not replay');
  await controlNetworkWake(c.configPath,'stop');
  console.log('PASS durable baseline, dedupe, exact observation, cached/wrong ack rejection, serialization, pause, uncertain dispatch');

  const channel=await enroll('channel');
  worker=spawn(process.execPath,[mcp],{cwd:s.repo,env:{...process.env,AGENTLINK_NETWORK_STATE_ROOT:s.root,AGENTLINK_WAKE_CONFIG:channel.configPath},stdio:['pipe','pipe','pipe']});
  let init, notification; let stderr=''; worker.stderr.on('data',b=>stderr+=b);
  const lines=createInterface({input:worker.stdout}); lines.on('line',l=>{const r=JSON.parse(l);if(r.id===1)init=r.result;if(r.method==='notifications/claude/channel')notification=r.params;});
  worker.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n');
  await wait(()=>init); assert.equal(init.capabilities.experimental['claude/channel']!==undefined,true);
  worker.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  await f.call(1,'discuss',{content:'Channel push test: remote instruction text must not be directly embedded.'});
  await wait(()=>notification); assert(notification.meta.event_id); assert(!notification.content.includes('remote instruction text must not'));
  await stop(worker); worker=undefined; lines.close();
  console.log('PASS initialized MCP Claude channel pushes an authenticated event reference without a tool poll');
  // This is protocol verification, not a claim that a Claude model consumed it.
  // Clear the intentionally unacknowledged channel lease only in this disposable fixture.
  const { atomicWriteFile }=await import('../dist/atomic.js');
  await atomicWriteFile(s.root+'/wake/active-backend.json','null');
  await controlNetworkWake(channel.configPath,'stop');
  if(process.argv.includes('--native')) {
    const native=await enroll('native',{harness:'codex',codexExecutable:await realpath(process.env.CODEX_EXECUTABLE??'/opt/homebrew/bin/codex'),model:process.env.AGENTLINK_WAKE_MODEL??'gpt-5.6-sol',policy:'Read the exact peer wake via agentlink_collaboration get. For each concrete ping asking a label reply using discuss with exactly the requested label; do not send other messages. Then agentlink_wake_ack observed. No implementation or shell needed.'});
    worker=spawn(process.execPath,[cli,'network','wake','run','--state-root',s.root,'--id','native'],{cwd:s.repo,stdio:['ignore','pipe','pipe']});
    worker.stderr.on('data',b=>process.stderr.write(b));
    let turnCount=0; const startWorker=()=>{const p=spawn(process.execPath,[cli,'network','wake','run','--state-root',s.root,'--id','native'],{cwd:s.repo,stdio:['ignore','pipe','pipe']});p.stderr.on('data',b=>process.stderr.write(b));return p;};
    for(const label of ['automatic-first','automatic-after-idle','automatic-after-restart']) {
      if(label==='automatic-after-restart'){await stop(worker);worker=startWorker();}
      turnCount++;
      await f.call(1,'discuss',{content:'Please reply with label '+label});
      await wait(async()=>{const q=await networkWakeStatus(native.configPath); if(q.jobs.some(j=>j.state==='suspended'))throw Error(JSON.stringify(q));return q.jobs.some(j=>j.state==='observed'&&j.attempts>0&&j.summary?.includes(label)) || (q.jobs.filter(j=>j.state==='observed'&&j.attempts>0).length===turnCount);},180000);
      const state=await f.call(0,'get'); assert(state.snapshot.audit.some(a=>a.actor.agentId==='backend'&&a.operation.type==='discuss'&&a.operation.content===label),'native peer reply must exist');
      await wait(async()=>JSON.parse(await readFile(s.root+'/wake/active-backend.json','utf8'))===null,15000);
      console.log('PASS native Codex automatically woke and acknowledged '+label);
    }
    const q=await networkWakeStatus(native.configPath); assert(q.threadId); assert.equal(q.turns,3);
    await stop(worker); worker=undefined;
    console.log(JSON.stringify({nativeThreadId:q.threadId,turns:q.turns}));
  }
  const delivered=await enroll('delivered');
  await f.call(1,'discuss',{content:'Delivered before revocation'});
  const deliveredConnection=new NetworkWakeConnection(delivered);const deliveredEvent=await deliveredConnection.next();assert(deliveredEvent);deliveredConnection.markDispatched();
  await revokeGrant(s.root,'orders-grant');
  await assert.rejects(deliveredConnection.next(),/revoked|grant/i);
  await deliveredConnection.dispatchFailed('Revoked after send',false);
  assert.equal((await networkWakeStatus(delivered.configPath)).jobs.find(j=>j.event.id===deliveredEvent.id).state,'suspended','already delivered events must not be silently replayed');
  await assert.rejects(scanNetworkWake(c),/revoked|grant/i);
  await controlNetworkWake(c.configPath,'stop'); assert((await networkWakeStatus(c.configPath)).stopped);
  console.log('PASS revocation blocks wake while owner status/stop remain available');
} finally { if(worker)await stop(worker); if(process.env.AGENTLINK_WAKE_EVIDENCE){await mkdir(process.env.AGENTLINK_WAKE_EVIDENCE,{recursive:true});await cp(f.sides[0].root+'/wake',process.env.AGENTLINK_WAKE_EVIDENCE,{recursive:true});} await f.close(); }
