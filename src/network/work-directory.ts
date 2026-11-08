import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { assertNotSymlink, atomicWriteFile, withFileLock } from '../atomic.js';
import { connectionDirectory } from './connect.js';
import { resolveActiveParticipant } from '../workspace.js';
import { workConnection } from './work-connection.js';
import { connectionWorkAction } from './work-client.js';
import { validateNetworkId } from './types.js';

interface Contact { name:string;project:string;workspace:string;actor:string;connection:string;route:string;fingerprint:string;nodeId:string; }
async function store(workspace:string) {
  const parent=dirname(await connectionDirectory(workspace));return {file:join(parent,'team-directory.json'),locks:join(parent,'team-directory-locks')};
}
async function read(workspace:string):Promise<Contact[]> {
  const {file}=await store(workspace);await assertNotSymlink(file,'Team directory');
  try {
    if((await stat(file)).size>1024*1024)throw new Error('Team directory exceeds bound');
    const value=JSON.parse(await readFile(file,'utf8'));if(value.version!==1 || !Array.isArray(value.contacts) || value.contacts.length>512)throw new Error('Invalid team directory');
    const seen=new Set<string>();
    for(const contact of value.contacts) {
      if(!contact || typeof contact!=='object' || Object.keys(contact).sort().join(',')!=='actor,connection,fingerprint,name,nodeId,project,route,workspace'
        || typeof contact.workspace!=='string' || !isAbsolute(contact.workspace) || contact.workspace.includes('\0')
        || typeof contact.fingerprint!=='string' || !/^sha256:[a-f0-9]{64}$/.test(contact.fingerprint))throw new Error('Invalid team directory contact');
      for(const key of ['actor','connection','name','nodeId','project','route'])validateNetworkId(contact[key],'contact '+key);
      const key=JSON.stringify([contact.workspace,contact.actor,contact.name,contact.project,contact.route]);
      if(seen.has(key))throw new Error('Duplicate team directory contact');seen.add(key);
    }
    return value.contacts;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return [];}
}
export async function nameWorkPeer(workspace:string,input:{connection:string;name:string;project:string;route:string}):Promise<void> {
  validateNetworkId(input.name,'contact name');validateNetworkId(input.route,'route');validateNetworkId(input.project,'project');
  const {connection:c,other}=await workConnection(workspace,input.connection),{file,locks}=await store(workspace);
  await withFileLock(locks,'contacts',async()=>{
    const contacts=await read(workspace),existing=contacts.find(contact=>contact.workspace===c.workspace && contact.actor===c.actor && contact.name===input.name && contact.project===input.project && contact.route===input.route);
    if(existing && (existing.fingerprint!==other.fingerprint || existing.nodeId!==other.nodeId))throw new Error('Contact name is already pinned to a different peer; remove it explicitly before rebinding');
    const contact:Contact={...input,workspace:c.workspace,actor:c.actor,fingerprint:other.fingerprint,nodeId:other.nodeId};
    if(existing)Object.assign(existing,contact);else contacts.push(contact);if(contacts.length>512)throw new Error('Team directory capacity reached');
    await atomicWriteFile(file,JSON.stringify({version:1,contacts}));
  });
}
export async function removeWorkPeerName(workspace:string,name:string,project:string,route:string):Promise<void> {
  [name,project,route].forEach(value=>validateNetworkId(value,'contact selector'));const canonical=await realpath(workspace),actor=(await resolveActiveParticipant(canonical)).participantId,{file,locks}=await store(workspace);
  await withFileLock(locks,'contacts',async()=>{const contacts=(await read(workspace)).filter(contact=>!(contact.workspace===canonical && contact.actor===actor && contact.name===name && contact.project===project && contact.route===route));await atomicWriteFile(file,JSON.stringify({version:1,contacts}));});
}
export async function listWorkPeers(workspace:string) {
  const canonical=await realpath(workspace),actor=(await resolveActiveParticipant(canonical)).participantId;
  return (await read(workspace)).filter(contact=>contact.workspace===canonical && contact.actor===actor).map(({workspace,actor,...contact})=>contact);
}
export async function resolveWorkPeer(workspace:string,input:{name:string;project?:string;capabilities:string[];queueIfOffline:boolean},sessionId:string,signal?:AbortSignal) {
  validateNetworkId(input.name,'contact name');if(input.project!==undefined)validateNetworkId(input.project,'project');
  if(!Array.isArray(input.capabilities) || input.capabilities.length>16 || typeof input.queueIfOffline!=='boolean')throw new Error('Invalid named routing requirements');input.capabilities.forEach(value=>validateNetworkId(value,'capability'));
  const contacts=(await listWorkPeers(workspace)).filter(contact=>contact.name===input.name && (input.project===undefined || contact.project===input.project));
  if(!contacts.length)throw new Error('Unknown team contact in this local workspace; name an already paired peer first');
  const matches=[];
  for(const contact of contacts) {
    const {connection:c,other}=await workConnection(workspace,contact.connection);
    if(other.fingerprint!==contact.fingerprint || other.nodeId!==contact.nodeId)throw new Error('Named peer identity changed; routing refused');
    const presence=await connectionWorkAction(workspace,{action:'presence',connection:c.id},sessionId,signal);
    const route=(presence.routes as Array<{route:string;project:string|null;capabilities:string[];availability:string}>).find(value=>value.route===contact.route);
    if(!route || input.capabilities.some(capability=>!route.capabilities.includes(capability)))continue;
    if(route.project && route.project!==contact.project)continue;
    if(route.availability==='offline' && !input.queueIfOffline)continue;
    matches.push({...contact,availability:route.availability,capabilities:route.capabilities,capabilitiesArePeerDeclarations:true});
  }
  if(matches.length!==1)throw new Error(matches.length?'Ambiguous team route; select a project or narrower capabilities':'No available advertised route matches the requested capabilities; inspect presence or explicitly queue for an offline route');
  return matches[0]!;
}
