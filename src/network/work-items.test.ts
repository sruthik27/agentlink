import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkItem, readWorkItem, operateWorkItem, listWorkItems, type NewWork, type WorkContext, type WorkItem } from './work-items.js';
import { putWorkArtifact, getWorkArtifact, exportWorkFile } from './work-artifacts.js';
import { writeWorkPolicy, type WorkPolicy } from './work-policy.js';

const origin = { nodeId: 'node-a', actorId: 'author', fingerprint: 'sha256:' + 'a'.repeat(64) };
const recipient = { nodeId: 'node-b', actorId: 'implementer', fingerprint: 'sha256:' + 'b'.repeat(64) };
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'agentlink-work-')), root = join(base, 'private'), workspace = join(base, 'repo');
  await Promise.all([mkdir(root), mkdir(workspace)]); t.after(() => rm(base, { recursive: true, force: true }));
  const policy: WorkPolicy = { version: 1, id: 'team-policy', workspace, peerFingerprint: origin.fingerprint,
    paths: ['src','tests'], permissions: ['read','edit','test'], checks: ['unit'], expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false };
  await writeWorkPolicy(root, policy);
  const author: WorkContext = { actor: origin, local: false, sessionId: 'author-session', workspace };
  const owner: WorkContext = { actor: recipient, local: true, sessionId: 'worker-session', workspace, policyId: policy.id };
  let serial = 0;
  const blob = (content: string, name = 'changes.patch') => putWorkArtifact(root, Buffer.from(content), name, 'text/plain');
  const draft = (id: string, kind: NewWork['kind'] = 'handoff', refs: NewWork['context']['artifacts'] = []): NewWork => ({
    id, kind, title: 'Work ' + id, goal: 'Complete and verify the related change', criteria: ['Tests pass', 'Evidence is retrievable'],
    origin, owner: recipient, reviewRequired: kind !== 'handoff', dependencies: [],
    scope: { paths: ['src','tests'], permissions: ['read','edit','test'], checks: ['unit'] },
    context: { summary: 'What was changed, why, and what remains', nextAction: 'Inspect the exported change and continue', artifacts: refs, repository: 'example/api', baseCommit: 'base-commit' },
  });
  const create = (input: NewWork) => createWorkItem(root, input, author, 'create-' + input.id);
  const op = async (id: string, ctx: WorkContext, type: string, extra: Record<string, unknown> = {}): Promise<WorkItem> => {
    const current = await readWorkItem(root, id, ctx.actor);
    return operateWorkItem(root, id, ctx, { type, requestId: 'request-' + (++serial), expectedVersion: current.version, ...extra });
  };
  return { base, root, workspace, policy, author, owner, blob, draft, create, op };
}

test('recipient owns accepted handoff, executes under standing policy and archives with exact retry protection', async t => {
  const f = await fixture(t), patch = await f.blob('dirty diff from sender');
  await f.create(f.draft('handoff', 'handoff', [patch]));
  const noPolicy = { ...f.owner, policyId: undefined };
  assert.equal((await readWorkItem(f.root, 'handoff', recipient)).state, 'queued');
  await f.op('handoff', noPolicy, 'accept');
  await assert.rejects(f.op('handoff', noPolicy, 'claim', { leaseSeconds: 60 }), /policy required/);
  const claimed = await f.op('handoff', f.owner, 'claim', { leaseSeconds: 60 });
  await assert.rejects(f.op('handoff', { ...f.owner, sessionId: 'competing-session' }, 'progress', { leaseToken: claimed.claim!.token, summary: 'steal work' }), /Matching live/);
  const output = await f.blob('final output'), testOutput = await f.blob('actual captured test output', 'unit-test.txt');
  // Only the recipient's durable local store is used after this point. No origin server/process is needed.
  const submitted = await f.op('handoff', f.owner, 'submit', { leaseToken: claimed.claim!.token, artifacts: [output], testArtifact: testOutput, summary: 'Implemented and tested locally' });
  assert.equal(submitted.state, 'verified');
  const complete = { type: 'complete', requestId: 'complete-once', expectedVersion: submitted.version, summary: 'Ready for the initiating agent' };
  const done = await operateWorkItem(f.root, 'handoff', f.owner, complete);
  assert.equal(done.state, 'done'); assert.equal((await readdir(join(f.root,'work-items/active'))).length, 0);
  assert.equal((await listWorkItems(f.root, recipient, true)).length, 1);
  assert.equal((await operateWorkItem(f.root, 'handoff', f.owner, { summary: complete.summary, expectedVersion: complete.expectedVersion, requestId: complete.requestId, type: complete.type })).version, done.version);
  await assert.rejects(operateWorkItem(f.root, 'handoff', f.owner, { ...complete, summary: 'conflicting replay' }), /Conflicting/);
  assert.equal((await f.create(f.draft('handoff', 'handoff', [patch]))).state, 'done');
  await assert.rejects(readWorkItem(f.root, 'handoff', { ...origin, actorId: 'unrelated' }), /different principals/);
  assert.equal((await getWorkArtifact(f.root, done.outputs[0]!)).toString(), 'final output');
});

