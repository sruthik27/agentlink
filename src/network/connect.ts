import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { atomicWriteFile, assertNotSymlink, withFileLock } from '../atomic.js';
import { collectRepoContext } from '../context.js';
import { resolveActiveParticipant } from '../workspace.js';
import { initializeNodeIdentity } from './identity.js';
import { callRemoteAgentLinkTool } from '../mcp/remote-tools.js';
import { validateNetworkId } from './types.js';
import { AuthenticatedRequestError, type AuthenticatedRequestOptions } from './a2a.js';
import { listLocalGrantSummaries,authorizeGrantExpiry } from './trust.js';
import { resolvePairedPeer } from './config.js';
import { authorizeCollaborationExpiry } from './collaboration.js';
import { expiryFromOptions } from './expiry.js';

export interface ConnectionRecord {
  version: 1; id: string; workspace: string; actor: string; root: string;
  role: 'invite' | 'accept'; host: string; targetIp: string; label: string;
  expiresAt: string; inviteExpiresAt: string; status: 'starting' | 'waiting' | 'connected' | 'stopped' | 'failed';
  pid?: number; address?: string; peerActor?: string; peerNode?: string;
  claimHash?: string; error?: string;
}
export interface ConnectionCode {
  v: 1; host: string; port: number; pin: string; token: string; id: string; expires: string; until: string;
}
export const CONNECT_HELP = `AgentLink connection setup (run from your current repository)
  agentlink connect --to <developer-label> --ip <peer-ip>
      Return one single-use code to send privately to that developer (valid 10 minutes).
  agentlink connect --code <AL1-code>
      Accept that invitation from this repository; identities, grants and listener are automatic.
  agentlink connect status
  agentlink connect send --connection <id> --body <text> [--request-id <stable-id>]
  agentlink connect receive --connection <id>
  agentlink connect wait --connection <id> --after <audit-sequence> [--timeout-seconds <1-25>]
  agentlink connect monitor --connection <id> [--after <audit-sequence>]
      Stream incoming event references for your agent's native background/Monitor tool until stop/expiry.
  agentlink connect stop --connection <id>
  agentlink connect reconnect --connection <id>
      Recover a crashed helper using the same identity, address and unchanged authorization.
  agentlink connect resume --connection <id>
      Explicit local-owner resume after stop, only within existing finite authorization.
  agentlink connect authorize --connection <id> --request-id <stable-id> --ttl 2h
      Local owner only: authorize another finite window for this same pinned peer.
      Run on both hosts after stopping helpers; then resume. No new pairing code.
Communication lasts at most two hours, never renews itself, and does not authorize code execution.
Both hosts must be directly reachable by IP. No SSH, firewall changes, public directory or relay.
Any agent with terminal access can use these commands; MCP clients can use agentlink_connect.`;

export function parseConnectionCode(code: unknown): ConnectionCode {
  if (typeof code !== 'string' || code.length > 2048 || !/^AL1-[A-Za-z0-9_-]+$/.test(code)) throw new Error('Invalid AgentLink connection code');
  let c: ConnectionCode;
  try { c = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString('utf8')); }
  catch { throw new Error('Invalid AgentLink connection code'); }
  if (!c || Object.keys(c).sort().join(',') !== 'expires,host,id,pin,port,token,until,v'
    || c.v !== 1 || !isIP(c.host) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535
    || typeof c.pin !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(c.pin)
    || typeof c.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.token)) throw new Error('Invalid AgentLink connection code');
  validateNetworkId(c.id, 'connection id');
  const now = Date.now();
  if (typeof c.expires !== 'string' || typeof c.until !== 'string'
    || !Number.isFinite(Date.parse(c.expires)) || new Date(c.expires).toISOString() !== c.expires
    || !Number.isFinite(Date.parse(c.until)) || new Date(c.until).toISOString() !== c.until
    || Date.parse(c.expires) <= now || Date.parse(c.until) <= now
    || Date.parse(c.expires) > now + 600_000 || Date.parse(c.until) > now + 7_200_000
    || Date.parse(c.expires) > Date.parse(c.until)) throw new Error('Connection code expired or exceeds its finite lifetime');
  return c;
}

