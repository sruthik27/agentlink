import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from './atomic.js';
import { computeContractContentDigest, computeContractRevision } from './contract-content.js';
import {
  countRevisionApprovals,
  readConversation,
  readConversationRecords,
  type Conversation,
  type ConversationContractMutationRecord,
} from './store.js';
import { journaledWriteFiles, transactionPermittedRoots } from './transactions.js';
import {
  associateWorkspace,
  busConversationsPath,
  busContractsPath,
  busLocksPath,
  initializeWorkspaceIdentity,
  readConversationSelection,
  readSelectedConversation,
  resolveActiveParticipant,
  type WorkspaceContext,
} from './workspace.js';

export const CONTRACT_FILE = 'CONTRACT.md';
export const CONTRACT_STATUSES = ['Draft', 'Proposed', 'Accepted', 'Blocked', 'Implemented', 'Verified'] as const;
export const CONTRACT_TEMPLATES = ['api-change', 'event-contract', 'db-migration', 'frontend-backend'] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type ContractTemplate = (typeof CONTRACT_TEMPLATES)[number];

export interface ContractTemplateInput {
  conversationId?: string;
  busId?: string;
  topic?: string;
  target?: string;
  status?: ContractStatus;
  template?: ContractTemplate;
}

export interface ContractState {
  path: string;
  compatibilityPath: string;
  status: ContractStatus | null;
  conversationId?: string;
  busId?: string;
  revision?: string;
}

export interface ContractSectionUpdate {
  heading: string;
  content: string;
}

export interface ConversationContractUpdate {
  sections?: ContractSectionUpdate[];
  status?: ContractStatus;
  expectedRevision?: string;
}

export function contractPath(cwd = process.cwd()): string {
  return join(cwd, '.agentlink', CONTRACT_FILE);
}

const CONTRACT_TEMPLATE_SECTIONS: Record<ContractTemplate, string> = {
  'api-change': `## API Surface

- [ ] Endpoint, method, or operation:
- [ ] Request schema:
- [ ] Response schema:
- [ ] Errors and status behavior:

## Compatibility and Repo Work

- [ ] Breaking or non-breaking:
- [ ] Versioning, deprecation, or migration plan:
- [ ] Provider repo changes:
- [ ] Consumer repo changes:

## Verification

- [ ] Contract or schema tests:
- [ ] Cross-repo integration test:`,
  'event-contract': `## Event Contract

- [ ] Event name and version:
- [ ] Producer and consumers:
- [ ] Envelope and payload schema:
- [ ] Compatibility rules:

## Delivery Semantics and Repo Work

- [ ] Ordering and partition key:
- [ ] Delivery guarantee:
- [ ] Retry, idempotency, and deduplication:
- [ ] Producer repo changes:
- [ ] Consumer repo changes:

## Verification

- [ ] Schema compatibility tests:
- [ ] Publish-consume integration test:`,
  'db-migration': `## Schema Migration

- [ ] Tables, columns, constraints, and indexes:
- [ ] Backfill or data transformation:
- [ ] Forward migration:
- [ ] Rollback or roll-forward plan:

## Rollout and Repo Work

- [ ] Read/write compatibility window:
- [ ] Deployment order:
- [ ] Migration owner:
- [ ] Application repo changes:

## Verification

- [ ] Migration tested on production-like data:
- [ ] Data integrity and rollback checks:`,
  'frontend-backend': `## User Flow and API Boundary

- [ ] User-visible flow and states:
- [ ] Endpoints or operations:
- [ ] Request shape:
- [ ] Response or view-model shape:
- [ ] Loading, empty, and error behavior:

## Ownership and Delivery

- [ ] Frontend repo changes:
- [ ] Backend repo changes:
- [ ] Shared types or generated client:
- [ ] Dependency and rollout order:

## Verification

- [ ] Mock or contract tests:
- [ ] Integrated end-to-end path:`,
};

export function renderContract(input: ContractTemplateInput = {}): string {
  const topic = input.topic?.trim() || 'TBD';
  const target = input.target?.trim();
  const participants = target ? `- Local workspace\n- ${target}` : '- TBD';
  const markers = [
    input.busId ? `<!-- agentlink-bus: ${input.busId} -->` : undefined,
    input.conversationId ? `<!-- agentlink-conversation: ${input.conversationId} -->` : undefined,
  ].filter(Boolean).join('\n');
  const markerBlock = markers ? `\n${markers}\n` : '';
  const negotiationSections = input.template ? CONTRACT_TEMPLATE_SECTIONS[input.template] : `## Agreed Changes

TBD

## Required Work Per Repo

TBD

## Verification

TBD`;
  return `# AgentLink Contract
${markerBlock}
## Topic

${topic}

## Participants

${participants}

${negotiationSections}

## Status

${input.status ?? 'Draft'}
`;
}

