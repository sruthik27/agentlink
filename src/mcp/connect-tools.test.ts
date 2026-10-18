import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const run = promisify(execFile);

test('already-open MCP sessions pair and exchange using one tool without rebinding their actor', async t => {
  const base = await mkdtemp(join(tmpdir(),'agentlink-connect-mcp-'));
  const repos=[join(base,'a'),join(base,'b')]; await Promise.all(repos.map(p=>mkdir(p)));
  const env: NodeJS.ProcessEnv={...process.env,AGENTLINK_CONNECTION_HOME:join(base,'private')};
  for (const key of ['AGENTLINK_NETWORK_STATE_ROOT','AGENTLINK_WAKE_CONFIG','AGENTLINK_PARTICIPANT_ID']) delete env[key];
  const clients=repos.map(cwd=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./server.js',import.meta.url))],{cwd,env,stdio:['pipe','pipe','pipe']});
    let next=0; const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{const m=JSON.parse(line);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
    const request=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>reject(new Error('MCP request timed out')),20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
    return {child,lines,request,call:async(args:Record<string,unknown>)=>(await request('tools/call',{name:'agentlink_connect',arguments:args})).structuredContent};
  });
  let id: string|undefined;
  t.after(async()=>{
    if(id) for(const client of clients) await client.call({action:'stop',connection:id}).catch(()=>{});
    await new Promise(r=>setTimeout(r,500));
    for(const client of clients){client.child.stdin.end();client.child.kill();client.lines.close()}
    await rm(base,{recursive:true,force:true});
  });
  for(const client of clients){await client.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'connection-test',version:'1'}});assert.ok((await client.request('tools/list')).tools.some((x:{name:string})=>x.name==='agentlink_connect'))}
  const invitation=await clients[0]!.call({action:'invite',to:'Alice',ip:'127.0.0.1'}); id=invitation.id;
  assert.equal((await clients[1]!.call({action:'accept',code:invitation.code})).status,'connected');
  await clients[0]!.call({action:'send',connection:id,body:'Built-in MCP transport test',requestId:'mcp-message'});
  const received=await clients[1]!.call({action:'receive',connection:id});
  assert.equal(received.snapshot.audit.at(-1).operation.content,'Built-in MCP transport test');
  const cli=fileURLToPath(new URL('../cli.js',import.meta.url));
  await run(process.execPath,[cli,'actor','add','--name','other','--id','other'],{cwd:repos[0],env});
  assert.equal((await clients[0]!.call({action:'status'})).connections[0].id,id);
  assert.deepEqual(JSON.parse((await run(process.execPath,[cli,'connect','status'],{cwd:repos[0],env})).stdout).connections,[]);
  await assert.rejects(clients[0]!.call({action:'send',connection:id,body:'bad',stateRoot:'/tmp/other'}),/Unsupported/);
});