test('review tracks findings over two repair rounds and rejects stale or self approvals', async t => {
  const f = await fixture(t), original = await f.blob('version one'), tests = await f.blob('test evidence', 'tests.txt'), evidence = await f.blob('review evidence', 'review.txt');
  await f.create(f.draft('review', 'review', [original])); await f.op('review', f.owner, 'accept');
  let item = await readWorkItem(f.root, 'review', recipient);
  const review = (accepted: boolean, findings: unknown[]) => ({ revision: item.outputRevision, digest: item.outputDigest, accepted, findings, evidence, leaseToken: null });
  await assert.rejects(f.op('review', f.author, 'review', review(true, [])), /Independent/);
  item = await f.op('review', f.owner, 'review', review(false, [{ id: 'finding-1', content: 'Missing error case', status: 'open' }]));
  const oldDigest = item.outputDigest;
  item = await f.op('review', f.author, 'revise', { artifacts: [await f.blob('second version')], testArtifact: tests, summary: 'First repair' });
  await assert.rejects(f.op('review', f.owner, 'review', { ...review(true, []), digest: oldDigest }), /current output/);
  await assert.rejects(f.op('review', f.owner, 'review', review(true, [])), /Open findings/);
  item = await f.op('review', f.owner, 'review', review(false, [{ id: 'finding-1', content: 'Error case fixed', status: 'resolved' }, { id: 'finding-2', content: 'Missing boundary test', status: 'open' }]));
  item = await f.op('review', f.author, 'revise', { artifacts: [await f.blob('third version')], testArtifact: tests, summary: 'Second repair' });
  item = await f.op('review', f.owner, 'review', review(true, [{ id: 'finding-2', content: 'Boundary test verified', status: 'resolved' }]));
  assert.equal(item.outputRevision, 3); assert.equal(item.findings.length, 2); assert.equal(item.review!.revision, 3);
  assert.equal((await f.op('review', f.owner, 'complete', { summary: 'Reviewed exact current artifacts' })).state, 'done');
});

