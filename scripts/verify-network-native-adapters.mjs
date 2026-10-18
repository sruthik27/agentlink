import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile,writeFile,mkdir,cp,realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fixture,mcp,cli,stop } from './network-fixture.mjs';
import { enrollNetworkWake,networkWakeStatus,runNetworkWakeOnce,releaseNetworkWake,NetworkWakeConnection,connectOpenCodeWake } from '../dist/network/wake.js';
const f=await fixture();let child,server;let nativeOutput='';
const wait=async fn=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw Error('Adapter deadline');};
function bridge(side,config){
 const p=spawn(process.execPath,[mcp],{cwd:side.repo,env:{...process.env,AGENTLINK_NETWORK_STATE_ROOT:side.root,AGENTLINK_WAKE_CONFIG:config.configPath},stdio:['pipe','pipe','pipe']});
 let id=0;const pending=new Map();const lines=createInterface({input:p.stdout});let stderr='';p.stderr.on('data',b=>stderr+=b);
 lines.on('line',l=>{const r=JSON.parse(l);const callback=pending.get(r.id);if(callback){pending.delete(r.id);r.error?callback.reject(Error(r.error.message)):callback.resolve(r.result);}});
 return {p,request(method,params){return new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},async tool(name,args){return this.request('tools/call',{name,arguments:args});}};
}
try{
 await f.call(0,'accept');await f.call(1,'accept');const s=f.sides[0];
 const enroll=(id,harness,extra={})=>enrollNetworkWake({id,stateRoot:s.root,workspaceRoot:s.repo,peer:'frontend',remoteAgentId:'frontend',authority:'local',conversations:['orders'],harness,expiresAt:new Date(Date.now()+600000).toISOString(),policy:'Read exact event, reply only to a concrete ping, acknowledge. No edits.',mcpEntrypoint:mcp,pollMs:500,...extra});
 const c=await enroll('monitor','claude-monitor');const b=bridge(s,c);await b.request('initialize',{});
 child=spawn(process.execPath,[cli,'network','wake','monitor','--state-root',s.root,'--id',c.id],{cwd:s.repo,stdio:['ignore','pipe','pipe']});
 let notifications=[];const lines=createInterface({input:child.stdout});lines.on('line',l=>notifications.push(JSON.parse(l)));
 await f.call(1,'discuss',{content:'Monitor test'});await wait(()=>notifications.length);assert.equal((await networkWakeStatus(c.configPath)).turns,0,'Monitor emission is not a model claim');
 const next=await b.tool('agentlink_wake_next',{});const e=next.structuredContent.event;assert(e);assert.equal(e.id,notifications[0].event.id);
 await assert.rejects(b.tool('agentlink_wake_ack',{eventId:e.id,outcome:'observed',summary:'unread'}));
 await b.tool('agentlink_collaboration',{...s.target,operation:{type:'get',requestId:'monitor-read'}});
 await b.tool('agentlink_wake_ack',{eventId:e.id,outcome:'observed',summary:'Native Monitor MCP consumer exact read'});
 assert.equal((await networkWakeStatus(c.configPath)).jobs.find(j=>j.event.id===e.id).state,'observed');await stop(child);child=undefined;await stop(b.p);lines.close();
 console.log('PASS Monitor stdout stream, dynamic MCP bind, unread rejection and exact observation acknowledgement');
 let opencode;
 if(process.argv.includes('--claude')) {
   const c=await enroll('claude-native','claude-monitor');
   const config={mcpServers:{agentlink:{command:process.execPath,args:[mcp],env:{AGENTLINK_NETWORK_STATE_ROOT:s.root,AGENTLINK_WAKE_CONFIG:c.configPath}}}};
   const command=[process.execPath,cli,'network','wake','monitor','--state-root',s.root,'--id',c.id].map(x=>"'"+x.replaceAll("'","'\\''")+"'").join(' ');
   const prompt='Owner-authorized isolated AgentLink test. Use Monitor to run exactly this command with a 120000ms deadline: '+command+'. Wait for its event. Then call MCP agentlink_wake_next, get the exact enrolled event using agentlink_collaboration peer frontend agent frontend authority local conversationId orders, discuss exactly native-claude-monitor-reply, and acknowledge eventId observed. Do not use shell, edit, other repos or other peers. Stop Monitor after the acknowledgement and finish. Do not finish before handling the event.';
   child=spawn('claude',['-p',prompt,'--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config',JSON.stringify(config),'--allowedTools','Monitor','mcp__agentlink__*','--max-turns','12'],{cwd:s.repo,stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',b=>{output+=b;nativeOutput+=b;});child.stderr.on('data',b=>{output+=b;nativeOutput+=b;});
   await wait(()=>{if(output.includes('Not logged in'))throw Error('Claude native acceptance blocked: local CLI is not logged in');return output.includes('"name":"Monitor"')||output.includes('"name": "Monitor"');});
   await f.call(1,'discuss',{content:'Native Monitor event: please reply native-claude-monitor-reply'});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Claude Monitor native deadline')),180000);child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Claude exited '+code));});});
   if(process.env.AGENTLINK_WAKE_EVIDENCE)await writeFile(process.env.AGENTLINK_WAKE_EVIDENCE+'-claude.jsonl',output,{mode:0o600});
   const q=await networkWakeStatus(c.configPath);assert(q.jobs.some(j=>j.state==='observed'&&j.attempts>0));const result=await f.call(0,'get');assert(result.snapshot.audit.some(a=>a.actor.agentId==='backend'&&a.operation.content==='native-claude-monitor-reply'));
   child=undefined;console.log('PASS actual Claude Monitor wakes existing model conversation, scoped MCP read/reply/ack');
 } else if(process.argv.includes('--native')){
   const alias='gpt-5.3-codex';const config={provider:{openai:{models:{[alias]:{id:'gpt-5.6-sol'}}}},mcp:{MCP_DOCKER:{enabled:false},browsermcp:{enabled:false},'chrome-devtools':{enabled:false},pencil:{enabled:false}},permission:{bash:'deny',edit:'deny',write:'deny',task:'deny','agentlink_*':'allow'}};
   // Start with config path before enrollment; MCP is lazy and connects only after config exists.

   child=spawn('opencode',['serve','--hostname','127.0.0.1','--port','0'],{cwd:s.repo,env:{...process.env,OPENCODE_CONFIG_CONTENT:JSON.stringify(config)},detached:true,stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',b=>{output+=b;nativeOutput+=b;});child.stderr.on('data',b=>{output+=b;nativeOutput+=b;});
   const url=await wait(()=>output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
   const session=await fetch(url+'/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'AgentLink isolated wake acceptance'})}).then(r=>r.json());
   opencode=await enroll('opencode','opencode',{opencodeUrl:url,opencodeSessionId:session.id,opencodeExclusive:true,model:'openai/gpt-5.3-codex',policy:'Read the event by first agentlink_wake_next with provided eventId, then agentlink_collaboration get. Reply using discuss with exactly native-opencode-reply only for a message asking that label. Then agentlink_wake_ack observed. Never use shell/edit tools.'});
   assert.equal((await connectOpenCodeWake(opencode.configPath)).status,'connected');
   await f.call(1,'discuss',{content:'Please reply with label native-opencode-reply'});
   assert.equal(await runNetworkWakeOnce(opencode.configPath),'observed');
   const result=await f.call(0,'get');assert(result.snapshot.audit.some(a=>a.actor.agentId==='backend'&&a.operation.content==='native-opencode-reply'));
   assert.equal(await runNetworkWakeOnce(opencode.configPath),'idle');
   await f.call(1,'discuss',{content:'After idle, please reply with label native-opencode-reply'});
   assert.equal(await runNetworkWakeOnce(opencode.configPath),'observed');
   const resumed=await f.call(0,'get');assert.equal(resumed.snapshot.audit.filter(a=>a.actor.agentId==='backend'&&a.operation.content==='native-opencode-reply').length,2);
   console.log('PASS actual OpenCode existing-session first and resumed idle native turns, scoped MCP read/reply/ack');try{process.kill(-child.pid,'SIGTERM');}catch{}await stop(child);child=undefined;
 }else{
   let apiCalls=[];let nativeBridge;
   server=createServer(async(req,res)=>{apiCalls.push(req.url);try{
    if(req.url.startsWith('/session/ses_adapter/message')){let body='';for await(const x of req)body+=x;const e=JSON.parse(body).parts[0].text.match(/First call agentlink_wake_next with eventId ([a-f0-9]+)/)[1];await nativeBridge.tool('agentlink_wake_next',{eventId:e});await nativeBridge.tool('agentlink_collaboration',{...s.target,operation:{type:'get',requestId:'api-read'}});await nativeBridge.tool('agentlink_wake_ack',{eventId:e,outcome:'observed',summary:'Exact event via native API fixture'});res.end('{}');}
    else if(req.url.startsWith('/session/status'))res.end(JSON.stringify({ses_adapter:{type:'idle'}}));
    else if(req.url.startsWith('/session/ses_adapter/abort'))res.end('true');
    else res.end(JSON.stringify({id:'ses_adapter',directory:s.repo}));
   }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
   opencode=await enroll('opencode','opencode',{opencodeUrl:'http://127.0.0.1:'+server.address().port,opencodeSessionId:'ses_adapter',opencodeExclusive:true});nativeBridge=bridge(s,opencode);await nativeBridge.request('initialize',{});
   await f.call(1,'discuss',{content:'OpenCode fixture'});assert.equal(await runNetworkWakeOnce(opencode.configPath),'observed');assert(apiCalls.some(u=>u.startsWith('/session/ses_adapter/message')));await stop(nativeBridge.p);await new Promise(r=>server.close(r));server=undefined;
   console.log('PASS OpenCode loopback session/workspace binding, native API dispatch and exact MCP acknowledgement');
 }
}finally{if(process.env.AGENTLINK_WAKE_EVIDENCE&&nativeOutput)await writeFile(process.env.AGENTLINK_WAKE_EVIDENCE+'-process.log',nativeOutput,{mode:0o600});if(child){if(process.argv.includes('--native')){try{process.kill(-child.pid,'SIGTERM');}catch{}}await stop(child);}if(server)await new Promise(r=>server.close(r));if(process.env.AGENTLINK_WAKE_EVIDENCE){await mkdir(process.env.AGENTLINK_WAKE_EVIDENCE,{recursive:true});await cp(f.sides[0].root+'/wake',process.env.AGENTLINK_WAKE_EVIDENCE,{recursive:true});}await f.close();}
