import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,rm,access,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workGit } from './work-git.js';
import { packageWorkContext } from './work-packages.js';
import { getWorkArtifact } from './work-artifacts.js';
import { writeWorkPolicy } from './work-policy.js';
import { writeLocalWorkCheck } from './work-checks.js';
import { integrateWorkPackage, releaseWorkIntegration } from './work-integration.js';

const peerFingerprint='sha256:'+'a'.repeat(64);
async function fixture(t:TestContext) {
  const base=await mkdtemp(join(tmpdir(),'agentlink-context-')),source=join(base,'source'),target=join(base,'target'),root=join(base,'private');
  await Promise.all([mkdir(source),mkdir(root)]);t.after(()=>rm(base,{recursive:true,force:true}));
  await workGit(source,['init','--initial-branch=main']);await mkdir(join(source,'src'));await mkdir(join(source,'tests'));
  await writeFile(join(source,'src','calc.cjs'),'exports.value = 1; // a/before/preserve-this\n');
  await writeFile(join(source,'src','old.txt'),'delete this\n');
  await writeFile(join(source,'tests','calc.test.cjs'),"const assert=require('node:assert/strict');assert.equal(require('../src/calc.cjs').value,2);console.log('verified actual value');\n");
  await workGit(source,['add','--','src','tests']);await workGit(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture baseline']);
  await workGit(base,['clone','--no-local',source,target]);
  await writeFile(join(source,'src','calc.cjs'),'exports.value = 2; // a/before/preserve-this\n');
  await writeFile(join(source,'src','new.bin'),Buffer.from([0,255,1,128]));await rm(join(source,'src','old.txt'));
  await writeFile(join(source,'private-unselected.txt'),'must never be exported');
  const policy={version:1 as const,id:'team',workspace:source,peerFingerprint,expiresAt:new Date(Date.now()+60000).toISOString(),revoked:false,paths:['src','tests'],permissions:['read','edit','test'] as ['read','edit','test'],checks:['unit','timeout','tamper','mutate']};
  await writeWorkPolicy(root,policy);
  const input={policyId:'team',requestId:'package',summary:'Complete the value change',decisions:['Use the selected implementation'],nextAction:'Run local verification and review'};
  return {base,source,target,root,policy,input};
}

test('context packaging captures scoped tracked/untracked/deleted/binary changes and a real patch, without hooks or filters',async t=>{
  const f=await fixture(t),marker=join(f.base,'filter-ran');
  await writeFile(join(f.source,'.gitattributes'),'src/*.cjs filter=evil\n');
  await workGit(f.source,['config','filter.evil.clean',`touch '${marker}'; cat`]);await workGit(f.source,['config','filter.evil.smudge',`touch '${marker}'; cat`]);
  const packed=await packageWorkContext(f.root,f.source,peerFingerprint,f.input);
  assert.deepEqual(packed.context.files.map(file=>file.path),['src/calc.cjs','src/new.bin','src/old.txt']);
  assert.equal(packed.context.files[2]!.headDigest,null);assert.equal(packed.context.repository.baseCommit?.length,40);
  assert.equal(packed.context.checks.length,0);await assert.rejects(access(marker));
  const patch=await getWorkArtifact(f.root,packed.context.patch);assert.match(patch.toString(),/a\/before\/preserve-this/);
  const patchPath=join(f.base,'selected.patch');await writeFile(patchPath,patch);await workGit(f.target,['apply','--check','--binary','--',patchPath]);
  assert.equal((await packageWorkContext(f.root,f.source,peerFingerprint,f.input)).manifest.digest,packed.manifest.digest);
  await assert.rejects(packageWorkContext(f.root,f.source,peerFingerprint,{...f.input,nextAction:'Different intent'}),/Conflicting/);
  await assert.rejects(packageWorkContext(f.root,f.source,peerFingerprint,{...f.input,requestId:'outside',paths:['private-unselected.txt']}),/exceeds/);
  await symlink(join(f.base,'filter-ran'),join(f.source,'src','link'));await assert.rejects(packageWorkContext(f.root,f.source,peerFingerprint,{...f.input,requestId:'symlink',paths:['src/link']}),/symbolic link/);
  // A retained request must never create a different package after its bytes expire.
  await rm(join(f.root,'work-artifacts',packed.context.patch.digest.slice(7)+'.json'));
  await writeFile(join(f.source,'src','calc.cjs'),'exports.value = 3;\n');
  await assert.rejects(packageWorkContext(f.root,f.source,peerFingerprint,f.input),{code:'ENOENT'});
});

test('integration preserves a dirty receiver, verifies exact package bytes with local checks and records conflicts and failures',async t=>{
  const f=await fixture(t),packed=await packageWorkContext(f.root,f.source,peerFingerprint,f.input);
  await writeWorkPolicy(f.root,{...f.policy,workspace:f.target});
  await writeLocalWorkCheck(f.root,{version:1,id:'unit',workspace:f.target,peerFingerprint,command:process.execPath,args:['--test','tests/calc.test.cjs'],timeoutSeconds:10});
  await writeLocalWorkCheck(f.root,{version:1,id:'timeout',workspace:f.target,peerFingerprint,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutSeconds:1});
  await writeFile(join(f.target,'src','calc.cjs'),'exports.value = 77; // owner dirty change\n');
  const input={id:'integration',requestId:'integrate-once',workId:'handoff',workVersion:1,manifest:packed.manifest,policyId:'team',checks:['unit']};
  const result=await integrateWorkPackage(f.root,f.target,peerFingerprint,input,async()=>{});
  assert.equal(result.state,'passed',result.error??'Integration should pass');assert.equal(result.checks[0]!.passed,true);
  assert.match((await readFile(join(f.target,'src','calc.cjs'))).toString(),/77/);
  assert.match((await readFile(join(result.worktree,'src','calc.cjs'))).toString(),/= 2/);
  assert.equal((await readFile(join(result.worktree,'src','new.bin')))[1],255);await assert.rejects(access(join(result.worktree,'src','old.txt')));
  assert.match((await getWorkArtifact(f.root,result.checks[0]!.evidence)).toString(),/verified actual value/);
  assert.equal((await integrateWorkPackage(f.root,f.target,peerFingerprint,input,async()=>{})).report?.digest,result.report?.digest);
  await assert.rejects(integrateWorkPackage(f.root,f.target,peerFingerprint,{...input,requestId:'different'},async()=>{}),/Conflicting/);
  await assert.rejects(releaseWorkIntegration(f.root,f.target,result.id,null),/exact retained report/);
  await writeFile(join(result.worktree,'owner-note.txt'),'retain this');
  await assert.rejects(releaseWorkIntegration(f.root,f.target,result.id,result.report!.digest),/additional files/);
  await rm(join(result.worktree,'owner-note.txt'));
  assert.ok((await releaseWorkIntegration(f.root,f.target,result.id,result.report!.digest)).releasedAt);
  await assert.rejects(access(result.worktree));
  assert.ok((await releaseWorkIntegration(f.root,f.target,result.id,result.report!.digest)).releasedAt);
  assert.equal((await getWorkArtifact(f.root,result.report!)).length,result.report!.bytes);
  const failed=await integrateWorkPackage(f.root,f.target,peerFingerprint,{...input,id:'timeout-integration',requestId:'timeout',checks:['timeout']},async()=>{});
  assert.equal(failed.state,'failed');assert.equal(failed.checks[0]!.timedOut,true);
  await writeLocalWorkCheck(f.root,{version:1,id:'tamper',workspace:f.target,peerFingerprint,command:process.execPath,args:['-e',"require('node:fs').writeFileSync('.git','gitdir: /nonexistent-check-target\\n')"],timeoutSeconds:10});
  const tampered=await integrateWorkPackage(f.root,f.target,peerFingerprint,{...input,id:'tamper-integration',requestId:'tamper',checks:['tamper']},async()=>{});
  assert.equal(tampered.state,'interrupted');assert.match(tampered.error!,/repository identity/);
  await writeLocalWorkCheck(f.root,{version:1,id:'mutate',workspace:f.target,peerFingerprint,command:process.execPath,args:['-e',"require('node:fs').writeFileSync('src/calc.cjs','exports.value=999;\\n')"],timeoutSeconds:10});
  const mutated=await integrateWorkPackage(f.root,f.target,peerFingerprint,{...input,id:'mutate-integration',requestId:'mutate',checks:['unit','mutate']},async()=>{});
  assert.equal(mutated.state,'interrupted');assert.match(mutated.error!,/changed selected integration bytes/);assert.equal(mutated.packageManifest,undefined);
  await workGit(f.target,['add','--','src/calc.cjs']);await workGit(f.target,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture conflicting head']);
  const conflict=await integrateWorkPackage(f.root,f.target,peerFingerprint,{...input,id:'conflict',requestId:'conflict'},async()=>{});
  assert.equal(conflict.state,'conflict');assert.deepEqual(conflict.conflicts,['src/calc.cjs']);await assert.rejects(access(join(conflict.worktree,'src','new.bin')));
  const unknown={...result,id:'uncertain',state:'checking'};await writeFile(join(f.root,'work-integrations','uncertain.json'),JSON.stringify(unknown));
  await assert.rejects(integrateWorkPackage(f.root,f.target,peerFingerprint,{...input,id:'new-attempt',requestId:'new-attempt'},async()=>{}),/running or uncertain/);
});
