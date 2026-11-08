import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNotSymlink } from '../atomic.js';
import { connectAction } from './connect.js';
import { connectionWorkAction } from './work-client.js';
import { workConnection } from './work-connection.js';
import { listWorkItems,type WorkItem } from './work-items.js';

const same=(a:WorkItem['origin'],b:WorkItem['origin'])=>a.nodeId===b.nodeId && a.actorId===b.actorId && a.fingerprint===b.fingerprint;
async function records(path:string) {
  await assertNotSymlink(path,'Activity metadata');let names:string[]=[];
  try{names=await readdir(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const out=[];
  for(const name of names)if(name.endsWith('.json') && name!=='assignments.json') {
    const file=join(path,name);await assertNotSymlink(file,'Activity metadata');if((await stat(file)).size>2*1024*1024)throw new Error('Activity record exceeds bound');
    out.push(JSON.parse(await readFile(file,'utf8')));
  }
  return out;
}
export async function workActivity(workspace:string,input:{connection?:string;refresh:boolean;includeArchived:boolean},sessionId:string,signal?:AbortSignal) {
  if(typeof input.refresh!=='boolean' || typeof input.includeArchived!=='boolean')throw new Error('Invalid activity options');
  const status=await connectAction(workspace,{action:'status'}),connections=(status.connections as Array<{id:string;status:string}>).filter(c=>input.connection===undefined || c.id===input.connection);
  const rows=[],sources=[];
  for(const connection of connections) {
    try {
      const {connection:c,actor}=await workConnection(workspace,connection.id);let peerCheck='cached';const fresh=new Map<string,number>();let nextOffset:unknown=null;
      if(input.refresh) {
        try {
          const syncSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(4000)]):AbortSignal.timeout(4000);
          const page=await connectionWorkAction(workspace,{action:'sync',connection:c.id,offset:0,includeArchived:input.includeArchived},sessionId,syncSignal);nextOffset=page.nextOffset;peerCheck='ok';
          for(const value of page.versions as Array<{id:string;version:number}>)fresh.set(value.id,value.version);
        }catch(error){signal?.throwIfAborted();peerCheck=(error as {statusCode?:number}).statusCode===403?'denied':'unavailable';}
      }
      const inbox=await records(join(c.root,'work-inbox'));
      const local:Array<{item:WorkItem;location:'local'|'peer';observedAt:string|null}>=(await listWorkItems(c.root,actor,input.includeArchived)).filter(item=>same(item.owner,actor)).map(item=>({item,location:'local',observedAt:null}));
      for(const row of await records(join(c.root,'work-client','cache'))) {
        const cached=await connectionWorkAction(workspace,{action:'get',connection:c.id,location:'cache',id:row.item?.id},sessionId,signal);
        const item=cached.item as WorkItem;if(!item || !same(item.origin,actor))throw new Error('Activity cache belongs to another actor');
        if(!input.includeArchived && ['done','declined','cancelled'].includes(item.state))continue;
        local.push({item,location:'peer',observedAt:row.observedAt});
      }
      for(const {item,location,observedAt} of local) {
        const incoming=item.events.filter(event=>!same(event.actor,actor)).at(-1);
        const seen=inbox.some(consumer=>consumer.pending?.source===location && consumer.pending.workId===item.id && ['observed','blocked'].includes(consumer.pending.state)
          || (consumer.cursors?.[location+':'+item.id]??0)>=(incoming?.sequence??Number.MAX_SAFE_INTEGER));
        const ownerResponse=item.events.some(event=>same(event.actor,item.owner) && !['budget-authorized','budget-notice'].includes(event.type));
        const observed=seen || ownerResponse;
        const phase=['done','declined','cancelled'].includes(item.state)?'completed':item.claim?'working':observed?'observed':'delivered';
        const findings=item.findings.filter(finding=>finding.status==='open');
        const blocker=item.budget?.escalation?.reason??item.blockedReason??null;
        const nextAction=item.budget?.escalation?.question??(findings.length?`Resolve ${findings.map(finding=>finding.id).join(', ')}`:item.state==='verified'?'Record verified completion':item.state==='done'?'Integrate or retain the verified result':item.context.nextAction);
        rows.push({connection:c.id,developer:c.label,id:item.id,title:item.title,kind:item.kind,owner:item.owner.actorId,state:item.state,version:item.version,location,
          source:location==='local'?'local-authority':fresh.get(item.id)===item.version?'peer':'cache',stale:location==='peer' && fresh.get(item.id)!==item.version,observedAt,phase,delivered:true,observed,processingIsAgentReported:true,openFindings:findings.length,blocker,dependencies:item.dependencies,nextAction,escalation:item.budget?.escalation??null});
      }
      sources.push({connection:c.id,status:connection.status,peerCheck,nextOffset});
    }catch(error){sources.push({connection:connection.id,status:connection.status,peerCheck:'invalid',error:(error as Error).message.slice(0,160)});}
  }
  if(input.connection!==undefined && !connections.length)throw new Error('Unknown activity connection');
  rows.sort((a,b)=>a.connection.localeCompare(b.connection)||a.id.localeCompare(b.id));
  return {rows,sources,transportIsNotCompletion:true};
}
export function renderWorkActivity(view:Awaited<ReturnType<typeof workActivity>>):string {
  const clean=(value:unknown,max=58)=>String(value??'—').replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,max);
  const lines=['WORK | PEER / OWNER | STATE | DELIVERY | FINDINGS | NEXT ACTION'];
  for(const row of view.rows)lines.push([clean(row.id,24),clean(row.developer+' / '+row.owner,28),clean(row.state,18),clean(row.phase+(row.stale?' (cached)':''),22),row.openFindings,clean(row.blocker??row.nextAction)].join(' | '));
  if(!view.rows.length)lines.push('No matching work.');
  for(const source of view.sources)if(source.peerCheck!=='ok')lines.push(`Connection ${clean(source.connection,40)}: peer ${clean(source.peerCheck)}; cached rows are explicitly marked.`);
  lines.push('Delivery is not completion; processing and completion are agent-reported states.');return lines.join('\n');
}