export function parseContractStatus(content: string): ContractStatus | null {
  const match = content.match(/^## Status[^\S\r\n]*(?:\r?\n)+([^\r\n]+)/m);
  if (!match) return null;
  const value = match[1].trim().toLowerCase();
  return CONTRACT_STATUSES.find((status) => status.toLowerCase() === value) ?? null;
}

export function parseContractConversationId(content: string): string | undefined {
  return content.match(/<!--\s*agentlink-conversation:\s*([a-zA-Z0-9_-]+)\s*-->/)?.[1];
}

export function parseContractBusId(content: string): string | undefined {
  return content.match(/<!--\s*agentlink-bus:\s*([a-zA-Z0-9_-]+)\s*-->/)?.[1];
}

function authoritativePath(context: WorkspaceContext, conversationId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(conversationId)) throw new Error(`Invalid conversation id: ${conversationId}`);
  return join(busContractsPath(context.association.busPath), conversationId, CONTRACT_FILE);
}

export async function initializeContract(cwd = process.cwd()): Promise<string> {
  const context = await initializeWorkspaceIdentity(cwd);
  const path = contractPath(cwd);
  if (await readUtf8IfExists(path) === undefined) await atomicWriteFile(path, renderContract({ busId: context.bus.busId }));
  return path;
}

export async function writeConversationContract(
  cwd: string,
  input: Required<Pick<ContractTemplateInput, 'conversationId' | 'topic'>> & Pick<ContractTemplateInput, 'target' | 'status' | 'template'>,
): Promise<string> {
  const context = await initializeWorkspaceIdentity(cwd);
  const actor = await resolveActiveParticipant(cwd);
  await readConversation(cwd, input.conversationId);
  const path = authoritativePath(context, input.conversationId);
  const content = renderContract({ ...input, busId: context.bus.busId });
  await withFileLock(busLocksPath(context.association.busPath), `conversation-${input.conversationId}`, async () => {
    const existing = await readUtf8IfExists(path);
    if (existing !== undefined) throw new Error(`Contract already exists for conversation ${input.conversationId}`);
    const transactionId = `txn_${randomUUID()}`;
    const records = await readConversationRecords(cwd, input.conversationId);
    const audit: ConversationContractMutationRecord = {
      type: 'contract_mutation', transactionId, participantId: actor.participantId,
      workspaceId: actor.workspaceId, revision: computeContractRevision(content),
      status: parseContractStatus(content) ?? 'Draft', timestamp: new Date().toISOString(),
    };
    await journaledWriteFiles(context.association.busPath, `conversation-${input.conversationId}`, [
      { path, content },
      {
        path: join(busConversationsPath(context.association.busPath), `${input.conversationId}.jsonl`),
        content: `${[...records, audit].map((record) => JSON.stringify(record)).join('\n')}\n`,
      },
      {
        path: join(context.statePath, 'selected.json'),
        content: `${JSON.stringify({
          schemaVersion: 1,
          busId: context.bus.busId,
          conversationId: input.conversationId,
          compatibilityDigest: computeContractContentDigest(content),
        }, null, 2)}\n`,
      },
      { path: contractPath(context.rootPath), content },
    ], transactionPermittedRoots(
      context.association.busPath,
      context.bus.workspaces.map((workspace) => workspace.canonicalPath),
    ), transactionId);
  });
  return path;
}

export async function readContractState(cwd = process.cwd(), conversationId?: string): Promise<ContractState> {
  const context = await initializeWorkspaceIdentity(cwd);
  const selected = conversationId ?? await readSelectedConversation(cwd);
  const compatibilityPath = contractPath(context.rootPath);
  const path = selected ? authoritativePath(context, selected) : compatibilityPath;
  const content = await readUtf8IfExists(path);
  if (content === undefined) return { path, compatibilityPath, status: null, ...(selected ? { conversationId: selected, busId: context.bus.busId } : {}) };
  const parsedConversation = parseContractConversationId(content);
  return {
    path,
    compatibilityPath,
    status: parseContractStatus(content),
    ...(selected || parsedConversation ? { conversationId: selected ?? parsedConversation } : {}),
    ...(selected ? { busId: context.bus.busId } : parseContractBusId(content) ? { busId: parseContractBusId(content) } : {}),
    revision: computeContractRevision(content),
  };
}

