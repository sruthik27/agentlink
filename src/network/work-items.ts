import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, assertNotSymlink, withFileLock } from '../atomic.js';
import { sha256, validateNetworkId } from './types.js';
import { getWorkArtifact, parseWorkArtifact, type WorkArtifact } from './work-artifacts.js';
import { parseWorkScope, withWorkPolicy, type WorkScope } from './work-policy.js';
import { boundedWorkWrite, withWorkRetention,WORK_STORAGE_LIMITS } from './work-storage.js';
import { initialWorkBudget,budgetBlocked,recordReviewBudget,parseWorkBudgetLimits,type WorkBudget,type WorkBudgetLimits } from './work-budgets.js';

export type WorkKind = 'handoff' | 'review' | 'delegate' | 'investigation';
export type WorkState = 'queued' | 'accepted' | 'working' | 'blocked' | 'review' | 'changes-requested' | 'verified' | 'done' | 'declined' | 'cancel-requested' | 'cancelled';
export interface WorkPrincipal { nodeId: string; actorId: string; fingerprint: string; }
export interface WorkContext { actor: WorkPrincipal; sessionId: string; workspace: string; local: boolean; policyId?: string; }
export interface WorkFinding { id: string; content: string; status: 'open' | 'resolved' | 'dismissed'; }
export interface WorkContribution { id: string; kind: 'observation' | 'hypothesis' | 'experiment' | 'contradiction' | 'uncertainty'; content: string; artifacts: WorkArtifact[]; actor: WorkPrincipal; }
export interface WorkItem {
  schemaVersion: 1; id: string; kind: WorkKind; title: string; goal: string; criteria: string[];
  origin: WorkPrincipal; owner: WorkPrincipal; scope: WorkScope; reviewRequired: boolean;
  state: WorkState; version: number; createdAt: string; updatedAt: string; dependencies: string[];
  context: { summary: string; nextAction: string; repository?: string; baseCommit?: string; headCommit?: string; recipientRoute?: string; artifacts: WorkArtifact[] };
  outputRevision: number; outputs: WorkArtifact[]; outputAuthor?: WorkPrincipal; outputDigest?: string; testArtifact?: WorkArtifact;
  findings: WorkFinding[]; review?: { revision: number; digest: string; reviewer: WorkPrincipal; evidence: WorkArtifact; accepted: boolean };
  contributions: WorkContribution[];
  conclusion?: { revision: number; content: string; evidenceIds: string[]; uncertainties: string[]; unresolvedIds: string[];
    resolutions: Array<{ contradictionId: string; experimentId: string; explanation: string }>; digest: string; approvals: string[] };
  claim?: { sessionId: string; token: string; expiresAt: string };
  progress?: string; blockedReason?: string;
  limits?:WorkBudgetLimits;budget?:WorkBudget;
  events: Array<{ sequence: number; requestId: string; hash: string; actor: WorkPrincipal; type: string; at: string; summary: string }>;
}
export interface NewWork {
  id: string; kind: WorkKind; title: string; goal: string; criteria: string[]; origin: WorkPrincipal; owner: WorkPrincipal;
  scope: WorkScope; reviewRequired: boolean; dependencies: string[]; context: WorkItem['context'];
  limits?:WorkBudgetLimits;
}
export type WorkOperation = { type: string; requestId: string; expectedVersion: number; [key: string]: unknown };
const terminal = (state: WorkState) => ['done', 'declined', 'cancelled'].includes(state);
const key = (p: WorkPrincipal) => `${p.nodeId}/${p.actorId}/${p.fingerprint}`;
const same = (a: WorkPrincipal, b: WorkPrincipal) => key(a) === key(b);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function stableWorkValue(value: unknown): string {
  return stable(value);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => JSON.stringify(key) + ':' + stable(entry)).join(',') + '}';
  return JSON.stringify(value);
}

