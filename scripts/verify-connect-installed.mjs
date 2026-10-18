#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const run=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
const base=await mkdtemp(join(tmpdir(),'agentlink-connect-installed-'));
const previous=process.env.AGENTLINK_CONNECTION_HOME;
const previousActor=process.env.AGENTLINK_PARTICIPANT_ID;
const repos=[join(base,'author'),join(base,'developer')];
let action,id;
try {
  const packed=await run('npm',['pack','--json','--pack-destination',base],{cwd:root,timeout:60000});
  const [manifest]=JSON.parse(packed.stdout);
  for(const path of ['dist/network/connect.js','dist/network/connect-daemon.js','dist/mcp/connect-tools.js','docs/connect.md']) assert.ok(manifest.files.some(f=>f.path===path),`Missing ${path}`);
  const archive=join(base,manifest.filename);
  const archiveSha256=createHash('sha256').update(await readFile(archive)).digest('hex');
  const prefix=join(base,'install');
  await run('npm',['install','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',archive],{timeout:60000});
  await Promise.all(repos.map(p=>mkdir(p)));
  process.env.AGENTLINK_CONNECTION_HOME=join(base,'private'); delete process.env.AGENTLINK_PARTICIPANT_ID;
  action=(await import(pathToFileURL(join(prefix,'node_modules/@sruthik/agentlink/dist/network/connect.js')).href)).connectAction;
  const invite=await action(repos[0],{action:'invite',to:'Developer',ip:'127.0.0.1'}); id=invite.id;
  const accepted=await action(repos[1],{action:'accept',code:invite.code}); assert.equal(accepted.status,'connected');
  for(let i=0;i<2;i++) await action(repos[0],{action:'send',connection:id,body:'Verify installed connection',requestId:'installed-message'});
  const received=await action(repos[1],{action:'receive',connection:id});
  assert.equal(received.snapshot.audit.filter(e=>e.operation.type==='discuss').length,1);
  assert.equal(received.snapshot.audit.at(-1).operation.content,'Verify installed connection');
  await action(repos[1],{action:'send',connection:id,body:'Verified installed reply',requestId:'installed-reply'});
  const returned=await action(repos[0],{action:'receive',connection:id}); assert.equal(returned.snapshot.audit.at(-1).operation.content,'Verified installed reply');
  console.log(JSON.stringify({status:'PASS',archiveSha256,checks:{oneCodePairing:true,managedMutualTls:true,installedDaemonEntrypoint:true,bidirectionalMessages:true,identicalRetryNoDuplicate:true},nativeModelVerified:false,physicalHostsVerified:false}));
} finally {
  if(action&&id) for(const repo of repos) await action(repo,{action:'stop',connection:id}).catch(()=>{});
  await new Promise(r=>setTimeout(r,600));
  if(previous===undefined) delete process.env.AGENTLINK_CONNECTION_HOME; else process.env.AGENTLINK_CONNECTION_HOME=previous;
  if(previousActor===undefined) delete process.env.AGENTLINK_PARTICIPANT_ID; else process.env.AGENTLINK_PARTICIPANT_ID=previousActor;
  await rm(base,{recursive:true,force:true});
}
