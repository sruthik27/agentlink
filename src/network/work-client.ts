import { mkdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, assertNotSymlink, withFileLock } from '../atomic.js';
import { authenticatedRequest } from './a2a.js';
import { readConnection, reconnectConnection } from './connect.js';
import { resolvePairedPeer } from './config.js';
import { exportPublicIdentity } from './identity.js';
import { sha256, validateNetworkId } from './types.js';
import { exportWorkFile, getWorkArtifact, getWorkArtifactPart, parseWorkArtifact, putWorkArtifact, workPath, WORK_ARTIFACT_PART_BYTES, type WorkArtifact } from './work-artifacts.js';
import { withWorkPolicy } from './work-policy.js';
import { openWorkConsumer, nextWorkEvent, acknowledgeWorkEvent, closeWorkConsumer, workInboxStatus, routeWorkInbox, type WorkConsumerMode } from './work-inbox.js';
import { boundedWorkWrite,maintainWorkStorage } from './work-storage.js';
import { parseWorkBudget } from './work-budgets.js';
import { listWorkItems, operateWorkItem, parseNewWork, readWorkItem, stableWorkValue, workPrincipal, type WorkItem, type WorkPrincipal } from './work-items.js';

const key = (p: WorkPrincipal) => `${p.nodeId}/${p.actorId}/${p.fingerprint}`;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected work client object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('Unsupported or missing work client fields');
}