function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error('Invalid ' + label);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected work object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('Unsupported or missing work fields');
}
export function workPrincipal(value: unknown): WorkPrincipal {
  const v = object(value); exact(v, ['nodeId','actorId','fingerprint']);
  if (typeof v.fingerprint !== 'string' || !digestPattern.test(v.fingerprint)) throw new Error('Invalid work principal fingerprint');
  return { nodeId: validateNetworkId(v.nodeId, 'node'), actorId: validateNetworkId(v.actorId, 'actor'), fingerprint: v.fingerprint };
}
function strings(value: unknown, label: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid ' + label);
  return value.map(v => text(v, label));
}
function artifacts(value: unknown): WorkArtifact[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid work artifacts');
  const refs = value.map(parseWorkArtifact);
  if (new Set(refs.map(ref => ref.name)).size !== refs.length) throw new Error('Duplicate work artifact name');
  return refs;
}
async function checkArtifacts(root: string, refs: WorkArtifact[]) {
  for (const ref of refs) await getWorkArtifact(root, ref);
}
export function parseNewWork(value: unknown): NewWork {
  const v = object(value); exact(v, ['id','kind','title','goal','criteria','origin','owner','scope','reviewRequired','dependencies','context',...(Object.hasOwn(v,'limits')?['limits']:[])]);
  if (!['handoff','review','delegate','investigation'].includes(v.kind as string) || typeof v.reviewRequired !== 'boolean') throw new Error('Invalid work kind/review requirement');
  const context = object(v.context);
  if (Object.keys(context).some(k => !['summary','nextAction','repository','baseCommit','headCommit','recipientRoute','artifacts'].includes(k))) throw new Error('Unsupported work context field');
  const criteria = strings(v.criteria, 'acceptance criteria'); if (!criteria.length) throw new Error('Acceptance criteria required');
  const origin = workPrincipal(v.origin), owner = workPrincipal(v.owner);
  if (origin.nodeId === owner.nodeId || origin.fingerprint === owner.fingerprint) throw new Error('Work requires distinct principals on distinct nodes');
  if (v.kind === 'review' && !v.reviewRequired) throw new Error('Review workflow requires independent review');
  const result: NewWork = { id: validateNetworkId(v.id, 'work id'), kind: v.kind as WorkKind,
    title: text(v.title, 'title', 256), goal: text(v.goal, 'goal'), criteria, origin, owner,
    scope: parseWorkScope(v.scope), reviewRequired: v.reviewRequired,
    dependencies: strings(v.dependencies, 'dependencies', 32).map(id => validateNetworkId(id, 'dependency')),
    context: { summary: text(context.summary, 'context'), nextAction: text(context.nextAction, 'next action'), artifacts: artifacts(context.artifacts) } };
  for (const field of ['repository','baseCommit','headCommit'] as const) if (context[field] !== undefined) result.context[field] = text(context[field], field, 1024);
  if (context.recipientRoute !== undefined) result.context.recipientRoute = validateNetworkId(context.recipientRoute, 'recipient route');
  if(v.limits!==undefined)result.limits=parseWorkBudgetLimits(v.limits);
  if (new Set(result.dependencies).size !== result.dependencies.length || result.dependencies.includes(result.id)) throw new Error('Invalid work dependencies');
  return result;
}

