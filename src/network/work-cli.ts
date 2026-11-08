import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { readConnection } from './connect.js';
import { resolvePairedPeer } from './config.js';
import { expiryFromOptions } from './expiry.js';
import { validateNetworkId } from './types.js';
import { connectionWorkAction } from './work-client.js';
import { parseWorkScope, readWorkPolicy, revokeWorkPolicy, writeWorkPolicy } from './work-policy.js';
import { workExperienceAction } from './work-experience.js';
import { workConnection } from './work-connection.js';
import { writeLocalWorkCheck } from './work-checks.js';
import { authorizeWorkBudget } from './work-items.js';
import { nameWorkPeer,removeWorkPeerName,listWorkPeers } from './work-directory.js';
import { workActivity,renderWorkActivity } from './work-activity.js';

export const WORK_HELP = `AgentLink durable team work (current session workspace)
  agentlink work --connection <id> --session <live-session-id> --request '<JSON>'
  agentlink work session
      Generate a fresh session id once; reuse it for this agent session only.
  agentlink work monitor --connection <id> --session <same-agent-session> --route <route>
      Durable native background stdout consumer; run in the agent's native Monitor tool.
Request actions: create, list, get, operate, export, artifact-create, artifact, reconcile,
sync, inbox-open, inbox-next, inbox-ack, inbox-close, inbox-status, inbox-route, maintenance,
package, integrate, integration-status, integration-release, team-list, team-resolve,
create-to, activity. Named routing and activity requests may omit --connection.
package: policyId, requestId, summary, decisions, nextAction, optional paths.
integrate: id, location, integrationId, requestId, manifest, policyId, checks, leaseToken.
integration-release: integrationId, reportDigest. Removes only an unchanged verified
worktree; retains evidence and never commits or merges into the original checkout.
create: work draft + stable requestId; origin/owner come from the connection.
list: location local|peer, includeArchived boolean, offset integer.
get: id, location local|peer|cache. Cache is explicitly stale and cannot execute work.
operate: id, location local|peer, operation {type,requestId,expectedVersion,...}.
Local operate also requires policyId (null for metadata-only operations).
export: path, policyId. Only locally delegated paths may be read/exported.
artifact-create: name, content (explicit UTF-8), mediaType. Does not read files.
artifact: id, location local|peer, artifact reference, offset (32768-byte chunks).
reconcile: requestId. Reads peer receipts after an uncertain send; never replays it.
Accepted work remains on the recipient and can finish with the sender offline.

Local owner policy administration (never a peer or MCP grant action):
  agentlink work policy grant --connection <id> --id <policy> --paths src,tests --allow read,edit,test --checks unit --ttl 2h
  agentlink work policy show --connection <id> --id <policy>
  agentlink work policy revoke --connection <id> --id <policy>
  agentlink work checks set --connection <id> --id unit --command /absolute/executable --args-json '["tests/unit.js"]' --timeout-seconds 30
  agentlink work team add --connection <id> --name alice --project app --route frontend
  agentlink work team list
  agentlink work activity --refresh --format table
  agentlink work budget authorize --connection <id> --id <work> --request-id <stable-id> --rounds 5 --repeats 3 --elapsed-seconds 3600 --expires-at <UTC-time>
Policies are finite workspace/peer scopes, not an OS sandbox. Check IDs name local
checks; peer text never supplies shell authority. No automatic permission renewal.`;

