#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, run } from './network-fixture.mjs';
import { authorizeLocalExecution } from '../dist/network/collaboration.js';
import { revokeGrant } from '../dist/network/trust.js';
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const f = await fixture();
try {
  const { call, sides } = f;
  await call(1, 'accept');
  const initial = (await call(0, 'propose', { expectedRevision: 0, content: 'GET /orders returns a bare list; no auth or pagination.' })).snapshot;
  await call(0, 'approve', { expectedRevision: 1, digest: initial.digest });
  await call(1, 'discuss', { content: 'Disagree: require bearer auth, opaque cursor pagination, 401 and 404 errors.' });
  const agreement = 'GET /orders?cursor=<opaque> requires bearer auth. Returns {items:[{id:string}],nextCursor:string|null}. Errors: 401 unauthenticated; 404 unknown cursor. No remote command execution.';
  const revised = (await call(1, 'propose', { expectedRevision: 1, content: agreement })).snapshot;
  assert.deepEqual(revised.approvals, []);
  await assert.rejects(call(0, 'propose', { expectedRevision: 1, content: 'stale override' }), /Stale/);
  await assert.rejects(call(0, 'approve', { expectedRevision: 1, digest: initial.digest }), /exact current/);
  await call(0, 'approve', { expectedRevision: 2, digest: revised.digest });
  await call(1, 'approve', { expectedRevision: 2, digest: revised.digest });
  const approved = (await call(0, 'get')).snapshot;
  assert.equal(approved.approvals.length, 2);
  assert.equal((await call(1, 'get')).snapshot.digest, approved.digest);
  const checks = { disagreementAndReconciliation: true, staleProposal: true, approvalInvalidation: true, identicalAgreement: true };
  for (let i = 0; i < 2; i++) {
    const side = sides[i];
    await call(1 - i, 'task', { taskId: `implement-${i}`, expectedRevision: 2, digest: approved.digest, content: 'Implement and independently test your selected repository against the accepted API.' });
    await assert.rejects(call(i, 'read', { taskId: `implement-${i}` }), /Owner execution/);
    await authorizeLocalExecution(side.root, { agentId: side.agent, workspaceRoot: side.repo, collaboration: approved, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    await call(i, 'read', { taskId: `implement-${i}` });
    // Deterministic engineering fixture actors; deliberately not native-model evidence.
    const source = i === 0
      ? "export function orders(token,cursor=null){if(!token)return {status:401};if(cursor&&cursor!=='next')return {status:404};return {status:200,body:{items:[{id:'one'}],nextCursor:null}};}\n"
      : "export function decode(response){if(response.status!==200)throw new Error(String(response.status));if(!Array.isArray(response.body.items)||!Object.hasOwn(response.body,'nextCursor'))throw new Error('schema');return response.body;}\n";
    const test = i === 0
      ? "import assert from 'node:assert/strict';import {orders} from './implementation.mjs';assert.equal(orders(null).status,401);assert.equal(orders('token','missing').status,404);assert.deepEqual(orders('token').body,{items:[{id:'one'}],nextCursor:null});console.log('backend contract tests passed');"
      : "import assert from 'node:assert/strict';import {decode} from './implementation.mjs';assert.throws(()=>decode({status:401}));assert.throws(()=>decode({status:404}));assert.deepEqual(decode({status:200,body:{items:[{id:'one'}],nextCursor:null}}),{items:[{id:'one'}],nextCursor:null});console.log('frontend contract tests passed');";
    await writeFile(join(side.repo, 'implementation.mjs'), source);
    await writeFile(join(side.repo, 'contract.test.mjs'), test);
    await writeFile(join(side.repo, 'AGREEMENT.md'), approved.content);
    const result = await run(process.execPath, ['contract.test.mjs'], { cwd: side.repo, timeout: 15000 });
    await call(i, 'processed', { taskId: `implement-${i}`, evidence: { summary: result.stdout.trim(), artifactDigest: digest(source), testDigest: digest(result.stdout) } });
  }
  checks.ownerGate = true; checks.independentRepositoryTests = true; checks.correlatedProcessing = true;
  assert.equal(await readFile(join(sides[0].repo, 'AGREEMENT.md'), 'utf8'), await readFile(join(sides[1].repo, 'AGREEMENT.md'), 'utf8'));
  await f.restart();
  assert.equal((await call(1, 'get')).snapshot.tasks.filter((t) => t.phase === 'processed').length, 2);
  await call(0, 'task', { taskId: 'second-after-restart', expectedRevision: 2, digest: approved.digest, content: 'Run the consumer contract tests again after restart.' });
  await call(1, 'read', { taskId: 'second-after-restart' });
  const second = await run(process.execPath, ['contract.test.mjs'], { cwd: sides[1].repo, timeout: 15000 });
  await call(1, 'processed', { taskId: 'second-after-restart', evidence: { summary: second.stdout.trim(), artifactDigest: digest(await readFile(join(sides[1].repo, 'implementation.mjs'))), testDigest: digest(second.stdout) } });
  checks.restartAndSecondTask = true;
  await call(1, 'accept', {}, 'review');
  await call(1, 'discuss', { content: 'Finding: the author must cover unauthenticated requests and invalid cursors.' }, 'review');
  const review = (await call(0, 'propose', { expectedRevision: 0, content: 'Resolution: producer tests exercise 401 and 404. Reviewer reruns the tests. Review approval never authorizes a merge.' }, 'review')).snapshot;
  await call(0, 'approve', { expectedRevision: 1, digest: review.digest }, 'review');
  await call(1, 'approve', { expectedRevision: 1, digest: review.digest }, 'review');
  await call(0, 'task', { taskId: 'verify-finding', expectedRevision: 1, digest: review.digest, content: 'Verify the reviewed error-contract fixtures locally.' }, 'review');
  await authorizeLocalExecution(sides[1].root, { agentId: sides[1].agent, workspaceRoot: sides[1].repo, collaboration: (await call(0, 'get', {}, 'review')).snapshot, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  await call(1, 'read', { taskId: 'verify-finding' }, 'review');
  const reviewed = await run(process.execPath, ['contract.test.mjs'], { cwd: sides[1].repo, timeout: 15000 });
  await call(1, 'processed', { taskId: 'verify-finding', evidence: { summary: reviewed.stdout.trim(), artifactDigest: digest(await readFile(join(sides[1].repo, 'implementation.mjs'))), testDigest: digest(reviewed.stdout) } }, 'review');
  checks.authorReviewer = true;
  await call(0, 'task', { taskId: 'cancel-me', expectedRevision: 2, digest: approved.digest, content: 'Cancellable task' });
  await call(0, 'cancel-task', { taskId: 'cancel-me' });
  await call(1, 'cancelled-task', { taskId: 'cancel-me' });
  checks.cancellation = true;
  await revokeGrant(sides[0].root, 'orders-grant');
  await assert.rejects(call(1, 'get'), /403/);
  checks.revocation = true;
  console.log(JSON.stringify({ status: 'PASS', scope: 'same-host deterministic process acceptance; not native or physical-host acceptance', nodes: sides.map((s) => ({ nodeId: s.node, pid: s.server.pid })), agreementDigest: approved.digest, checks }));
} finally { await f.close(); }