export async function connectionDirectory(workspace: string): Promise<string> {
  const canonical = await realpath(workspace);
  const actor = (await resolveActiveParticipant(canonical)).participantId;
  const hash = createHash('sha256').update(canonical + '\0' + actor).digest('hex');
  // Environment override is for owner-controlled installations and isolated tests;
  // neither MCP tool arguments nor a peer can choose a local storage path.
  const home = process.env.AGENTLINK_CONNECTION_HOME ?? join(homedir(), '.local', 'share', 'agentlink', 'connections');
  if (!isAbsolute(home)) throw new Error('Connection storage must be absolute and outside the project');
  await mkdir(home, { recursive: true, mode: 0o700 }); await assertNotSymlink(home, 'Connection storage');
  const actual = await realpath(home);
  const git = (await collectRepoContext(canonical)).git.root;
  for (const protectedRoot of new Set([canonical, ...(git ? [await realpath(git)] : [])])) {
    const rel = relative(protectedRoot, actual);
    if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) throw new Error('Connection storage must be outside the project and repository');
  }
  const directory = join(actual, hash);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await assertNotSymlink(directory, 'Connection directory');
  return directory;
}

async function routeHost(ip: string): Promise<string> {
  if (!isIP(ip)) throw new Error('Supply a literal reachable peer IP address');
  const socket = createSocket(isIP(ip) === 6 ? 'udp6' : 'udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject); socket.connect(9, ip, resolve);
    });
    return socket.address().address;
  } finally { socket.close(); }
}

export async function readConnection(workspace: string, id: string): Promise<ConnectionRecord> {
  validateNetworkId(id, 'connection id');
  const directory = await connectionDirectory(workspace);
  const root = join(directory, id);
  await assertNotSymlink(root, 'Connection root'); await assertNotSymlink(join(root, 'connection.json'), 'Connection metadata');
  const c = JSON.parse(await readFile(join(root, 'connection.json'), 'utf8')) as ConnectionRecord;
  const actor = (await resolveActiveParticipant(workspace)).participantId;
  if (c.version !== 1 || c.id !== id || c.root !== root || c.workspace !== await realpath(workspace) || c.actor !== actor) throw new Error('Connection does not belong to this project and actor');
  return c;
}

function publicStatus(c: ConnectionRecord) {
  let alive = false;
  if (c.pid) { try { process.kill(c.pid, 0); alive = true; } catch { /* no active daemon */ } }
  const status = Date.parse(c.expiresAt) <= Date.now() ? 'expired' : !alive && ['waiting', 'connected', 'starting'].includes(c.status)
    // The helper can exit between listener shutdown and its final metadata write.
    // A missing process plus the durable owner stop is a completed transport stop.
    ? existsSync(join(c.root, 'stop')) ? 'stopped' : 'offline' : c.status;
  return { id: c.id, developer: c.label, status, expiresAt: c.expiresAt, peerActor: c.peerActor,
    communicationOnly: true, automaticWake: false, ...(c.error ? { error: c.error } : {}) };
}

export function connectionConsumerInstructions(id: string, workspace: string, actor: string) {
  validateNetworkId(id, 'connection');
  return {
    nativeMonitorCommand: [process.execPath, fileURLToPath(new URL('../cli.js', import.meta.url)), 'connect', 'monitor', '--connection', id],
    nativeMonitorCwd: workspace,
    nativeMonitorEnv: { AGENTLINK_PARTICIPANT_ID: actor },
    instruction: 'Keep communication active without asking the human to check an inbox. Read pending messages and retain the latest audit sequence. If this harness has a native Monitor/background tool that wakes this same session on stdout, start nativeMonitorCommand in nativeMonitorCwd with nativeMonitorEnv and --after <sequence> using that tool now. On incoming event references, receive, process and reply as needed; do not reply to your own messages or create acknowledgement loops. Re-arm only within the unchanged connection expiry if the native tool deadline ends. A detached shell process alone does not wake a model. If native background wake is unavailable, continue bounded wait calls while active and state that idle wake is unavailable. Do not start a second model worker or renew permissions automatically.',
    idleWakeVerified: false,
    workInbox: { tool:'agentlink_work',arguments:{action:'inbox-open',connection:id,route:'main',mode:'native-monitor',leaseSeconds:60},instruction:'For handoff, review, delegation or investigation, open this durable work inbox and start its returned native Monitor command automatically when supported. Its session lease and acknowledgements survive restart. Use active-poll if idle stdout wake is unavailable; locally configured --work-channel servers consume this route automatically.' },
  };
}