function normalizeContractHeading(heading: string): string {
  const normalized = heading.replace(/^#+\s*/, '').trim();
  if (!normalized) throw new Error('Contract section heading cannot be empty');
  if (/\r|\n/.test(normalized)) throw new Error('Contract section heading must be one line');
  return normalized;
}

function normalizeContractSectionContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) throw new Error('Contract section content cannot be empty');
  return normalized;
}

export function mergeContractSections(content: string, updates: ContractSectionUpdate[]): string {
  if (updates.length === 0) return content;
  let next = content.replace(/\r\n/g, '\n').replace(/\s*$/, '\n');
  for (const update of updates) {
    const heading = normalizeContractHeading(update.heading);
    if (heading.toLowerCase() === 'status') throw new Error('Use contract status update for the Status section');
    const body = normalizeContractSectionContent(update.content);
    const replacement = `## ${heading}\n\n${body}\n`;
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionPattern = new RegExp(`(^|\\n)## ${escapedHeading}[ \\t]*\\n[\\s\\S]*?(?=\\n## |$)`, 'i');
    if (sectionPattern.test(next)) next = next.replace(sectionPattern, (_match, prefix: string) => `${prefix}${replacement.trimEnd()}`);
    else if (/^## Status[ \t]*\n/im.test(next)) next = next.replace(/^## Status[ \t]*\n/im, `${replacement}\n## Status\n`);
    else next = `${next.trimEnd()}\n\n${replacement}`;
  }
  return next.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

function replaceStatus(content: string, status: ContractStatus): string {
  if (!CONTRACT_STATUSES.includes(status)) throw new Error(`Invalid contract status: ${status}`);
  const heading = /^## Status[^\S\r\n]*(?:\r?\n)+[^\r\n]*/m;
  if (!heading.test(content)) throw new Error('Contract has no Status section');
  return content.replace(heading, `## Status\n\n${status}`);
}

function assertApprovalGate(conversation: Conversation, revision: string): void {
  if (!conversation.requiredApprovals) return;
  const count = countRevisionApprovals(conversation, revision);
  if (count < conversation.requiredApprovals) {
    throw new Error(`Cannot mark Accepted: conversation ${conversation.id} has ${count}/${conversation.requiredApprovals} approvals for revision ${revision}`);
  }
}

const APPROVAL_BOUND_STATUSES = new Set<ContractStatus>(['Accepted', 'Implemented', 'Verified']);

async function assertSelectedCompatibilityViewUnmodified(
  cwd: string,
  conversationId: string,
  authoritativeContent: string,
): Promise<void> {
  const selection = await readConversationSelection(cwd);
  if (selection?.conversationId !== conversationId) return;
  const compatibilityContent = await readUtf8IfExists(contractPath(cwd));
  const expectedCompatibilityDigest = selection.compatibilityDigest
    ?? computeContractContentDigest(authoritativeContent);
  if (compatibilityContent !== undefined
    && computeContractContentDigest(compatibilityContent) !== expectedCompatibilityDigest) {
    throw new Error(`The generated compatibility view was modified: ${contractPath(cwd)}. Authoritative data was not changed. Preserve the edits elsewhere, then run \`agentlink contract --conversation ${conversationId} --refresh\` to regenerate it.`);
  }
}

export async function updateConversationContract(cwd: string, conversationId: string, update: ConversationContractUpdate): Promise<ContractState> {
  const context = await initializeWorkspaceIdentity(cwd);
  const actor = await resolveActiveParticipant(cwd);
  const path = authoritativePath(context, conversationId);
  let updatedContent: string | undefined;
  await withFileLock(busLocksPath(context.association.busPath), `conversation-${conversationId}`, async () => {
    const current = await readUtf8IfExists(path);
    if (current === undefined) throw new Error(`Conversation ${conversationId} has no authoritative contract`);
    await assertSelectedCompatibilityViewUnmodified(cwd, conversationId, current);
    const currentRevision = computeContractRevision(current);
    if (update.expectedRevision !== undefined && update.expectedRevision !== currentRevision) {
      throw new Error(`Rejected stale contract revision ${update.expectedRevision}; current revision is ${currentRevision}`);
    }
    let prospective = mergeContractSections(current, update.sections ?? []);
    if (update.status !== undefined) prospective = replaceStatus(prospective, update.status);
    const prospectiveRevision = computeContractRevision(prospective);
    const prospectiveStatus = parseContractStatus(prospective);
    if (prospectiveStatus && APPROVAL_BOUND_STATUSES.has(prospectiveStatus)) {
      const conversation = await readConversation(cwd, conversationId);
      assertApprovalGate(conversation, prospectiveRevision);
    }
    const transactionId = `txn_${randomUUID()}`;
    const records = await readConversationRecords(cwd, conversationId);
    const audit: ConversationContractMutationRecord = {
      type: 'contract_mutation', transactionId, participantId: actor.participantId,
      workspaceId: actor.workspaceId, previousRevision: currentRevision,
      revision: prospectiveRevision, status: prospectiveStatus ?? 'Unknown', timestamp: new Date().toISOString(),
    };
    const writes = [
      { path, content: prospective },
      {
        path: join(busConversationsPath(context.association.busPath), `${conversationId}.jsonl`),
        content: `${[...records, audit].map((record) => JSON.stringify(record)).join('\n')}\n`,
      },
    ];
    if (await readSelectedConversation(cwd) === conversationId) {
      writes.push({
        path: join(context.statePath, 'selected.json'),
        content: `${JSON.stringify({
          schemaVersion: 1,
          busId: context.bus.busId,
          conversationId,
          compatibilityDigest: computeContractContentDigest(prospective),
        }, null, 2)}\n`,
      });
      writes.push({ path: contractPath(context.rootPath), content: prospective });
    }
    await journaledWriteFiles(context.association.busPath, `conversation-${conversationId}`, writes,
      transactionPermittedRoots(context.association.busPath, context.bus.workspaces.map((workspace) => workspace.canonicalPath)),
      transactionId);
    updatedContent = prospective;
  });
  if (updatedContent === undefined) throw new Error(`Conversation ${conversationId} contract update did not complete`);
  return readContractState(cwd, conversationId);
}

export async function refreshContractCompatibilityView(cwd: string, conversationId: string): Promise<ContractState> {
  const context = await initializeWorkspaceIdentity(cwd);
  const path = authoritativePath(context, conversationId);
  const content = await readUtf8IfExists(path);
  if (content === undefined) throw new Error(`Conversation ${conversationId} has no authoritative contract`);
  await journaledWriteFiles(context.association.busPath, `compatibility-${conversationId}`, [
    {
      path: join(context.statePath, 'selected.json'),
      content: `${JSON.stringify({
        schemaVersion: 1,
        busId: context.bus.busId,
        conversationId,
        compatibilityDigest: computeContractContentDigest(content),
      }, null, 2)}\n`,
    },
    { path: contractPath(context.rootPath), content },
  ], transactionPermittedRoots(
    context.association.busPath,
    context.bus.workspaces.map((workspace) => workspace.canonicalPath),
  ));
  return readContractState(cwd, conversationId);
}

export async function updateContractSections(cwd: string, updates: ContractSectionUpdate[], conversationId?: string, expectedRevision?: string): Promise<ContractState> {
  const id = conversationId ?? await readSelectedConversation(cwd);
  if (!id) throw new Error('No selected contract. Specify a conversation id.');
  return updateConversationContract(cwd, id, { sections: updates, expectedRevision });
}

export async function updateContractStatus(cwd: string, status: ContractStatus, conversationId?: string, expectedRevision?: string): Promise<ContractState> {
  const id = conversationId ?? await readSelectedConversation(cwd);
  if (!id) throw new Error('No selected contract. Specify a conversation id.');
  return updateConversationContract(cwd, id, { status, expectedRevision });
}

export async function syncContractToWorkspace(sourceCwd: string, targetCwd: string, conversationId?: string): Promise<string> {
  const sourceState = await readContractState(sourceCwd, conversationId);
  if (!sourceState.conversationId || sourceState.status === null) throw new Error('No conversation-scoped contract selected to sync');
  await associateWorkspace(sourceCwd, targetCwd, { conversationId: sourceState.conversationId });
  await refreshContractCompatibilityView(targetCwd, sourceState.conversationId);
  return contractPath(targetCwd);
}