export async function runWorkCli(args: string[], workspace: string, output: { log(value: string): void }) {
  if (!args.length || args.length === 1 && ['help','--help','-h'].includes(args[0]!)) { output.log(WORK_HELP); return; }
  if (args.length === 1 && args[0] === 'session') { output.log('session-' + randomUUID()); return; }
  if(args[0]==='activity') {
    const options:Record<string,string>={};for(let i=1;i<args.length;i++){const name=args[i]?.slice(2);if(!args[i]?.startsWith('--') || !['connection','format','refresh','archive'].includes(name!) || name! in options)throw new Error(WORK_HELP);if(['refresh','archive'].includes(name!))options[name!]='true';else {const value=args[++i];if(!value || value.startsWith('--'))throw new Error(WORK_HELP);options[name!]=value;}}
    if(options.format!==undefined && !['table','json'].includes(options.format))throw new Error('Activity format must be table or json');
    const view=await workActivity(workspace,{refresh:options.refresh==='true',includeArchived:options.archive==='true',...(options.connection?{connection:validateNetworkId(options.connection,'connection')}:{})},'activity-'+randomUUID());
    output.log(options.format==='json'?JSON.stringify(view):renderWorkActivity(view));return;
  }
  if(args[0]==='team') {
    if(args.length===2 && args[1]==='list'){output.log(JSON.stringify({contacts:await listWorkPeers(workspace)}));return;}
    const options:Record<string,string>={};for(let i=2;i<args.length;i+=2){const name=args[i]?.slice(2),value=args[i+1];if(!args[i]?.startsWith('--') || !['connection','name','project','route'].includes(name!) || !value || name! in options)throw new Error(WORK_HELP);options[name!]=value;}
    const selection={name:validateNetworkId(options.name,'contact name'),project:validateNetworkId(options.project,'project'),route:validateNetworkId(options.route,'route')};
    if(args[1]==='add')await nameWorkPeer(workspace,{...selection,connection:validateNetworkId(options.connection,'connection')});
    else if(args[1]==='remove')await removeWorkPeerName(workspace,selection.name,selection.project,selection.route);else throw new Error(WORK_HELP);
    output.log(JSON.stringify({updated:true,...selection,communicationPermissionChanged:false}));return;
  }
  if(args[0]==='budget' && args[1]==='authorize') {
    const options:Record<string,string>={};for(let i=2;i<args.length;i+=2){const name=args[i]?.slice(2),value=args[i+1];if(!args[i]?.startsWith('--') || !['connection','id','request-id','rounds','repeats','elapsed-seconds','expires-at'].includes(name!) || !value || name! in options)throw new Error(WORK_HELP);options[name!]=value;}
    const {connection:c,actor}=await workConnection(workspace,options.connection);
    const item=await authorizeWorkBudget(c.root,validateNetworkId(options.id,'work id'),actor,{requestId:validateNetworkId(options['request-id'],'owner budget request'),limits:{maxReviewRounds:Number(options.rounds),maxRepeatedFindings:Number(options.repeats),maxElapsedSeconds:Number(options['elapsed-seconds'])},deadline:options['expires-at']!});
    output.log(JSON.stringify({item,executionPermissionChanged:false}));return;
  }
  if(args[0]==='checks' && args[1]==='set') {
    const options:Record<string,string>={};for(let i=2;i<args.length;i+=2){const name=args[i]?.slice(2),value=args[i+1];if(!args[i]?.startsWith('--') || !['connection','id','command','args-json','timeout-seconds'].includes(name!) || value===undefined || name! in options)throw new Error(WORK_HELP);options[name!]=value;}
    const {connection:c,other}=await workConnection(workspace,options.connection);
    await writeLocalWorkCheck(c.root,{version:1,id:validateNetworkId(options.id,'check id'),workspace:c.workspace,peerFingerprint:other.fingerprint,command:options.command!,args:JSON.parse(options['args-json']??'[]'),timeoutSeconds:Number(options['timeout-seconds']??60)});
    output.log(JSON.stringify({configured:true,id:options.id,executionStarted:false}));return;
  }
  if(args[0]==='monitor') {
    const options:Record<string,string>={};
    for(let i=1;i<args.length;i+=2){const name=args[i]?.slice(2),value=args[i+1];if(!args[i]?.startsWith('--') || !['connection','session','route'].includes(name!) || !value || value.startsWith('--') || name! in options)throw new Error(WORK_HELP);options[name!]=value;}
    const connection=validateNetworkId(options.connection,'connection'),session=validateNetworkId(options.session,'session'),route=validateNetworkId(options.route,'route');
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
    let token:string|undefined;
    try {
      const opened=await connectionWorkAction(workspace,{action:'inbox-open',connection,route,mode:'native-monitor',leaseSeconds:60},session,controller.signal);token=opened.token as string;
      output.log(JSON.stringify({connection,route,status:'watching',sessionId:session,token,idleWakeVerified:false}));
      let last='';
      while(!controller.signal.aborted) {
        const next=await connectionWorkAction(workspace,{action:'inbox-next',connection,route,token},session,controller.signal);
        const event=next.event as {id:string;token:string}|null,marker=event?event.id+event.token:'';
        if(event && marker!==last)output.log(JSON.stringify({connection,...next,status:'incoming'}));
        last=marker;await pause(1000,undefined,{signal:controller.signal});
      }
    } catch(error){if(!controller.signal.aborted)throw error;}
    finally {
      process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
      if(token)await connectionWorkAction(workspace,{action:'inbox-close',connection,route,token},session).catch(()=>{});
    }
    return;
  }
  const policyAction = args[0] === 'policy' ? args[1] : undefined;
  const tokens = policyAction ? args.slice(2) : args;
  const allowed = policyAction ? ['connection','id',...(policyAction === 'grant' ? ['paths','allow','checks','ttl','expires-at'] : [])] : ['connection','session','request'];
  const options: Record<string,string> = {};
  for (let i=0;i<tokens.length;i+=2) {
    const flag=tokens[i]!, name=flag.slice(2), value=tokens[i+1];
    if (!flag.startsWith('--') || !allowed.includes(name) || value === undefined || value.startsWith('--') || name in options) throw new Error(WORK_HELP);
    options[name]=value;
  }
  const connection = options.connection === undefined ? undefined : validateNetworkId(options.connection,'connection');
  if (policyAction) {
    const c = await readConnection(workspace,validateNetworkId(connection,'connection')), id=validateNetworkId(options.id,'policy id');
    if (policyAction === 'grant') {
      const peer=await resolvePairedPeer(c.root,'peer');
      const scope=parseWorkScope({paths:options.paths?.split(','),permissions:options.allow?.split(','),checks:options.checks ? options.checks.split(',') : []});
      await writeWorkPolicy(c.root,{version:1,id,workspace:c.workspace,peerFingerprint:peer.identity.fingerprint,revoked:false,expiresAt:expiryFromOptions(options,30*86_400_000),...scope});
    } else if (policyAction === 'revoke') await revokeWorkPolicy(c.root,id);
    else if (policyAction !== 'show') throw new Error(WORK_HELP);
    output.log(JSON.stringify(await readWorkPolicy(c.root,id))); return;
  }
  const request: unknown=JSON.parse(options.request ?? 'null');
  if (!request || typeof request !== 'object' || Array.isArray(request) || 'connection' in request || 'sessionId' in request) throw new Error('Work request must be an object without connection/session overrides');
  const session=validateNetworkId(options.session,'live session');
  output.log(JSON.stringify(await workExperienceAction(workspace,{...request,...(connection?{connection}:{})},session)));
}