/** A stdout consumer for an existing native agent, never a competing model worker. */
export async function monitorConnection(workspace: string, id: string, emit: (event: Record<string, unknown>) => void, after?: number, signal?: AbortSignal): Promise<void> {
  if (after !== undefined && (!Number.isInteger(after) || after < 0)) throw new Error('monitor after must be nonnegative');
  let connection = await readConnection(workspace, id);
  if (publicStatus(connection).status === 'waiting') {
    emit({ id, status: 'waiting-for-developer', expiresAt: connection.expiresAt });
    while (publicStatus(connection).status === 'waiting') {
      try { await pause(250, undefined, { signal }); } catch (error) { if (signal?.aborted) return; throw error; }
      connection = await readConnection(workspace, id);
    }
    // Include all newly paired peer events; no old connection is being replayed.
    if (after === undefined) after = 0;
  }
  const initialStatus = publicStatus(connection).status;
  if (['stopped', 'expired', 'offline', 'failed'].includes(initialStatus)) { emit({ id, status: initialStatus }); return; }
  let cursor = after;
  if (cursor === undefined) {
    const current = await connectAction(workspace, { action: 'receive', connection: id }, signal);
    const audit = (current.snapshot as { audit: Array<{ sequence: number }> }).audit;
    cursor = audit.at(-1)?.sequence ?? 0;
  }
  emit({ id, status: 'watching', after: cursor, expiresAt: connection.expiresAt, observationIsNotProcessing: true });
  let unavailable = false;
  while (!signal?.aborted) {
    const state = await readConnection(workspace, id), status = publicStatus(state).status;
    if (['stopped', 'expired', 'offline', 'failed'].includes(status)) { emit({ id, status }); return; }
    let response: Record<string, unknown>;
    try { response = await connectAction(workspace, { action: 'wait', connection: id, after: cursor, timeoutSeconds: 25 }, signal); }
    catch (error) {
      if (signal?.aborted) return;
      const status = publicStatus(await readConnection(workspace, id)).status;
      if (['stopped', 'expired', 'offline', 'failed'].includes(status)) { emit({ id, status }); return; }
      throw error;
    }
    if (response.connectionCheck === 'unavailable') {
      if (!unavailable) emit({ id, status: 'retrying', after: cursor });
      unavailable = true;
      continue;
    }
    if (unavailable) { emit({ id, status: 'watching', after: cursor }); unavailable = false; }
    const audit = (response.snapshot as { audit: Array<{ sequence: number; actor: { nodeId: string; agentId: string }; operation: { type: string } }> }).audit;
    const incoming = audit.filter(row => row.sequence > cursor! && row.actor.nodeId === connection.peerNode && row.actor.agentId === connection.peerActor && row.operation.type !== 'read');
    cursor = Math.max(cursor!, audit.at(-1)?.sequence ?? 0);
    if (incoming.length) emit({ id, status: 'incoming', after: cursor, sequences: incoming.map(row => row.sequence), observationIsNotProcessing: true });
  }
}

async function launch(c: ConnectionRecord, code?: string, resume = false): Promise<Record<string, unknown>> {
  const entry = fileURLToPath(new URL('./connect-daemon.js', import.meta.url));
  const child = fork(entry, [join(c.root, 'connection.json')], {
    cwd: c.workspace, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Connection setup timed out; inspect connect status before trying again')), 20000);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (child.connected) child.disconnect();
      if (error) { child.kill('SIGTERM'); reject(error); } else { child.unref(); resolve(value!); }
    };
    child.once('error', error => finish(error));
    child.once('exit', () => finish(new Error('Connection helper exited before setup completed')));
    child.on('message', (message: Record<string, unknown>) => {
      if (message.error) finish(new Error(String(message.error)));
      else if (message.ready) finish(undefined, message);
    });
    child.send({ start: true, ...(resume ? { resume: true } : {}), ...(code ? { code } : {}) });
  });
}