test('delegation enforces dependencies, blockers, independent completion review, revocation and cancellation', async t => {
  const f = await fixture(t); await f.create(f.draft('dependency'));
  const task = f.draft('delegated', 'delegate'); task.dependencies = ['dependency']; await f.create(task); await f.op('delegated', f.owner, 'accept');
  await assert.rejects(f.op('delegated', f.owner, 'claim', { leaseSeconds: 60 }), /dependency/);
  await f.op('dependency', f.owner, 'accept'); const dependency = await f.op('dependency', f.owner, 'claim', { leaseSeconds: 60 });
  const output = await f.blob('implementation'), tests = await f.blob('test result', 'tests.txt');
  await f.op('dependency', f.owner, 'submit', { leaseToken: dependency.claim!.token, artifacts: [output], testArtifact: tests, summary: 'Dependency complete' });
  await f.op('dependency', f.owner, 'complete', { summary: 'Verified dependency' });
  let claimed = await f.op('delegated', f.owner, 'claim', { leaseSeconds: 60 });
  assert.equal((await f.op('delegated', f.owner, 'block', { leaseToken: claimed.claim!.token, summary: 'Need API fixture' })).state, 'blocked');
  await f.op('delegated', f.owner, 'resume'); claimed = await f.op('delegated', f.owner, 'claim', { leaseSeconds: 60 });
  await writeWorkPolicy(f.root, { ...f.policy, revoked: true });
  await assert.rejects(f.op('delegated', f.owner, 'submit', { leaseToken: claimed.claim!.token, artifacts: [output], testArtifact: tests, summary: 'Cannot attest under revoked policy' }), /revoked/);
  // Revocation must not prevent a safe release or status report.
  await f.op('delegated', f.owner, 'release', { leaseToken: claimed.claim!.token, summary: 'Stopped because policy revoked' });
  await writeWorkPolicy(f.root, f.policy); claimed = await f.op('delegated', f.owner, 'claim', { leaseSeconds: 60 });
  let submitted = await f.op('delegated', f.owner, 'submit', { leaseToken: claimed.claim!.token, artifacts: [output], testArtifact: tests, summary: 'Implemented under restored local policy' });
  await assert.rejects(f.op('delegated', f.owner, 'complete', { summary: 'Skip reviewer' }), /verified/);
  submitted = await f.op('delegated', f.author, 'review', { revision: submitted.outputRevision, digest: submitted.outputDigest, accepted: true, findings: [], evidence: await f.blob('Independent verification', 'review.txt'), leaseToken: null });
  assert.equal((await f.op('delegated', f.owner, 'complete', { summary: 'Reviewed implementation' })).state, 'done');
  await f.create(f.draft('cancel')); await f.op('cancel', f.owner, 'accept'); claimed = await f.op('cancel', f.owner, 'claim', { leaseSeconds: 60 });
  await f.op('cancel', f.author, 'cancel', { summary: 'No longer needed' });
  await assert.rejects(f.op('cancel', f.owner, 'progress', { leaseToken: claimed.claim!.token, summary: 'Ignore cancellation' }), /Cancellation/);
  assert.equal((await f.op('cancel', f.owner, 'cancelled', { leaseToken: claimed.claim!.token, summary: 'Confirmed local work stopped' })).state, 'cancelled');
});

test('investigations preserve contradictions and require independent approvals of evidence-bound conclusions', async t => {
  const f = await fixture(t); await f.create(f.draft('investigation', 'investigation')); await f.op('investigation', f.owner, 'accept');
  await f.op('investigation', f.author, 'contribute', { id: 'trace-a', kind: 'observation', content: 'Independent trace A', artifacts: [await f.blob('trace A', 'trace-a.txt')] });
  await f.op('investigation', f.owner, 'contribute', { id: 'contradiction', kind: 'contradiction', content: 'Independent trace disagrees', artifacts: [await f.blob('trace B', 'trace-b.txt')] });
  const conclusion = { content: 'Routing, not authentication, explains the failure', evidenceIds: ['trace-a','contradiction'], uncertainties: [], unresolvedIds: [], resolutions: [] };
  await assert.rejects(f.op('investigation', f.author, 'conclude', conclusion), /Every contradiction/);
  await f.op('investigation', f.owner, 'contribute', { id: 'experiment', kind: 'experiment', content: 'Controlled routing experiment', artifacts: [await f.blob('experiment output', 'experiment.txt')] });
  let item = await f.op('investigation', f.author, 'conclude', { ...conclusion, resolutions: [{ contradictionId: 'contradiction', experimentId: 'experiment', explanation: 'Both traces reproduce under different routes' }] });
  const approval = { revision: item.conclusion!.revision, digest: item.conclusion!.digest };
  item = await f.op('investigation', f.author, 'approve-conclusion', approval);
  item = await f.op('investigation', f.author, 'approve-conclusion', approval); assert.equal(item.conclusion!.approvals.length, 1);
  item = await f.op('investigation', f.owner, 'approve-conclusion', approval); assert.equal(item.state, 'verified');
  await f.op('investigation', f.owner, 'contribute', { id: 'uncertainty', kind: 'uncertainty', content: 'One environment remains untested', artifacts: [] });
  await assert.rejects(f.op('investigation', f.owner, 'complete', { summary: 'Ignore new uncertainty' }), /verified/);
  assert.equal((await readWorkItem(f.root, 'investigation', recipient)).conclusion!.approvals.length, 0);
});