async function directories(root: string) {
  const canonical = await realpath(root), base = join(canonical, 'work-items');
  for (const path of [base, join(base, 'active'), join(base, 'archive')]) { await assertNotSymlink(path, 'Work store'); await mkdir(path, { recursive: true, mode: 0o700 }); }
  return { base, active: join(base, 'active'), archive: join(base, 'archive'), locks: join(base, 'locks') };
}
async function load(root: string, id: string): Promise<{ file: string; item: WorkItem }> {
  const dirs = await directories(root); validateNetworkId(id, 'work id');
  for (const directory of [dirs.active, dirs.archive]) {
    const file = join(directory, id + '.json'); await assertNotSymlink(file, 'Work item');
    try {
      if ((await stat(file)).size > 4 * 1024 * 1024) throw new Error('Work item exceeds storage bound');
      const item = JSON.parse(await readFile(file, 'utf8')) as WorkItem;
      if (item.schemaVersion !== 1 || item.id !== id || !Array.isArray(item.events)) throw new Error('Invalid stored work item');
      return { file, item };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw Object.assign(new Error('Unknown work item'), { code: 'ENOENT' });
}
function participant(item: WorkItem, actor: WorkPrincipal) {
  workPrincipal(actor);
  if (!same(item.origin, actor) && !same(item.owner, actor)) throw new Error('Work item belongs to different principals');
}
function owner(item: WorkItem, ctx: WorkContext) {
  if (!ctx.local || !same(item.owner, ctx.actor)) throw new Error('Only the local work owner may perform this operation');
}
function lease(item: WorkItem, ctx: WorkContext, op: WorkOperation) {
  owner(item, ctx);
  if (!item.claim || item.claim.sessionId !== ctx.sessionId || item.claim.token !== op.leaseToken || Date.parse(item.claim.expiresAt) <= Date.now()) throw new Error('Matching live work claim required; reconcile expired or uncertain work before recovery');
}
function version(item: WorkItem, op: WorkOperation) {
  if (!Number.isSafeInteger(op.expectedVersion) || op.expectedVersion !== item.version) throw new Error('Stale work version; read current work before a new operation');
}
async function persist(root: string, item: WorkItem, file: string) {
  const serialized = JSON.stringify(item);
  const terminalEvent = ['complete','cancel','cancelled','decline','release','recover'].includes(item.events.at(-1)?.type ?? '');
  if (Buffer.byteLength(serialized) > 512 * 1024 - (terminalEvent ? 0 : 16384)) throw new Error('Work item exceeds storage bound; terminal capacity is reserved');
  await boundedWorkWrite(root,file,serialized,terminalEvent);
  if (terminal(item.state)) {
    const target = join((await directories(root)).archive, item.id + '.json');
    if (file !== target) { await assertNotSymlink(target, 'Work archive'); await rename(file, target); }
  }
}

export async function createWorkItem(root: string, input: unknown, ctx: WorkContext, requestId: string): Promise<WorkItem> {
  return withWorkRetention(root,()=>createWorkItemRetained(root,input,ctx,requestId));
}
async function createWorkItemRetained(root: string, input: unknown, ctx: WorkContext, requestId: string): Promise<WorkItem> {
  const draft = parseNewWork(input), actor = workPrincipal(ctx.actor); validateNetworkId(requestId, 'request id');
  if (!same(draft.origin, actor)) throw new Error('Work origin must match authenticated creator');
  const dirs = await directories(root), hash = sha256(stable({ type: 'create', draft }));
  return withFileLock(dirs.locks, 'create', () => withFileLock(dirs.locks, draft.id, async () => {
    try {
      const existing = (await load(root, draft.id)).item;
      const receipt = existing.events.find(e => e.requestId === requestId);
      if (receipt?.hash === hash && same(receipt.actor, actor)) return existing;
      throw new Error('Work id already exists; conflicting create or replay');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await checkArtifacts(root, draft.context.artifacts);
    if ((await readdir(dirs.active)).filter(x => x.endsWith('.json')).length >= 128) throw new Error('Active work capacity reached; finish or cancel existing work');
    if((await readdir(dirs.archive)).filter(x=>x.endsWith('.json')).length+(await readdir(dirs.active)).filter(x=>x.endsWith('.json')).length>=WORK_STORAGE_LIMITS.archiveItems)throw new Error('Work receipt archive capacity reached; existing replay evidence is preserved');
    const visited = new Set<string>();
    const inspectDependency = async (id: string): Promise<void> => {
      if (id === draft.id) throw new Error('Work dependency cycle');
      if (visited.has(id)) return; visited.add(id);
      let dependency: WorkItem;
      try { dependency = (await load(root, id)).item; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!same(dependency.owner, draft.owner) || !same(dependency.origin, draft.origin)) throw new Error('Work dependency belongs to different principals');
      for (const nested of dependency.dependencies) await inspectDependency(nested);
    };
    for (const id of draft.dependencies) await inspectDependency(id);
    const now = new Date().toISOString();
    const item: WorkItem = { ...draft, schemaVersion: 1, state: 'queued', version: 1, createdAt: now, updatedAt: now,
      outputRevision: draft.kind === 'review' ? 1 : 0, outputs: draft.kind === 'review' ? draft.context.artifacts : [],
      findings: [], contributions: [], events: [{ sequence: 1, requestId, hash, actor, type: 'create', at: now, summary: draft.title }] };
    item.budget=initialWorkBudget(now,draft.limits);
    if (draft.kind === 'review') {
      if (!item.outputs.length) throw new Error('A review requires actual retrievable artifacts');
      item.outputAuthor = draft.origin; item.outputDigest = sha256(JSON.stringify(item.outputs));
    }
    await persist(root, item, join(dirs.active, draft.id + '.json')); return item;
  }));
}

export async function readWorkItem(root: string, id: string, actor: WorkPrincipal): Promise<WorkItem> {
  const dirs = await directories(root);
  return withFileLock(dirs.locks, validateNetworkId(id, 'work id'), async () => { const { item } = await load(root, id); participant(item, actor); return item; });
}

const operationFields: Record<string, string[]> = {
  accept: [], decline: ['summary'], claim: ['leaseSeconds'], renew: ['leaseToken','leaseSeconds'], release: ['leaseToken','summary'],
  progress: ['leaseToken','summary'], block: ['leaseToken','summary'], resume: [],
  recover: ['evidence','summary'], submit: ['leaseToken','artifacts','testArtifact','summary'],
  revise: ['artifacts','testArtifact','summary'], review: ['revision','digest','accepted','findings','evidence','leaseToken'], complete: ['summary'], cancel: ['summary'], cancelled: ['summary','leaseToken'],
  contribute: ['id','kind','content','artifacts'], conclude: ['content','evidenceIds','uncertainties','unresolvedIds','resolutions'], 'approve-conclusion': ['revision','digest'], comment: ['summary'], 'budget-notice':['escalationId'],
};

export async function operateWorkItem(root: string, id: string, ctx: WorkContext, value: unknown): Promise<WorkItem> {
  return withWorkRetention(root,()=>operateWorkItemRetained(root,id,ctx,value));
}
async function operateWorkItemRetained(root: string, id: string, ctx: WorkContext, value: unknown): Promise<WorkItem> {
  const v = object(value), type = text(v.type, 'operation', 64), fields = operationFields[type];
  if (!fields) throw new Error('Unknown work operation');
  exact(v, ['type','requestId','expectedVersion', ...fields]);
  const op = v as WorkOperation; validateNetworkId(op.requestId, 'request id'); validateNetworkId(ctx.sessionId, 'session id');
  const dirs = await directories(root);
  return withFileLock(dirs.locks, validateNetworkId(id, 'work id'), async () => {
    const { item, file } = await load(root, id); participant(item, ctx.actor);
    const hash = sha256(stable(op)), previous = item.events.find(e => e.requestId === op.requestId);
    if (previous) {
      if (previous.hash !== hash || !same(previous.actor, ctx.actor)) throw new Error('Conflicting work request replay');
      return item;
    }
    version(item, op);
    if (terminal(item.state)) throw new Error('Work is archived and terminal');
    if (item.events.length >= (['complete','cancel','cancelled','decline','release','recover'].includes(type) ? 1024 : 992)) throw new Error('Work event quota reached; terminal capacity is reserved');
    if (item.state === 'cancel-requested' && !['cancelled','recover','comment'].includes(type)) throw new Error('Cancellation must be reconciled before other work');
    const apply = async () => {
      const summary = fields.includes('summary') ? text(op.summary, 'summary', 512) : type;
      if(['claim','resume'].includes(type))owner(item,ctx);
      if(type==='revise' && (item.kind!=='review' || !same(item.origin,ctx.actor)))throw new Error('Only original review author may revise artifacts');
      if(['contribute','conclude'].includes(type) && item.kind!=='investigation')throw new Error('Investigation operation requires investigation work');
      if(budgetBlocked(item,type)) {
        item.version++;item.updatedAt=new Date().toISOString();
        item.events.push({sequence:item.version,requestId:op.requestId,hash,actor:ctx.actor,type:'budget-exceeded',at:item.updatedAt,summary:item.budget!.escalation!.reason});
        await persist(root,item,file);return item;
      }
      if (type === 'accept' || type === 'decline') {
        owner(item, ctx); if (item.state !== 'queued') throw new Error('Work is not awaiting acceptance');
        item.state = type === 'accept' ? 'accepted' : 'declined';
      } else if (type === 'claim') {
        owner(item, ctx);
        if (item.claim) throw new Error('Work already claimed; expired claims require evidence-based recovery');
        if (!['accepted','changes-requested'].includes(item.state)) throw new Error('Work is not claimable');
        for (const dependency of item.dependencies) {
          const dep = (await load(root, dependency)).item;
          if (!same(dep.owner, item.owner) || !same(dep.origin, item.origin) || dep.state !== 'done') throw new Error('Work dependency is not completed in this scope');
        }
        const seconds = op.leaseSeconds;
        if (!Number.isInteger(seconds) || (seconds as number) < 5 || (seconds as number) > 300) throw new Error('Work lease must be 5 to 300 seconds');
        item.claim = { sessionId: ctx.sessionId, token: randomUUID(), expiresAt: new Date(Date.now() + (seconds as number) * 1000).toISOString() };
        item.state = 'working';
      } else if (['renew','release','progress','block','submit'].includes(type)) {
        lease(item, ctx, op);
        if (type === 'renew') {
          if (!Number.isInteger(op.leaseSeconds) || (op.leaseSeconds as number) < 5 || (op.leaseSeconds as number) > 300) throw new Error('Work lease must be 5 to 300 seconds');
          item.claim!.expiresAt = new Date(Date.now() + (op.leaseSeconds as number) * 1000).toISOString();
        } else if (type === 'release' || type === 'block') {
          delete item.claim; item.state = type === 'release' ? 'accepted' : 'blocked';
          if (type === 'block') item.blockedReason = summary;
        } else if (type === 'progress') item.progress = summary;
        else {
          const refs = artifacts(op.artifacts), tests = parseWorkArtifact(op.testArtifact);
          if (!refs.length) throw new Error('Submission requires retrievable output');
          if (item.kind === 'review') throw new Error('Review owner evaluates author submissions; cannot replace reviewed work');
          await checkArtifacts(root, [...refs, tests]);
          item.outputs = refs; item.testArtifact = tests; item.outputAuthor = ctx.actor;
          item.outputRevision++; item.outputDigest = sha256(JSON.stringify({ artifacts: refs, tests })); delete item.review;
          delete item.claim; item.state = item.reviewRequired ? 'review' : 'verified';
        }
      } else if (type === 'resume') {
        owner(item, ctx); if (item.state !== 'blocked') throw new Error('Work is not blocked');
        delete item.blockedReason; item.state = 'accepted';
      } else if (type === 'recover') {
        owner(item, ctx);
        if (!item.claim || Date.parse(item.claim.expiresAt) > Date.now()) throw new Error('Only expired uncertain claims may be recovered');
        await getWorkArtifact(root, op.evidence);
        delete item.claim; if (item.state !== 'cancel-requested') item.state = 'accepted';
      } else if (type === 'review') {
        if (!item.outputAuthor || same(item.outputAuthor, ctx.actor)) throw new Error('Independent reviewer required');
        if (!['review','working','changes-requested','accepted'].includes(item.state) || op.revision !== item.outputRevision || op.digest !== item.outputDigest) throw new Error('Review must bind current output revision and digest');
        if (item.claim) lease(item, ctx, op);
        if (typeof op.accepted !== 'boolean' || !Array.isArray(op.findings) || op.findings.length > 64) throw new Error('Invalid review');
        const findings = op.findings.map(value => {
          const f = object(value); exact(f, ['id','content','status']);
          if (!['open','resolved','dismissed'].includes(f.status as string)) throw new Error('Invalid finding status');
          return { id: validateNetworkId(f.id, 'finding'), content: text(f.content, 'finding'), status: f.status as WorkFinding['status'] };
        });
        if (new Set(findings.map(f => f.id)).size !== findings.length) throw new Error('Duplicate review finding');
        for (const finding of findings) { const index = item.findings.findIndex(f => f.id === finding.id); if (index >= 0) item.findings[index] = finding; else item.findings.push(finding); }
        if (op.accepted && item.findings.some(f => f.status === 'open')) throw new Error('Open findings prevent acceptance');
        const evidence = parseWorkArtifact(op.evidence); await getWorkArtifact(root, evidence);
        item.review = { revision: item.outputRevision, digest: item.outputDigest!, reviewer: ctx.actor, evidence, accepted: op.accepted };
        recordReviewBudget(item,op.accepted,findings);
        item.state = op.accepted ? 'verified' : 'changes-requested'; delete item.claim;
      } else if (type === 'revise') {
        if (item.kind !== 'review' || !same(item.origin, ctx.actor) || item.claim || !['review','changes-requested'].includes(item.state)) throw new Error('Only original review author may revise settled review artifacts');
        const refs = artifacts(op.artifacts), tests = parseWorkArtifact(op.testArtifact);
        if (!refs.length) throw new Error('Revision requires retrievable artifacts');
        await checkArtifacts(root, [...refs, tests]);
        item.outputs = refs; item.testArtifact = tests; item.outputRevision++;
        item.outputDigest = sha256(stable({ artifacts: refs, tests })); delete item.review; item.state = 'review';
      } else if (type === 'complete') {
        owner(item, ctx);
        if (item.state !== 'verified' || item.claim) throw new Error('Only verified settled work can complete');
        if (item.kind === 'investigation' && item.conclusion?.approvals.length !== 2) throw new Error('Independent conclusion approvals required');
        item.state = 'done';
      } else if (type === 'cancel') {
        if (!same(item.origin, ctx.actor)) throw new Error('Only work initiator may request cancellation');
        item.state = 'cancel-requested';
      } else if (type === 'cancelled') {
        owner(item, ctx); if (item.state !== 'cancel-requested') throw new Error('Cancellation not requested');
        if (item.claim) lease(item, ctx, op);
        delete item.claim; item.state = 'cancelled';
      } else if (type === 'contribute') {
        if (item.kind !== 'investigation' || item.contributions.length >= 128) throw new Error('Investigation contribution unavailable');
        const contributionId = validateNetworkId(op.id, 'contribution');
        if (item.contributions.some(c => c.id === contributionId) || !['observation','hypothesis','experiment','contradiction','uncertainty'].includes(op.kind as string)) throw new Error('Invalid or duplicate contribution');
        const refs = artifacts(op.artifacts); await checkArtifacts(root, refs);
        item.contributions.push({ id: contributionId, kind: op.kind as WorkContribution['kind'], content: text(op.content, 'contribution'), artifacts: refs, actor: ctx.actor });
        if (item.conclusion) { item.conclusion.approvals = []; if (!item.claim) item.state = 'accepted'; }
      } else if (type === 'conclude') {
        if (item.kind !== 'investigation' || !item.contributions.some(c => same(c.actor, item.origin)) || !item.contributions.some(c => same(c.actor, item.owner))) throw new Error('Independent contributions from both participants required');
        if (item.claim) throw new Error('Settle active work before proposing a conclusion');
        const evidenceIds = strings(op.evidenceIds, 'conclusion evidence').map(id => validateNetworkId(id, 'evidence'));
        if (!evidenceIds.length || evidenceIds.some(id => !item.contributions.some(c => c.id === id))) throw new Error('Conclusion evidence missing');
        const uncertainties = strings(op.uncertainties, 'uncertainties'), content = text(op.content, 'conclusion', 12000);
        const unresolvedIds = strings(op.unresolvedIds, 'unresolved evidence').map(id => validateNetworkId(id, 'unresolved evidence'));
        if (unresolvedIds.some(id => !item.contributions.some(c => c.id === id))) throw new Error('Unresolved evidence missing');
        if (!Array.isArray(op.resolutions) || op.resolutions.length > 64) throw new Error('Invalid contradiction resolutions');
        const resolutions = op.resolutions.map(value => {
          const r = object(value); exact(r, ['contradictionId','experimentId','explanation']);
          const contradictionId = validateNetworkId(r.contradictionId, 'contradiction'), experimentId = validateNetworkId(r.experimentId, 'experiment');
          if (!item.contributions.some(c => c.id === contradictionId && c.kind === 'contradiction')
            || !item.contributions.some(c => c.id === experimentId && c.kind === 'experiment' && c.artifacts.length > 0)) throw new Error('Contradiction resolution requires a recorded experiment and retrievable evidence');
          return { contradictionId, experimentId, explanation: text(r.explanation, 'resolution explanation') };
        });
        if (new Set(resolutions.map(r => r.contradictionId)).size !== resolutions.length
          || resolutions.some(r => unresolvedIds.includes(r.contradictionId))
          || item.contributions.some(c => c.kind === 'contradiction' && !unresolvedIds.includes(c.id) && !resolutions.some(r => r.contradictionId === c.id))) throw new Error('Every contradiction must be resolved by evidence or retained as unresolved');
        const revision = (item.conclusion?.revision ?? 0) + 1;
        const digest = sha256(stable({ content, evidenceIds, uncertainties, unresolvedIds, resolutions, contributions: item.contributions }));
        item.conclusion = { revision, content, evidenceIds, uncertainties, unresolvedIds, resolutions, digest, approvals: [] }; item.state = 'review'; delete item.claim;
      } else if (type === 'approve-conclusion') {
        if (item.kind !== 'investigation' || !item.conclusion || op.revision !== item.conclusion.revision || op.digest !== item.conclusion.digest) throw new Error('Conclusion approval must bind exact current conclusion');
        const actor = key(ctx.actor); if (!item.conclusion.approvals.includes(actor)) item.conclusion.approvals.push(actor);
        if (item.conclusion.approvals.length === 2) item.state = 'verified';
      } else if(type==='budget-notice') {
        owner(item,ctx);
        const escalation=item.budget?.escalation;
        if(!escalation || escalation.id!==op.escalationId)throw new Error('Budget notice must match current escalation');
        escalation.notifiedAt??=new Date().toISOString();
      } else if (type !== 'comment') throw new Error('Unknown work operation');
      item.version++; item.updatedAt = new Date().toISOString();
      item.events.push({ sequence: item.version, requestId: op.requestId, hash, actor: ctx.actor, type, at: item.updatedAt, summary });
      await persist(root, item, file); return item;
    };
    if (['claim','renew'].includes(type)) {
      if (!ctx.policyId) throw new Error('Local delegated work policy required before execution; reading and acceptance remain available');
      return withWorkPolicy(root, ctx.policyId, ctx.workspace, item.origin.fingerprint, item.scope, apply);
    }
    // Submission is an execution attestation. Revocation does not prevent reporting a blocker or releasing a claim.
    if (type === 'submit') {
      if (!ctx.policyId) throw new Error('Local delegated work policy required');
      return withWorkPolicy(root, ctx.policyId, ctx.workspace, item.origin.fingerprint, item.scope, apply);
    }
    return apply();
  });
}

/** Explicit local owner budget administration; never a peer/MCP operation. */
export async function authorizeWorkBudget(root:string,id:string,actor:WorkPrincipal,input:{requestId:string;limits:WorkBudgetLimits;deadline:string}):Promise<WorkItem> {
  const limits=parseWorkBudgetLimits(input.limits,true),requestId=validateNetworkId(input.requestId,'budget authorization request');
  if(!Number.isFinite(Date.parse(input.deadline)) || new Date(input.deadline).toISOString()!==input.deadline || Date.parse(input.deadline)<=Date.now() || Date.parse(input.deadline)-Date.now()>30*86400_000)throw new Error('Owner budget deadline must be finite and within 30 days');
  const dirs=await directories(root);
  return withWorkRetention(root,()=>withFileLock(dirs.locks,validateNetworkId(id,'work id'),async()=>{
    const {item,file}=await load(root,id);if(!same(item.owner,actor))throw new Error('Only the local recipient owner may authorize a work budget');
    const hash=sha256(stable({type:'budget-authorized',...input})),previous=item.events.find(event=>event.requestId===requestId);
    if(previous){if(previous.hash!==hash || !same(previous.actor,actor))throw new Error('Conflicting owner budget authorization');return item;}
    if(terminal(item.state))throw new Error('Terminal work budgets cannot be renewed');
    if(item.events.length>=992)throw new Error('Work event quota reached; terminal capacity is reserved');
    item.budget??=initialWorkBudget(item.createdAt,item.limits);item.budget.limits=limits;item.budget.deadline=input.deadline;delete item.budget.escalation;
    item.version++;item.updatedAt=new Date().toISOString();item.events.push({sequence:item.version,requestId,hash,actor,type:'budget-authorized',at:item.updatedAt,summary:'Local owner authorized finite collaboration limits'});
    await persist(root,item,file);return item;
  }));
}

export async function listWorkItems(root: string, actor: WorkPrincipal, includeArchived = false): Promise<WorkItem[]> {
  workPrincipal(actor); const dirs = await directories(root), results: WorkItem[] = [];
  for (const directory of [dirs.active, ...(includeArchived ? [dirs.archive] : [])]) {
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const item = await withFileLock(dirs.locks, validateNetworkId(id, 'stored work id'), async () => (await load(root, id)).item);
      if (same(item.origin, actor) || same(item.owner, actor)) results.push(item);
    }
  }
  return [...new Map(results.map(item => [item.id, item])).values()];
}
