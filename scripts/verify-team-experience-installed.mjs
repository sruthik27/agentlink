import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
const run=promisify(execFile),base=await mkdtemp(join(tmpdir(),'agentlink-experience-installed-'));
const source=fileURLToPath(new URL('../',import.meta.url)),repos=[join(base,'a'),join(base,'b')],clients=[];
const env={...process.env,AGENTLINK_CONNECTION_HOME:join(base,'private')};
for(const key of ['AGENTLINK_NETWORK_STATE_ROOT','AGENTLINK_WAKE_CONFIG','AGENTLINK_PARTICIPANT_ID'])delete env[key];
let id;
function mcp(installed,workspace) {
  const child=spawn(process.execPath,[join(installed,'dist/mcp/launch.js'),'--session'],{cwd:workspace,env,stdio:['pipe','pipe','pipe']});
  let serial=0,stderr='';const pending=new Map(),lines=createInterface({input:child.stdout});
  child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-4096));
  lines.on('line',line=>{const message=JSON.parse(line),request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);});
  child.on('exit',()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('MCP exited: '+stderr));}pending.clear();});
  const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP request timed out: '+method));},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  return {child,lines,request,call:async(name,args)=>{const result=await request('tools/call',{name,arguments:args});if(result.isError)throw new Error(result.content?.map(value=>value.text).join('\n'));return result.structuredContent;}};
}
try {
  const packed=JSON.parse((await run('npm',['pack','--ignore-scripts','--json','--pack-destination',base],{cwd:source,maxBuffer:4*1024*1024})).stdout)[0];
  for(const path of ['dist/network/work-packages.js','dist/network/work-integration.js','dist/network/work-budgets.js','dist/network/work-directory.js','dist/network/work-activity.js','docs/team-experience-plan.md'])assert.ok(packed.files.some(file=>file.path===path),'Missing package file '+path);
  assert.ok(!packed.files.some(file=>file.path.includes('.hermes') || file.path.endsWith('.test.js')));
  const archive=join(base,packed.filename),archiveSha256=createHash('sha256').update(await readFile(archive)).digest('hex'),prefix=join(base,'install');
  await run('npm',['install','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',archive],{timeout:60000});
  const installed=join(prefix,'node_modules/@sruthik/agentlink'),cli=join(installed,'dist/cli.js');
  const {workGit}=await import(pathToFileURL(join(installed,'dist/network/work-git.js')).href);
  await mkdir(repos[0]);await workGit(repos[0],['init','--initial-branch=main']);await mkdir(join(repos[0],'src'));await mkdir(join(repos[0],'tests'));
  await writeFile(join(repos[0],'src/value.cjs'),'exports.value=1;\n');await writeFile(join(repos[0],'tests/unit.cjs'),"require('node:assert/strict').equal(require('../src/value.cjs').value,2);console.log('verified selected package');\n");
  await workGit(repos[0],['add','--','src','tests']);await workGit(repos[0],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','isolated fixture']);await workGit(base,['clone','--no-local',repos[0],repos[1]]);
  await writeFile(join(repos[0],'src/value.cjs'),'exports.value=2;\n');await writeFile(join(repos[1],'src/value.cjs'),'exports.value=77;\n');
  for(const workspace of repos) {
    const client=mcp(installed,workspace);clients.push(client);
    await client.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'installed-experience',version:'1'}});
    childInitialized(client);
    const tool=(await client.request('tools/list')).tools.find(value=>value.name==='agentlink_work');
    assert.ok(tool.inputSchema.properties.action.enum.includes('integration-release'));
    await client.call('agentlink_session',{action:'bind',workspace});
  }
  const invitation=await clients[0].call('agentlink_connect',{action:'invite',to:'alice',ip:'127.0.0.1'});id=invitation.id;
  await clients[1].call('agentlink_connect',{action:'accept',code:invitation.code});
  const call=(host,args)=>clients[host].call('agentlink_work',{connection:id,...args});
  const ownerCli=(host,args)=>run(process.execPath,[cli,'work',...args],{cwd:repos[host],env,timeout:30000});
  for(let host=0;host<2;host++) {
    await ownerCli(host,['policy','grant','--connection',id,'--id','team','--paths','src,tests','--allow','read,edit,test','--checks','unit','--ttl','10m']);
    await ownerCli(host,['checks','set','--connection',id,'--id','unit','--command',process.execPath,'--args-json','["tests/unit.cjs"]','--timeout-seconds','10']);
  }
  const inbox=await call(1,{action:'inbox-open',route:'frontend',mode:'active-poll',leaseSeconds:300,capabilities:['javascript','review'],project:'calc'});
  await ownerCli(0,['team','add','--connection',id,'--name','alice','--project','calc','--route','frontend']);
  const resolved=await clients[0].call('agentlink_work',{action:'team-resolve',name:'alice',project:'calc',capabilities:['review'],queueIfOffline:false});assert.equal(resolved.target.route,'frontend');
  const namedCli=JSON.parse((await ownerCli(0,['--session','installed-cli','--request',JSON.stringify({action:'team-resolve',name:'alice',project:'calc',capabilities:['review'],queueIfOffline:false})])).stdout);assert.equal(namedCli.target.route,'frontend');
  const packedContext=await call(0,{action:'package',policyId:'team',requestId:'context',summary:'Selected value change',decisions:['Preserve export'],nextAction:'Verify locally'});
  const draft={id:'installed-experience',kind:'handoff',title:'Selected value change',goal:'Finish with evidence',criteria:['unit passes'],scope:{paths:['src','tests'],permissions:['read','edit','test'],checks:['unit']},reviewRequired:false,dependencies:[],context:packedContext.workContext};
  await clients[0].call('agentlink_work',{action:'create-to',name:'alice',project:'calc',capabilities:['javascript'],queueIfOffline:false,requestId:'create',work:draft});
  let activity=await call(1,{action:'activity',refresh:false,includeArchived:false});assert.equal(activity.rows[0].phase,'delivered');assert.equal(activity.rows[0].observed,false);
  const delivery=(await call(1,{action:'inbox-next',route:'frontend',token:inbox.token})).event;
  await call(1,{action:'inbox-ack',route:'frontend',token:inbox.token,eventId:delivery.id,deliveryToken:delivery.token,outcome:'observed',summary:'Read package'});
  activity=await call(1,{action:'activity',refresh:false,includeArchived:false});assert.equal(activity.rows[0].phase,'observed');
  let serial=0;
  const get=async(host,workId)=>(await call(host,{action:'get',id:workId,location:host===1?'local':'peer'})).item;
  const op=async(host,workId,type,extra={})=>{const item=await get(host,workId);return (await call(host,{action:'operate',id:workId,location:host===1?'local':'peer',...(host===1?{policyId:'team'}:{}),operation:{type,requestId:'op-'+(++serial),expectedVersion:item.version,...extra}})).item;};
  await op(1,draft.id,'accept');let item=await op(1,draft.id,'claim',{leaseSeconds:300});
  const integrated=(await call(1,{action:'integrate',id:draft.id,location:'local',integrationId:'receiver',requestId:'receiver',manifest:packedContext.manifest,policyId:'team',checks:['unit'],leaseToken:item.claim.token})).integration;
  assert.equal(integrated.state,'passed',integrated.error);assert.match(await readFile(join(repos[1],'src/value.cjs'),'utf8'),/=77/);
  await op(1,draft.id,'submit',{leaseToken:item.claim.token,artifacts:integrated.artifacts,testArtifact:integrated.checks[0].evidence,summary:'Verified isolated bytes'});await op(1,draft.id,'complete',{summary:'Verified'});
  const merged=(await call(0,{action:'integrate',id:draft.id,location:'peer',integrationId:'sender',requestId:'sender',manifest:integrated.packageManifest,policyId:'team',checks:['unit'],leaseToken:null})).integration;assert.equal(merged.state,'passed',merged.error);
  const checked=await call(0,{action:'package',policyId:'team',requestId:'recorded',summary:'Verified result',decisions:[],nextAction:'Review'});assert.equal(checked.context.checks[0].passed,true);
  const review={...draft,id:'installed-budget',kind:'review',reviewRequired:true,limits:{maxReviewRounds:1,maxRepeatedFindings:3,maxElapsedSeconds:3600}};
  await call(0,{action:'create',work:review,requestId:'review-create'});await op(1,review.id,'accept');item=await get(1,review.id);
  item=await op(1,review.id,'review',{revision:item.outputRevision,digest:item.outputDigest,accepted:false,findings:[{id:'boundary',content:'Needs repair',status:'open'}],evidence:integrated.checks[0].evidence,leaseToken:null});assert.match(item.budget.escalation.reason,/round/);
  const revision=item.outputRevision;item=await op(0,review.id,'revise',{artifacts:packedContext.artifacts,testArtifact:integrated.checks[0].evidence,summary:'Over-budget repair'});assert.equal(item.outputRevision,revision);assert.equal(item.events.at(-1).type,'budget-exceeded');
  await op(1,review.id,'budget-notice',{escalationId:item.budget.escalation.id});assert.ok((await get(1,review.id)).budget.escalation.notifiedAt);
  assert.equal((await call(1,{action:'get',id:review.id,location:'local'})).escalation.notifyHuman,false);
  await ownerCli(1,['budget','authorize','--connection',id,'--id',review.id,'--request-id','owner-budget','--rounds','2','--repeats','3','--elapsed-seconds','3600','--expires-at',new Date(Date.now()+3600000).toISOString()]);
  assert.equal((await get(1,review.id)).budget.escalation,undefined);
  item=await op(0,review.id,'revise',{artifacts:packedContext.artifacts,testArtifact:integrated.checks[0].evidence,summary:'Owner-authorized next repair'});assert.equal(item.outputRevision,revision+1);
  await call(1,{action:'integration-release',integrationId:'receiver',reportDigest:integrated.report.digest});
  const terminal=(await ownerCli(0,['activity','--connection',id,'--archive'])).stdout;assert.match(terminal,/installed-experience/);assert.match(terminal,/completed/);assert.match(terminal,/cached/);
  const build=JSON.parse((await run(process.execPath,[cli,'version','--format','json'],{cwd:repos[0],env})).stdout);
  console.log(JSON.stringify({status:'PASS',archiveSha256,build,checks:{actualGlobalMcp:true,automaticContext:true,namedRoutingCliAndMcp:true,isolatedIntegrationAndRealCheck:true,dirtyOriginalPreserved:true,verifiedResultReturnedAndRechecked:true,matchingCheckPackaging:true,reviewBudgetEnforced:true,oneDurableEscalationNotice:true,ownerCliBudgetAuthorization:true,activityDistinguishesObservation:true,verifiedWorktreeRelease:true},nativeModelVerified:false,physicalHostsVerified:false}));
}finally {
  if(id)for(const client of clients)await client.call('agentlink_connect',{action:'stop',connection:id}).catch(()=>{});
  for(const client of clients){client.child.stdin.end();client.child.kill();client.lines.close();}
  await new Promise(resolve=>setTimeout(resolve,600));await rm(base,{recursive:true,force:true});
}
function childInitialized(client){client.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}
