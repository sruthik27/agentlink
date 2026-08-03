import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_TEMPLATES,
  contractPath,
  initializeContract,
  mergeContractSections,
  parseContractConversationId,
  parseContractStatus,
  readContractState,
  renderContract,
  syncContractToWorkspace,
  updateContractSections,
  updateContractStatus,
  writeConversationContract,
} from './contract.js';

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentlink-contract-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('contract template carries conversation context and exposes its state', async (t) => {
  const cwd = await temporaryWorkspace(t);
  const path = await writeConversationContract(cwd, {
    conversationId: 'conversation-1',
    topic: 'OAuth contract change',
    target: 'api-agent',
  });
  const content = await readFile(path, 'utf8');

  assert.match(content, /## Topic\s+OAuth contract change/);
  assert.match(content, /## Participants\s+- Local workspace\s+- api-agent/);
  assert.equal(parseContractStatus(content), 'Draft');
  assert.equal(parseContractConversationId(content), 'conversation-1');
  assert.deepEqual(await readContractState(cwd), {
    path,
    status: 'Draft',
    conversationId: 'conversation-1',
  });

  assert.equal((await updateContractStatus(cwd, 'Accepted')).status, 'Accepted');
  assert.equal(parseContractStatus(await readFile(path, 'utf8')), 'Accepted');
});

test('contract templates render focused deterministic negotiation checklists', () => {
  const expectedSections = {
    'api-change': [
      '## API Surface',
      '- [ ] Provider repo changes:',
      '- [ ] Contract or schema tests:',
    ],
    'event-contract': [
      '## Event Contract',
      '- [ ] Retry, idempotency, and deduplication:',
      '- [ ] Publish-consume integration test:',
    ],
    'db-migration': [
      '## Schema Migration',
      '- [ ] Read/write compatibility window:',
      '- [ ] Data integrity and rollback checks:',
    ],
    'frontend-backend': [
      '## User Flow and API Boundary',
      '- [ ] Frontend repo changes:',
      '- [ ] Integrated end-to-end path:',
    ],
  } satisfies Record<(typeof CONTRACT_TEMPLATES)[number], string[]>;

  assert.deepEqual(Object.keys(expectedSections), [...CONTRACT_TEMPLATES]);
  for (const template of CONTRACT_TEMPLATES) {
    const content = renderContract({ topic: 'Focused negotiation', template });
    for (const section of expectedSections[template]) {
      assert.ok(content.includes(section), `${template} contract should include "${section}"`);
    }
    assert.doesNotMatch(content, /## Agreed Changes\s+TBD/);
    assert.equal(parseContractStatus(content), 'Draft');
  }
});



test('contract section merge replaces existing sections and inserts missing sections before status', async (t) => {
  const cwd = await temporaryWorkspace(t);
  const path = await writeConversationContract(cwd, {
    conversationId: 'conversation-1',
    topic: 'Producer API shape',
    target: 'consumer-repo',
    template: 'api-change',
    status: 'Proposed',
  });

  const state = await updateContractSections(cwd, [
    {
      heading: 'API Surface',
      content: '- [x] Endpoint: `GET /accounts/:id/summary`\n- [x] Response schema: `{ id, balance, expiresAt }`',
    },
    {
      heading: 'Approval Gates',
      content: '- [ ] Provider and consumer agents must both accept before implementation.',
    },
  ]);
  const content = await readFile(path, 'utf8');

  assert.deepEqual(state, {
    path,
    status: 'Proposed',
    conversationId: 'conversation-1',
  });
  assert.match(content, /agentlink-conversation: conversation-1/);
  assert.match(content, /## API Surface\s+- \[x\] Endpoint: `GET \/accounts\/:id\/summary`/);
  assert.doesNotMatch(content, /- \[ \] Request schema:/);
  assert.match(content, /## Approval Gates\s+- \[ \] Provider and consumer agents must both accept before implementation\.\s+## Status\s+Proposed/);
});

test('contract section merge rejects status-section edits', () => {
  assert.throws(
    () => mergeContractSections(renderContract(), [{ heading: 'Status', content: 'Accepted' }]),
    /Use contract status update for the Status section/,
  );
});

test('contract initialization is idempotent and does not overwrite existing work', async (t) => {
  const cwd = await temporaryWorkspace(t);
  const path = await initializeContract(cwd);
  const edited = `${renderContract({ topic: 'Hand-edited topic' })}\nNotes stay here.\n`;
  await writeFile(path, edited, 'utf8');

  assert.equal(await initializeContract(cwd), contractPath(cwd));
  assert.equal(await readFile(path, 'utf8'), edited);
});

test('contract can be synced into another repo workspace', async (t) => {
  const source = await temporaryWorkspace(t);
  const target = await temporaryWorkspace(t);
  const sourcePath = await writeConversationContract(source, {
    conversationId: 'conversation-1',
    topic: 'Producer API shape',
    target: 'consumer-repo',
    status: 'Proposed',
  });

  const targetPath = await syncContractToWorkspace(source, target);

  assert.equal(targetPath, contractPath(target));
  assert.equal(await readFile(targetPath, 'utf8'), await readFile(sourcePath, 'utf8'));
  assert.deepEqual(await readContractState(target), {
    path: targetPath,
    status: 'Proposed',
    conversationId: 'conversation-1',
  });
});