test('expired claims require explicit evidence-based recovery; scope and peer policy cannot be forged', async t => {
  const f = await fixture(t); await f.create(f.draft('recovery')); await f.op('recovery', f.owner, 'accept');
  const claimed = await f.op('recovery', f.owner, 'claim', { leaseSeconds: 5 });
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 10000);
  const replacement = { ...f.owner, sessionId: 'replacement-session' };
  await assert.rejects(f.op('recovery', replacement, 'claim', { leaseSeconds: 60 }), /already claimed/);
  await assert.rejects(f.op('recovery', replacement, 'recover', { summary: 'Invented evidence', evidence: { name: 'recovery.txt', mediaType: 'text/plain', bytes: 0, digest: 'sha256:' + '0'.repeat(64) } }), /ENOENT/);
  await f.op('recovery', replacement, 'recover', { summary: 'Inspected artifacts and confirmed prior effects', evidence: await f.blob('Actual reconciliation record', 'recovery.txt') });
  const recovered = await f.op('recovery', replacement, 'claim', { leaseSeconds: 60 });
  assert.notEqual(recovered.claim!.token, claimed.claim!.token);
  await assert.rejects(f.op('recovery', f.owner, 'progress', { leaseToken: claimed.claim!.token, summary: 'Stale worker returns' }), /Matching live/);
  const beyond = f.draft('beyond'); beyond.scope.paths = ['private']; await f.create(beyond); await f.op('beyond', f.owner, 'accept');
  await assert.rejects(f.op('beyond', f.owner, 'claim', { leaseSeconds: 60 }), /exceeds locally/);
  await writeWorkPolicy(f.root, { ...f.policy, peerFingerprint: recipient.fingerprint });
  await assert.rejects(f.op('recovery', replacement, 'renew', { leaseToken: recovered.claim!.token, leaseSeconds: 60 }), /another workspace\/peer/);
});

test('artifact exports are explicit, content-addressed, bounded and reject corruption, traversal and symlink escape', async t => {
  const f = await fixture(t); await mkdir(join(f.workspace, 'src')); await writeFile(join(f.workspace, 'src/file.txt'), 'selected export');
  const ref = await exportWorkFile(f.root, f.workspace, 'src/file.txt', ['src']);
  assert.equal((await getWorkArtifact(f.root, ref)).toString(), 'selected export');
  await assert.rejects(exportWorkFile(f.root, f.workspace, '../private/anything', ['src']), /relative path/);
  await assert.rejects(exportWorkFile(f.root, f.workspace, 'src/file.txt', ['tests']), /outside locally/);
  await writeFile(join(f.base, 'secret.txt'), 'not authorized'); await symlink(join(f.base, 'secret.txt'), join(f.workspace,'src/link'));
  await assert.rejects(exportWorkFile(f.root, f.workspace, 'src/link', ['src']), /escapes/);
  await assert.rejects(putWorkArtifact(f.root, Buffer.alloc(1024 * 1024 + 1), 'large'), /exceeds/);
  const file = join(f.root, 'work-artifacts', ref.digest.slice(7) + '.json');
  const content = JSON.parse(await readFile(file, 'utf8')); content.data = Buffer.from('corrupt').toString('base64'); await writeFile(file, JSON.stringify(content));
  await assert.rejects(getWorkArtifact(f.root, ref), /mismatch/);
  await assert.rejects(writeWorkPolicy(f.workspace, f.policy), /outside/);
});

test('simultaneous sessions cannot claim the same work and stale operations never mutate it', async t => {
  const f = await fixture(t); await f.create(f.draft('concurrent')); const accepted = await f.op('concurrent', f.owner, 'accept');
  const attempts = await Promise.allSettled(['session-one','session-two'].map(sessionId => operateWorkItem(f.root, 'concurrent', { ...f.owner, sessionId }, {
    type: 'claim', requestId: 'claim-' + sessionId, expectedVersion: accepted.version, leaseSeconds: 60,
  })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(r => r.status === 'rejected').length, 1);
  const current = await readWorkItem(f.root, 'concurrent', recipient);
  await assert.rejects(operateWorkItem(f.root, 'concurrent', f.author, { type: 'comment', requestId: 'stale-comment', expectedVersion: accepted.version, summary: 'Stale read must not mutate work' }), /Stale/);
  assert.equal((await readWorkItem(f.root, 'concurrent', recipient)).version, current.version);
  await assert.rejects(f.op('concurrent', f.author, 'comment', { summary: null }), /Invalid summary/);
  const a = f.draft('cycle-a'); a.dependencies = ['cycle-b']; await f.create(a);
  const b = f.draft('cycle-b'); b.dependencies = ['cycle-a'];
  await assert.rejects(f.create(b), /dependency cycle/);
});
