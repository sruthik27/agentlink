import { withDeliveryAuthorization } from './trust.js';
import { sha256, validateNetworkId, type NodePublicIdentity } from './types.js';
import { createWorkItem, readWorkItem, listWorkItems, operateWorkItem, parseNewWork, type WorkItem, type WorkPrincipal } from './work-items.js';
import { getWorkArtifact, getWorkArtifactPart, parseWorkArtifact, putWorkArtifact, putWorkArtifactPart } from './work-artifacts.js';
import { maintainWorkStorage } from './work-storage.js';
import { workInboxStatus } from './work-inbox.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid work protocol object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('Invalid work protocol fields');
}
const principalKey = (p: WorkPrincipal) => `${p.nodeId}/${p.actorId}/${p.fingerprint}`;
function hosted(item: WorkItem, actor: WorkPrincipal, host: WorkPrincipal) {
  if (principalKey(item.origin) !== principalKey(actor) || principalKey(item.owner) !== principalKey(host)) throw new Error('Work protocol scope does not match authenticated peer/host');
}
function refs(item: WorkItem) {
  return [...item.context.artifacts, ...item.outputs, ...(item.testArtifact ? [item.testArtifact] : []), ...(item.review ? [item.review.evidence] : []), ...item.contributions.flatMap(c => c.artifacts)];
}

/** Called only after mTLS pinning; local execution/policy operations are not part of this wire protocol. */
export async function handleWorkProtocol(root: string, peer: NodePublicIdentity, local: NodePublicIdentity, value: unknown): Promise<Record<string, unknown>> {
  const input = object(value); exact(input, ['senderActor','recipientActor','connection','request']);
  const senderActor = validateNetworkId(input.senderActor, 'sender actor'), recipientActor = validateNetworkId(input.recipientActor, 'recipient actor');
  const connection = validateNetworkId(input.connection, 'connection'), request = object(input.request);
  const actor: WorkPrincipal = { nodeId: peer.nodeId, actorId: senderActor, fingerprint: peer.fingerprint };
  const host: WorkPrincipal = { nodeId: local.nodeId, actorId: recipientActor, fingerprint: local.fingerprint };
  const ctx = { actor, local: false, workspace: '', sessionId: 'remote-peer' };
  return withDeliveryAuthorization(root, peer.nodeId, senderActor, recipientActor, connection, async () => {
    await maintainWorkStorage(root);
    const action = request.action;
    const snapshot = async (item: WorkItem) => {
      hosted(item, actor, host);
      return { snapshot: await putWorkArtifact(root, Buffer.from(JSON.stringify(item)), `work-state/${item.id}/${item.version}.json`, 'application/json') };
    };
    let result: Record<string, unknown>;
    if(action==='presence') {
      exact(request,['action']);
      result={routes:(await workInboxStatus(root,host)).map(({route,availability,capabilities,project,mode,expiresAt,idleWakeVerified})=>({route,availability,capabilities,project,mode,expiresAt,idleWakeVerified}))};
    } else if (action === 'create') {
      exact(request, ['action','work','requestId']); const work = parseNewWork(request.work);
      if (principalKey(work.origin) !== principalKey(actor) || principalKey(work.owner) !== principalKey(host)) throw new Error('Work create participants do not match authenticated scope');
      result = await snapshot(await createWorkItem(root, work, ctx, validateNetworkId(request.requestId, 'request id')));
    } else if (action === 'get' || action === 'operate') {
      exact(request, action === 'get' ? ['action','id'] : ['action','id','operation']);
      const id = validateNetworkId(request.id, 'work id'); hosted(await readWorkItem(root, id, actor), actor, host);
      result = await snapshot(action === 'get' ? await readWorkItem(root, id, actor) : await operateWorkItem(root, id, ctx, request.operation));
    } else if (action === 'list') {
      exact(request, ['action','offset','includeArchived']);
      if (!Number.isSafeInteger(request.offset) || (request.offset as number) < 0 || typeof request.includeArchived !== 'boolean') throw new Error('Invalid work list cursor');
      const items = (await listWorkItems(root, actor, request.includeArchived)).filter(item => principalKey(item.owner) === principalKey(host) && principalKey(item.origin) === principalKey(actor)).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const offset = request.offset as number;
      result = { items: items.slice(offset, offset + 32).map(({ id, kind, title, state, version }) => ({ id, kind, title, state, version })), nextOffset: offset + 32 < items.length ? offset + 32 : null };
    } else if (action === 'artifact-put') {
      exact(request, ['action','artifact','offset','data']);
      result = await putWorkArtifactPart(root, request.artifact, request.offset as number, request.data as string);
    } else if (action === 'artifact-get') {
      exact(request, ['action','id','artifact','offset']);
      const item = await readWorkItem(root, validateNetworkId(request.id, 'work id'), actor); hosted(item, actor, host);
      const ref = parseWorkArtifact(request.artifact);
      const visible = refs(item).some(r => r.digest === ref.digest && r.bytes === ref.bytes);
      if (!visible) {
        if (!/^work-state\/[A-Za-z0-9_.-]+\/[0-9]+\.json$/.test(ref.name)) throw new Error('Work artifact not exported in this item');
        const previous = JSON.parse((await getWorkArtifact(root, ref)).toString('utf8')) as WorkItem;
        if (previous.id !== item.id) throw new Error('Work snapshot belongs to another item'); hosted(previous, actor, host);
      }
      result = await getWorkArtifactPart(root, ref, request.offset as number);
    } else throw new Error('Unsupported work protocol action');
    return { requestHash: sha256(JSON.stringify(input)), result };
  });
}
