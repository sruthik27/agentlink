import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureWorkspace, workspacePath } from './store.js';

export const CONTRACT_FILE = 'CONTRACT.md';
export const CONTRACT_STATUSES = [
  'Draft',
  'Proposed',
  'Accepted',
  'Blocked',
  'Implemented',
  'Verified',
] as const;
export const CONTRACT_TEMPLATES = [
  'api-change',
  'event-contract',
  'db-migration',
  'frontend-backend',
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type ContractTemplate = (typeof CONTRACT_TEMPLATES)[number];

export interface ContractTemplateInput {
  conversationId?: string;
  topic?: string;
  target?: string;
  status?: ContractStatus;
  template?: ContractTemplate;
}

export interface ContractState {
  path: string;
  status: ContractStatus | null;
  conversationId?: string;
}

export interface ContractSectionUpdate {
  heading: string;
  content: string;
}

export function contractPath(cwd = process.cwd()): string {
  return join(workspacePath(cwd), CONTRACT_FILE);
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
  const marker = input.conversationId
    ? `\n<!-- agentlink-conversation: ${input.conversationId} -->\n`
    : '';
  const negotiationSections = input.template
    ? CONTRACT_TEMPLATE_SECTIONS[input.template]
    : `## Agreed Changes

TBD

## Required Work Per Repo

TBD

## Verification

TBD`;

  return `# AgentLink Contract
${marker}
## Topic

${topic}

## Participants

${participants}

${negotiationSections}

## Status

${input.status ?? 'Draft'}
`;
}

export async function initializeContract(cwd = process.cwd()): Promise<string> {
  const path = contractPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, renderContract(), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return path;
}

export async function writeConversationContract(
  cwd: string,
  input: Required<Pick<ContractTemplateInput, 'conversationId' | 'topic'>>
    & Pick<ContractTemplateInput, 'target' | 'status' | 'template'>,
): Promise<string> {
  const path = contractPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderContract(input), 'utf8');
  return path;
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

export async function readContractState(cwd = process.cwd()): Promise<ContractState> {
  const path = contractPath(cwd);
  try {
    const content = await readFile(path, 'utf8');
    return {
      path,
      status: parseContractStatus(content),
      ...(parseContractConversationId(content)
        ? { conversationId: parseContractConversationId(content) }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, status: null };
    throw error;
  }
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

export function mergeContractSections(
  content: string,
  updates: ContractSectionUpdate[],
): string {
  if (updates.length === 0) return content;

  let next = content.replace(/\r\n/g, '\n').replace(/\s*$/, '\n');
  for (const update of updates) {
    const heading = normalizeContractHeading(update.heading);
    if (heading.toLowerCase() === 'status') {
      throw new Error('Use contract status update for the Status section');
    }
    const body = normalizeContractSectionContent(update.content);
    const replacement = `## ${heading}\n\n${body}\n`;
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionPattern = new RegExp(`(^|\\n)## ${escapedHeading}[ \\t]*\\n[\\s\\S]*?(?=\\n## |$)`, 'i');

    if (sectionPattern.test(next)) {
      next = next.replace(sectionPattern, (_match, prefix: string) => `${prefix}${replacement.trimEnd()}`);
      continue;
    }

    const statusPattern = /^## Status[ \t]*\n/im;
    if (statusPattern.test(next)) {
      next = next.replace(statusPattern, `${replacement}\n## Status\n`);
    } else {
      next = `${next.trimEnd()}\n\n${replacement}`;
    }
  }

  return next.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

export async function updateContractSections(
  cwd: string,
  updates: ContractSectionUpdate[],
): Promise<ContractState> {
  const path = contractPath(cwd);
  const content = await readFile(path, 'utf8');
  await writeFile(path, mergeContractSections(content, updates), 'utf8');
  return readContractState(cwd);
}

export async function updateContractStatus(
  cwd: string,
  status: ContractStatus,
): Promise<ContractState> {
  if (!CONTRACT_STATUSES.includes(status)) throw new Error(`Invalid contract status: ${status}`);
  const path = contractPath(cwd);
  const content = await readFile(path, 'utf8');
  const heading = /^## Status[^\S\r\n]*(?:\r?\n)+[^\r\n]*/m;
  if (!heading.test(content)) throw new Error(`Contract has no Status section: ${path}`);
  await writeFile(path, content.replace(heading, `## Status\n\n${status}`), 'utf8');
  return readContractState(cwd);
}

export async function syncContractToWorkspace(
  sourceCwd: string,
  targetCwd: string,
): Promise<string> {
  const trimmedTarget = targetCwd.trim();
  if (!trimmedTarget) throw new Error('Target workspace path cannot be empty');

  const sourcePath = contractPath(sourceCwd);
  const content = await readFile(sourcePath, 'utf8');
  await ensureWorkspace(trimmedTarget);
  const targetPath = contractPath(trimmedTarget);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}