/** A transport restart reuses durable pins/grants. It never repeats pairing or extends access. */
export async function reconnectConnection(workspace:string,id:string,resumeOwnerStop=false):Promise<Record<string,unknown>> {
  const original=await readConnection(workspace,id);
  return withFileLock(join(original.root,'locks'),'connection-lifecycle',async()=>{
    const c=await readConnection(workspace,id),status=publicStatus(c).status;
    if(status==='connected') return {...publicStatus(c),consumer:connectionConsumerInstructions(c.id,c.workspace,c.actor)};
    if(Date.parse(c.expiresAt)<=Date.now() || !c.peerNode || !c.peerActor || !c.address) throw new Error('Connection is unpaired or authorization expired; explicit owner authorization required');
    if(existsSync(join(c.root,'stop')) && !resumeOwnerStop) throw new Error('Connection was stopped by its owner; reconnect will not undo owner stop');
    if(c.pid) {try {process.kill(c.pid,0);throw new Error('Connection helper is still running; wait for its shutdown before resuming');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
    const peer=await resolvePairedPeer(c.root,'peer');
    const grant=(await listLocalGrantSummaries(c.root,c.actor)).find(g=>g.grantId==='connection');
    if(!grant || grant.revoked || !grant.peerIdentityMatches || grant.remoteNodeId!==c.peerNode || grant.remoteAgentId!==c.peerActor || grant.conversationId!==c.id || grant.expiresAt!==c.expiresAt || peer.nodeId!==c.peerNode) throw new Error('Connection authorization or pinned peer changed; restart refused');
    if(resumeOwnerStop) await rm(join(c.root,'stop'),{force:true});
    return launch(c,undefined,true);
  });
}

export async function authorizeConnectionAccess(workspace:string,id:string,requestId:string,options:Record<string,string>):Promise<Record<string,unknown>> {
  validateNetworkId(requestId,'owner authorization request');const original=await readConnection(workspace,id);
  return withFileLock(join(original.root,'locks'),'connection-lifecycle',async()=>{
    const c=await readConnection(workspace,id);
    if(!c.peerNode || !c.peerActor || !c.address)throw new Error('Authorize access only for an already paired relationship');
    if(c.pid){try{process.kill(c.pid,0);throw new Error('Stop this connection helper before changing its finite authorization');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
    const peer=await resolvePairedPeer(c.root,'peer');if(peer.nodeId!==c.peerNode)throw new Error('Pinned connection peer changed');
    const scopedGrant=(await listLocalGrantSummaries(c.root,c.actor)).find(g=>g.grantId==='connection');
    if(!scopedGrant || scopedGrant.revoked || !scopedGrant.peerIdentityMatches || scopedGrant.remoteNodeId!==c.peerNode || scopedGrant.remoteAgentId!==c.peerActor || scopedGrant.conversationId!==c.id)throw new Error('Communication grant was revoked or its scope changed; renewal refused');
    const file=join(c.root,'connection-access-'+requestId+'.json');await assertNotSymlink(file,'Connection authorization receipt');
    let intent:{requestId:string;oldExpiry:string;expiresAt:string;fingerprint:string;input:string;status:string}|undefined;
    const input=JSON.stringify(Object.fromEntries(Object.entries(options).sort()));
    try{intent=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(intent && (intent.requestId!==requestId || intent.fingerprint!==peer.identity.fingerprint || intent.input!==input))throw new Error('Conflicting owner authorization request');
    if(!intent) {
      if((await readdir(c.root)).filter(name=>name.startsWith('connection-access-')).length>=128)throw new Error('Owner authorization receipt capacity reached');
      intent={requestId,oldExpiry:c.expiresAt,expiresAt:expiryFromOptions(options,30*86400_000),fingerprint:peer.identity.fingerprint,input,status:'prepared'};
      await atomicWriteFile(file,JSON.stringify(intent));
    }
    if(![intent.oldExpiry,intent.expiresAt].includes(c.expiresAt))throw new Error('Connection authorization changed after this request');
    if(intent.status==='authorized') {
      if(scopedGrant.expiresAt!==intent.expiresAt || Date.parse(intent.expiresAt)<=Date.now())throw new Error('This owner authorization was superseded or expired; use a new explicitly authorized request');
      return {id:c.id,status:'authorized-stopped',expiresAt:intent.expiresAt,receipt:requestId,executionPermissionChanged:false};
    }
    await authorizeGrantExpiry(c.root,'connection',peer.identity.fingerprint,intent.oldExpiry,intent.expiresAt);
    if(c.role==='invite')await authorizeCollaborationExpiry(c.root,c.id,c.actor,peer.identity.fingerprint,intent.oldExpiry,intent.expiresAt);
    c.expiresAt=intent.expiresAt;c.status='stopped';delete c.error;
    await atomicWriteFile(join(c.root,'connection.json'),JSON.stringify(c));
    await atomicWriteFile(file,JSON.stringify({...intent,status:'authorized'}));
    return {id:c.id,status:'authorized-stopped',expiresAt:c.expiresAt,receipt:requestId,executionPermissionChanged:false,instruction:'The other host must authorize its own finite window. Resume this connection with local owner intent; the same identities, routes and work are preserved. No execution policy was renewed.'};
  });
}

export async function connectAction(workspace: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const allowed = ['action', 'to', 'ip', 'code', 'connection', 'body', 'requestId', 'after', 'timeoutSeconds'];
  if (Object.keys(args).some(k => !allowed.includes(k))) throw new Error('Unsupported connection argument');
  const action = args.action ?? (args.code ? 'accept' : args.ip ? 'invite' : 'status');
  const fields: Record<string, string[]> = { invite: ['to','ip'], accept: ['code'], status: [], send: ['connection','body','requestId'], receive: ['connection'], wait: ['connection','after','timeoutSeconds'], stop: ['connection'], reconnect:['connection'],resume:['connection'] };
  if (typeof action !== 'string' || !fields[action] || Object.keys(args).some(k => k !== 'action' && !fields[action].includes(k))) throw new Error('Arguments do not match the requested connection action');
  if (action === 'invite' || action === 'accept') {
    const parsed = action === 'accept' ? parseConnectionCode(args.code) : undefined;
    const ip = parsed?.host ?? args.ip;
    if (typeof ip !== 'string' || !isIP(ip)) throw new Error('Supply the developer\'s literal reachable IP address');
    const label = parsed ? 'inviting developer' : args.to;
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error('Supply a developer label of 1–80 characters');
    const directory = await connectionDirectory(workspace);
    const existing = await readdir(directory);
    if (existing.length >= 32) throw new Error('Connection capacity reached; retain existing records and use a new owner-controlled connection store');
    const id = parsed?.id ?? 'c-' + randomUUID();
    const root = join(directory, id);
    const c: ConnectionRecord = { version: 1, id, root, workspace: await realpath(workspace),
      actor: (await resolveActiveParticipant(workspace)).participantId, role: parsed ? 'accept' : 'invite',
      host: await routeHost(ip), targetIp: ip, label, status: 'starting',
      expiresAt: parsed?.until ?? new Date(Date.now() + 7_200_000).toISOString(),
      inviteExpiresAt: parsed?.expires ?? new Date(Date.now() + 600_000).toISOString() };
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This invitation already has a local connection record. Use connect status before asking for a fresh code; uncertain effects are never replayed automatically.');
      throw error;
    }
    await atomicWriteFile(join(root, 'connection.json'), JSON.stringify(c));
    await initializeNodeIdentity(root, 'n-' + randomUUID());
    return launch(c, parsed ? args.code as string : undefined);
  }
  if (action === 'status') {
    const directory = await connectionDirectory(workspace);
    const records = [];
    for (const name of await readdir(directory)) records.push(publicStatus(await readConnection(workspace, name)));
    return { connections: records };
  }
  const c = await readConnection(workspace, validateNetworkId(args.connection, 'connection'));
  if(action==='reconnect' || action==='resume') return reconnectConnection(workspace,c.id,action==='resume');
  if (action === 'stop') {
    await atomicWriteFile(join(c.root, 'stop'), 'owner stop\n');
    return { id: c.id, status: 'stop-requested' };
  }
  if (publicStatus(c).status==='offline') await reconnectConnection(workspace,c.id);
  if (publicStatus(await readConnection(workspace,c.id)).status !== 'connected' || !c.peerActor) throw new Error('Connection is not live; inspect connect status. Do not replay uncertain sends.');
  if (action === 'send' && (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 2000)) throw new Error('Message must contain 1–2000 characters');
  if (action === 'wait' && (!Number.isInteger(args.after) || (args.after as number) < 0
    || (args.timeoutSeconds !== undefined && (!Number.isInteger(args.timeoutSeconds) || (args.timeoutSeconds as number) < 1 || (args.timeoutSeconds as number) > 25)))) throw new Error('wait requires nonnegative after and timeoutSeconds from 1 to 25');
  const operation = action === 'send'
    ? { type: 'discuss', requestId: args.requestId === undefined ? 'send-' + randomUUID() : validateNetworkId(args.requestId, 'requestId'), content: args.body }
    : { type: 'get', requestId: 'read-' + randomUUID() };
  const read = (options?: AuthenticatedRequestOptions) => callRemoteAgentLinkTool('agentlink_collaboration', { peer: 'peer', agent: c.peerActor,
    conversationId: c.id, authority: c.role === 'invite' ? 'local' : 'peer', operation },
  { stateRoot: c.root, agentId: c.actor, workspaceRoot: c.workspace }, options);
  const deadline = Math.min(Date.parse(c.expiresAt), Date.now() + ((args.timeoutSeconds as number | undefined) ?? 25) * 1000);
  let transientFailures = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (action === 'wait' && publicStatus(await readConnection(workspace, c.id)).status !== 'connected') throw new Error('Connection stopped or expired while waiting');
    let response;
    try {
      response = await read(action === 'wait' ? { timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())), signal } : undefined);
    } catch (error) {
      signal?.throwIfAborted();
      if (action !== 'wait' || !isTransientConnectionError(error)) throw error;
      transientFailures++;
      if (publicStatus(await readConnection(workspace, c.id)).status !== 'connected') throw new Error('Connection stopped or expired while waiting');
      if (Date.now() >= deadline) return { id: c.id, changed: false, connectionCheck: 'unavailable', transientFailures, transportIsNotProcessing: true };
      await pause(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal });
      continue;
    }
    signal?.throwIfAborted();
    if (action === 'wait' && publicStatus(await readConnection(workspace, c.id)).status !== 'connected') throw new Error('Connection stopped or expired while waiting');
    const snapshot = response.structuredContent?.snapshot as { audit: Array<{ sequence: number }> } | undefined;
    const changed = action !== 'wait' || !!snapshot?.audit.some(row => row.sequence > (args.after as number));
    if (changed || Date.now() >= deadline) return { id: c.id, ...response.structuredContent, ...(action === 'wait' ? { changed, connectionCheck: 'ok', transientFailures } : {}), transportIsNotProcessing: true };
    await pause(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

function isTransientConnectionError(error: unknown): boolean {
  if (error instanceof AuthenticatedRequestError) return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE'].includes(code);
}

export async function runConnectCli(args: string[], workspace: string, output: { log(value: string): void }) {
  if (args.length === 1 && ['help','--help','-h'].includes(args[0]!)) { output.log(CONNECT_HELP); return; }
  if(args[0]==='authorize') {
    const options:Record<string,string>={};for(let i=1;i<args.length;i+=2){const name=args[i]?.slice(2),value=args[i+1];if(!args[i]?.startsWith('--') || !['connection','request-id','ttl','expires-at'].includes(name!) || !value || value.startsWith('--') || name! in options)throw new Error(CONNECT_HELP);options[name!]=value;}
    const connection=validateNetworkId(options.connection,'connection'),requestId=validateNetworkId(options['request-id'],'owner request');
    const expiryOptions=Object.fromEntries(Object.entries(options).filter(([name])=>['ttl','expires-at'].includes(name)));
    output.log(JSON.stringify(await authorizeConnectionAccess(workspace,connection,requestId,expiryOptions)));return;
  }
  const input: Record<string, unknown> = {};
  if (args[0] && !args[0].startsWith('--')) input.action = args.shift();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !name || !['to','ip','code','connection','body','request-id','after','timeout-seconds'].includes(name)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(CONNECT_HELP);
    const key = name === 'request-id' ? 'requestId' : name === 'timeout-seconds' ? 'timeoutSeconds' : name;
    if (key in input) throw new Error('Duplicate connection option');
    input[key] = ['after','timeoutSeconds'].includes(key) ? Number(args[i + 1]) : args[i + 1];
  }
  if (input.action === 'monitor') {
    if (Object.keys(input).some(k => !['action', 'connection', 'after'].includes(k))) throw new Error('monitor requires connection and optional after');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { await monitorConnection(workspace, validateNetworkId(input.connection, 'connection'), event => output.log(JSON.stringify(event)), input.after as number | undefined, controller.signal); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
    return;
  }
  output.log(JSON.stringify(await connectAction(workspace, input)));
}