/** Separate from the recipient's authoritative store. Cached work never grants local execution. */
export async function connectionWorkAction(workspace: string, args: Record<string, unknown>, sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  validateNetworkId(sessionId, 'live session');
  const c = await readConnection(workspace, validateNetworkId(args.connection, 'connection'));
  if (!c.peerActor || !c.peerNode) throw new Error('Connection pairing is not complete');
  const [identity, peer] = await Promise.all([exportPublicIdentity(c.root), resolvePairedPeer(c.root, 'peer')]);
  if (c.peerNode !== peer.identity.nodeId) throw new Error('Connection peer identity mismatch');
  const actor = { nodeId: identity.nodeId, actorId: c.actor, fingerprint: identity.fingerprint };
  const other = { nodeId: peer.identity.nodeId, actorId: c.peerActor, fingerprint: peer.identity.fingerprint };
  const localScope = (item: WorkItem) => {
    if (key(item.owner) !== key(actor) || key(item.origin) !== key(other)) throw new Error('Work does not belong to this connection recipient');
    return item;
  };
  const action = args.action;
  if(action==='maintenance'){exact(args,['action','connection']);return maintainWorkStorage(c.root,{force:true});}
  await maintainWorkStorage(c.root);
  const writeRecord=(file:string,content:string)=>boundedWorkWrite(c.root,file,content);
  const wire = async (request: Record<string, unknown>) => {
    signal?.throwIfAborted();
    const current = await readConnection(workspace, c.id);
    if(current.status==='connected' && !existsSync(join(c.root,'stop')) && Date.parse(current.expiresAt)>Date.now() && current.pid) {
      try {process.kill(current.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')await reconnectConnection(workspace,c.id);else throw error;}
    }
    if (current.status !== 'connected' || existsSync(join(c.root, 'stop')) || Date.parse(current.expiresAt) <= Date.now()) throw new Error('Connection stopped or expired; remote work is unavailable');
    const input = { senderActor: c.actor, recipientActor: c.peerActor, connection: c.id, request };
    const response = object(await authenticatedRequest(c.root, peer.address + '/v1/work', peer.identity, 'POST', input, { signal }));
    exact(response, ['requestHash','result']);
    if (response.requestHash !== sha256(JSON.stringify(input))) throw new Error('Work response correlation mismatch');
    return object(response.result);
  };
  const client = join(c.root, 'work-client');
  await assertNotSymlink(client, 'Work client'); await mkdir(client, { recursive: true, mode: 0o700 });
  const cache = join(client, 'cache'), requests = join(client, 'requests');
  for (const directory of [cache, requests]) { await assertNotSymlink(directory, 'Work client directory'); await mkdir(directory, { recursive: true, mode: 0o700 }); }
  const fileJson = async (file: string) => {
    await assertNotSymlink(file, 'Work client record');
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('Work client record exceeds bound');
    return object(JSON.parse(await readFile(file, 'utf8')));
  };
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
  const download = async (id: string, value: unknown) => {
    const ref = parseWorkArtifact(value), chunks: Buffer[] = [];
    for (let offset = 0; offset < Math.max(1, ref.bytes); offset += WORK_ARTIFACT_PART_BYTES) {
      const part = await wire({ action: 'artifact-get', id, artifact: ref, offset });
      exact(part, ['data','nextOffset','complete']);
      if (typeof part.data !== 'string' || part.data.length > WORK_ARTIFACT_PART_BYTES * 2) throw new Error('Invalid work artifact chunk');
      const bytes = Buffer.from(part.data, 'base64'), size = Math.min(WORK_ARTIFACT_PART_BYTES, ref.bytes - offset);
      if (bytes.toString('base64') !== part.data || bytes.length !== size || part.nextOffset !== offset + size || part.complete !== (offset + size === ref.bytes)) throw new Error('Invalid work artifact offset/encoding');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== ref.bytes || sha256(bytes) !== ref.digest) throw new Error('Work artifact digest/size mismatch');
    return bytes;
  };
  const validateSnapshot = (value: unknown, id: string): WorkItem => {
    const v = object(value);
    if (v.schemaVersion !== 1 || v.id !== id || !Number.isSafeInteger(v.version) || (v.version as number) < 1 || !Array.isArray(v.events) || v.events.length !== v.version || v.events.length > 1024) throw new Error('Invalid remote work snapshot version/events');
    const { id: parsedId } = parseNewWork(Object.fromEntries(['id','kind','title','goal','criteria','origin','owner','scope','reviewRequired','dependencies','context',...(v.limits===undefined?[]:['limits'])].map(field => [field, v[field]])));
    if (parsedId !== id || key(workPrincipal(v.origin)) !== key(actor) || key(workPrincipal(v.owner)) !== key(other)) throw new Error('Remote work snapshot belongs to another connection');
    if (!['queued','accepted','working','blocked','review','changes-requested','verified','done','declined','cancel-requested','cancelled'].includes(v.state as string)) throw new Error('Invalid remote work state');
    if(v.budget!==undefined)parseWorkBudget(v.budget);
    for (const [index, row] of v.events.entries()) {
      const event = object(row), principal = workPrincipal(event.actor);
      if (event.sequence !== index + 1 || ![key(actor), key(other)].includes(key(principal)) || typeof event.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(event.hash)) throw new Error('Invalid remote work event');
      validateNetworkId(event.requestId, 'receipt request id');
    }
    return v as unknown as WorkItem;
  };
  const cached = async (id: string) => {
    const row = await fileJson(join(cache, id + '.json'));
    if (typeof row.observedAt !== 'string') throw new Error('Invalid work cache timestamp');
    return { item: validateSnapshot(row.item, id), observedAt: row.observedAt };
  };
  const receiptItem=async(record:Record<string,unknown>,id:string,requestId:string)=>{
    const item=record.item?validateSnapshot(record.item,id):(await cached(id)).item;
    if(!item.events.some(event=>event.requestId===requestId && (record.receiptHash===undefined || event.hash===record.receiptHash) && key(event.actor)===key(actor)))throw new Error('Retained work receipt does not match cached history');
    return item;
  };
  const snapshot = async (id: string, result: Record<string, unknown>) => {
    exact(result, ['snapshot']); const ref = parseWorkArtifact(result.snapshot);
    if (ref.mediaType !== 'application/json' || !ref.name.startsWith(`work-state/${id}/`)) throw new Error('Invalid work snapshot reference');
    const item = validateSnapshot(JSON.parse((await download(id, ref)).toString('utf8')), id);
    if (ref.name !== `work-state/${id}/${item.version}.json`) throw new Error('Work snapshot version/reference mismatch');
    await withFileLock(join(client, 'locks'), 'cache-' + id, async () => {
      let previous;
      try { previous = await cached(id); } catch (error) { if (!missing(error)) throw error; }
      if (previous && (item.version < previous.item.version || previous.item.events.some((event, index) => stableWorkValue(event) !== stableWorkValue(item.events[index])) || item.version === previous.item.version && stableWorkValue(item) !== stableWorkValue(previous.item))) throw new Error('Remote work history rollback or conflict');
      await writeRecord(join(cache, id + '.json'), JSON.stringify({ observedAt: new Date().toISOString(), item }));
    });
    return item;
  };
  const upload = async (ref: WorkArtifact) => {
    await getWorkArtifact(c.root, ref);
    for (let offset = 0; offset < Math.max(1, ref.bytes); offset += WORK_ARTIFACT_PART_BYTES) {
      const part = await getWorkArtifactPart(c.root, ref, offset);
      const receipt = await wire({ action: 'artifact-put', artifact: ref, offset, data: part.data });
      exact(receipt, ['complete']);
      if (typeof receipt.complete !== 'boolean' || part.complete && !receipt.complete) throw new Error('Incomplete work artifact receipt');
    }
  };
  if(action==='presence') {
    exact(args,['action','connection']);const response=await wire({action:'presence'});exact(response,['routes']);
    if(!Array.isArray(response.routes) || response.routes.length>128)throw new Error('Invalid peer route directory');
    for(const value of response.routes) {
      const route=object(value);exact(route,['route','availability','capabilities','project','mode','expiresAt','idleWakeVerified']);validateNetworkId(route.route,'route');
      if(!['idle','busy','blocked','offline'].includes(route.availability as string) || !Array.isArray(route.capabilities) || route.capabilities.length>16 || route.project!==null && (typeof route.project!=='string' || route.project.length>80) || route.idleWakeVerified!==false)throw new Error('Invalid advertised route capabilities');
      route.capabilities.forEach(capability=>validateNetworkId(capability,'capability'));
      if(route.mode!==null && !['active-poll','native-monitor','channel'].includes(route.mode as string)
        || route.expiresAt!==null && (typeof route.expiresAt!=='string' || !Number.isFinite(Date.parse(route.expiresAt))))throw new Error('Invalid advertised route lease');
    }
    return {source:'peer',routes:response.routes,capabilitiesArePeerDeclarations:true};
  }
  if(action==='sync') {
    exact(args,['action','connection','offset','includeArchived']);
    const page=await connectionWorkAction(workspace,{action:'list',connection:c.id,location:'peer',offset:args.offset,includeArchived:args.includeArchived},sessionId,signal);
    let updated=0;
    for(const row of page.items as Array<{id:string;version:number}>) {
      let version=0;try{version=(await cached(row.id)).item.version;}catch(error){if(!missing(error))throw error;}
      if(row.version>version) {await snapshot(row.id,await wire({action:'get',id:row.id}));updated++;}
      if(row.version<version) throw new Error('Remote work list version rollback');
    }
    return {source:'peer',updated,nextOffset:page.nextOffset,versions:page.items};
  }
  if(action==='inbox-open') {
    exact(args,['action','connection','route','mode','leaseSeconds',...(Object.hasOwn(args,'capabilities')?['capabilities']:[]),...(Object.hasOwn(args,'project')?['project']:[])]);
    return {...await openWorkConsumer(c.root,actor,sessionId,validateNetworkId(args.route,'route'),args.mode as WorkConsumerMode,args.leaseSeconds as number,Date.now(),{...(args.capabilities===undefined?{}:{capabilities:args.capabilities as string[]}),...(args.project===undefined?{}:{project:args.project as string})}),sessionId};
  }
  if(action==='inbox-status') {exact(args,['action','connection']);return {consumers:await workInboxStatus(c.root,actor)};}
  if(action==='inbox-route') {
    exact(args,['action','connection','location','id','route']);
    if(args.location!=='local' && args.location!=='peer') throw new Error('Inbox routing location must be local or peer');
    await routeWorkInbox(c.root,actor,args.location,validateNetworkId(args.id,'work id'),validateNetworkId(args.route,'route'));return {routed:true};
  }
  if(action==='inbox-next') {
    exact(args,['action','connection','route','token']);
    const route=validateNetworkId(args.route,'route');
    if(typeof args.token!=='string')throw new Error('Inbox token required');
    // Poll one bounded peer page, while local delivery continues during outages.
    let remoteCheck='ok',syncOffset=0;const syncFile=join(client,'sync.json');
    try {
      await withFileLock(join(client,'locks'),'sync',async()=>{
        try{const row=await fileJson(syncFile);if(Number.isSafeInteger(row.offset) && (row.offset as number)>=0)syncOffset=row.offset as number;}catch(error){if(!missing(error))throw error;}
        const syncSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(4000)]):AbortSignal.timeout(4000);
        const page=await connectionWorkAction(workspace,{action:'sync',connection:c.id,offset:syncOffset,includeArchived:true},sessionId,syncSignal);
        await writeRecord(syncFile,JSON.stringify({offset:page.nextOffset??0}));
      });
    } catch(error) {
      signal?.throwIfAborted();const code=(error as NodeJS.ErrnoException).code,status=(error as {statusCode?:number}).statusCode,name=(error as Error).name;
      remoteCheck=status===403?'denied':status!==undefined || name==='TimeoutError' || name==='AbortError' || ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','EPIPE'].includes(code??'') || /stopped or expired|authorization expired|owner stop/.test((error as Error).message)?'unavailable':'invalid';
    }
    return {...await nextWorkEvent(c.root,actor,sessionId,route,args.token),remoteCheck};
  }
  if(action==='inbox-ack') {
    exact(args,['action','connection','route','token','eventId','deliveryToken','outcome','summary']);
    if([args.token,args.eventId,args.deliveryToken,args.summary].some(value=>typeof value!=='string')) throw new Error('Invalid inbox acknowledgement fields');
    return acknowledgeWorkEvent(c.root,actor,sessionId,validateNetworkId(args.route,'route'),args.token as string,args.eventId as string,args.deliveryToken as string,args.outcome as 'observed'|'handled'|'blocked',args.summary as string);
  }
  if(action==='inbox-close') {
    exact(args,['action','connection','route','token']);if(typeof args.token!=='string')throw new Error('Inbox token required');
    return closeWorkConsumer(c.root,actor,sessionId,validateNetworkId(args.route,'route'),args.token);
  }
  if (action === 'artifact-create') {
    exact(args, ['action','connection','name','content','mediaType']);
    if (typeof args.content !== 'string') throw new Error('Artifact content must be explicit UTF-8 text');
    if (typeof args.mediaType !== 'string') throw new Error('Artifact media type required');
    return { source: 'local-artifact', artifact: await putWorkArtifact(c.root, Buffer.from(args.content), workPath(args.name), args.mediaType) };
  }
  if (action === 'export') {
    exact(args, ['action','connection','path','policyId']);
    const path = workPath(args.path), policyId = validateNetworkId(args.policyId, 'policy id');
    const artifact = await withWorkPolicy(c.root, policyId, c.workspace, other.fingerprint, { paths: [path], permissions: ['read'], checks: [] }, () => exportWorkFile(c.root, c.workspace, path, [path]));
    return { source: 'local-artifact', artifact };
  }
  if (action === 'reconcile') {
    exact(args, ['action','connection','requestId']);
    const requestId = validateNetworkId(args.requestId, 'request id');
    return withFileLock(join(client, 'locks'), 'request-' + requestId, async () => {
      const path = join(requests, requestId + '.json'), record = await fileJson(path);
      const id = validateNetworkId(record.id, 'work id');
      if (record.status === 'received') return { source: 'receipt', stale: true, requestId, item: await receiptItem(record,id,requestId) };
      if (record.status !== 'uncertain') return { source: 'local-request', requestId, status: record.status };
      const item = await snapshot(id, await wire({ action: 'get', id }));
      if (!item.events.some(event => event.requestId === requestId && event.hash === record.receiptHash && key(event.actor) === key(actor))) return { source: 'peer', requestId, status: 'uncertain', item, replayAllowed: false };
      await writeRecord(path, JSON.stringify({ ...record, status: 'received', version:item.version }));
      return { source: 'peer', requestId, status: 'received', item };
    });
  }
  if (action === 'list') {
    exact(args, ['action','connection','location','includeArchived','offset']);
    if (typeof args.includeArchived !== 'boolean' || !Number.isSafeInteger(args.offset) || (args.offset as number) < 0) throw new Error('Invalid work list options');
    if (args.location === 'local') {
      const items = (await listWorkItems(c.root, actor, args.includeArchived)).map(localScope);
      return { source: 'local-authority', items: items.slice(args.offset as number, (args.offset as number) + 32), nextOffset: (args.offset as number) + 32 < items.length ? (args.offset as number) + 32 : null };
    }
    if (args.location !== 'peer') throw new Error('Work list location must be local or peer');
    const page = await wire({ action: 'list', offset: args.offset, includeArchived: args.includeArchived });
    exact(page, ['items','nextOffset']);
    if (!Array.isArray(page.items) || page.items.length > 32 || page.nextOffset !== null && page.nextOffset !== (args.offset as number) + 32) throw new Error('Invalid peer work list page');
    for (const value of page.items) {
      const item = object(value); exact(item, ['id','kind','title','state','version']);
      validateNetworkId(item.id, 'work id');
      if (typeof item.title !== 'string' || Buffer.byteLength(item.title) > 256 || !Number.isSafeInteger(item.version) || (item.version as number) < 1
        || !['handoff','review','delegate','investigation'].includes(item.kind as string)
        || !['queued','accepted','working','blocked','review','changes-requested','verified','done','declined','cancel-requested','cancelled'].includes(item.state as string)) throw new Error('Invalid peer work summary');
    }
    return { source: 'peer', items: page.items, nextOffset: page.nextOffset };
  }
  if (action === 'artifact') {
    exact(args, ['action','connection','location','id','artifact','offset']);
    const id = validateNetworkId(args.id, 'work id'), ref = parseWorkArtifact(args.artifact);
    if (args.location === 'local') {
      const item = localScope(await readWorkItem(c.root, id, actor));
      const refs = [...item.context.artifacts, ...item.outputs, ...(item.testArtifact ? [item.testArtifact] : []), ...(item.review ? [item.review.evidence] : []), ...item.contributions.flatMap(row => row.artifacts)];
      if (!refs.some(row => row.digest === ref.digest && row.bytes === ref.bytes)) throw new Error('Work artifact is not part of this item');
      return { source: 'local-authority', artifact: ref, ...await getWorkArtifactPart(c.root, ref, args.offset as number) };
    }
    if (args.location !== 'peer') throw new Error('Work artifact location must be local or peer');
    // Verify the complete immutable blob before exposing any downloaded bytes.
    const bytes = await download(id, ref); await putWorkArtifact(c.root, bytes, ref.name, ref.mediaType);
    return { source: 'peer', artifact: ref, ...await getWorkArtifactPart(c.root, ref, args.offset as number) };
  }
  if (action === 'get') {
    exact(args, ['action','connection','location','id']);
    const id = validateNetworkId(args.id, 'work id');
    if (args.location === 'local') return { source: 'local-authority', item: localScope(await readWorkItem(c.root, id, actor)) };
    if (args.location === 'cache') return { source: 'cache', stale: true, ...await cached(id) };
    if (args.location !== 'peer') throw new Error('Work location must be local, peer or cache');
    return { source: 'peer', item: await snapshot(id, await wire({ action: 'get', id })) };
  }
  if (action === 'operate' && args.location === 'local') {
    exact(args, ['action','connection','location','id','operation','policyId']);
    const id = validateNetworkId(args.id, 'work id'); localScope(await readWorkItem(c.root, id, actor));
    return { source: 'local-authority', item: await operateWorkItem(c.root, id, { actor, local: true, workspace: c.workspace, sessionId, ...(args.policyId === null ? {} : { policyId: validateNetworkId(args.policyId, 'policy id') }) }, args.operation) };
  }
  let request: Record<string, unknown>, id: string, requestId: string, refs: WorkArtifact[];
  if (action === 'create') {
    exact(args, ['action','connection','work','requestId']);
    const draft = object(args.work);
    if ('origin' in draft || 'owner' in draft) throw new Error('Work participants are derived from the connection');
    const work = parseNewWork({ ...draft, origin: actor, owner: other });
    id = work.id; requestId = validateNetworkId(args.requestId, 'request id'); refs = work.context.artifacts;
    request = { action: 'create', work, requestId };
  } else if (action === 'operate' && args.location === 'peer') {
    exact(args, ['action','connection','location','id','operation']);
    id = validateNetworkId(args.id, 'work id'); const op = object(args.operation);
    requestId = validateNetworkId(op.requestId, 'request id'); request = { action: 'operate', id, operation: op };
    refs = [...(Array.isArray(op.artifacts) ? op.artifacts.map(parseWorkArtifact) : []), ...(op.testArtifact ? [parseWorkArtifact(op.testArtifact)] : []), ...(op.evidence ? [parseWorkArtifact(op.evidence)] : [])];
  } else throw new Error('Unsupported work action/location');
  // Persist intent before the first write. A timeout never authorizes replay of a mutation.
  return withFileLock(join(client, 'locks'), 'request-' + requestId, async () => {
    const path = join(requests, requestId + '.json'), hash = sha256(stableWorkValue(request));
    let record: Record<string, unknown> | undefined;
    try { record = await fileJson(path); } catch (error) { if (!missing(error)) throw error; }
    if (record && (record.hash !== hash || record.id !== id)) throw new Error('Conflicting outbound work request id');
    if (record?.status === 'received') return { source: 'receipt', stale: true, requestId, item: await receiptItem(record,id,requestId) };
    if (record?.status === 'uncertain') throw new Error('Outbound work request is uncertain; read peer state and reconcile this request id before retrying');
    await writeRecord(path, JSON.stringify({ id, requestId, hash, status: 'prepared' }));
    for (const ref of refs) await upload(ref);
    const receiptHash = sha256(stableWorkValue(action === 'create' ? { type: 'create', draft: request.work } : request.operation));
    await writeRecord(path, JSON.stringify({ id, requestId, hash, receiptHash, status: 'uncertain' }));
    const item = await snapshot(id, await wire(request));
    if (!item.events.some(event => event.requestId === requestId && event.hash === receiptHash && key(event.actor) === key(actor))) throw new Error('Work mutation receipt missing or mismatched');
    await writeRecord(path, JSON.stringify({ id, requestId, hash,receiptHash, status: 'received',version:item.version }));
    return { source: 'peer', requestId, item };
  });
}
