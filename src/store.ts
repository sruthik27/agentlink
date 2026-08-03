import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const AGENTLINK_DIRECTORY = '.agentlink';
export const CONVERSATIONS_DIRECTORY = 'conversations';

export type ConversationStatus = 'open' | 'closed';

export interface ConversationStartedRecord {
  type: 'conversation';
  id: string;
  topic: string;
  createdAt: string;
  status: 'open';
  target?: string;
  maxRounds?: number;
  requiredApprovals?: number;
}

export interface ConversationMessageRecord {
  type: 'message';
  role: string;
  from: string;
  body: string;
  timestamp: string;
}

export interface ConversationStatusRecord {
  type: 'status';
  status: ConversationStatus;
  timestamp: string;
}

export interface ConversationApprovalRecord {
  type: 'approval';
  from: string;
  timestamp: string;
}

export type ConversationRecord =
  | ConversationStartedRecord
  | ConversationMessageRecord
  | ConversationStatusRecord
  | ConversationApprovalRecord;

export interface Conversation {
  id: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationStatus;
  target?: string;
  maxRounds?: number;
  requiredApprovals?: number;
  messages: ConversationMessageRecord[];
  approvals: ConversationApprovalRecord[];
}

export interface ConversationSummary extends Omit<Conversation, 'messages'> {
  messageCount: number;
}

export interface CreateConversationInput {
  topic: string;
  target?: string;
  id?: string;
  createdAt?: string;
  maxRounds?: number;
  requiredApprovals?: number;
}

export interface AppendMessageInput {
  role: string;
  from: string;
  body: string;
  timestamp?: string;
}

export interface ApproveConversationInput {
  from: string;
  timestamp?: string;
}

export function workspacePath(cwd = process.cwd()): string {
  return join(cwd, AGENTLINK_DIRECTORY);
}

export function conversationsPath(cwd = process.cwd()): string {
  return join(workspacePath(cwd), CONVERSATIONS_DIRECTORY);
}

export async function ensureWorkspace(cwd = process.cwd()): Promise<string> {
  const directory = conversationsPath(cwd);
  await mkdir(directory, { recursive: true });
  return workspacePath(cwd);
}

function assertNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} cannot be empty`);
  return trimmed;
}

function assertPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assertConversationId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid conversation id: ${id}`);
  }
  return id;
}

export function conversationPath(cwd: string, id: string): string {
  return join(conversationsPath(cwd), `${assertConversationId(id)}.jsonl`);
}

async function appendRecord(cwd: string, id: string, record: ConversationRecord): Promise<void> {
  await appendFile(conversationPath(cwd, id), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function createConversation(
  cwd: string,
  input: CreateConversationInput,
): Promise<Conversation> {
  await ensureWorkspace(cwd);

  const id = assertConversationId(input.id ?? randomUUID());
  const createdAt = input.createdAt ?? new Date().toISOString();
  const target = input.target?.trim();
  const record: ConversationStartedRecord = {
    type: 'conversation',
    id,
    topic: assertNonEmpty(input.topic, 'Topic'),
    createdAt,
    status: 'open',
    ...(target ? { target } : {}),
    ...(assertPositiveInteger(input.maxRounds, 'Max rounds') ? { maxRounds: input.maxRounds } : {}),
    ...(assertPositiveInteger(input.requiredApprovals, 'Required approvals') ? { requiredApprovals: input.requiredApprovals } : {}),
  };

  await writeFile(conversationPath(cwd, id), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  return {
    id,
    topic: record.topic,
    createdAt,
    updatedAt: createdAt,
    status: 'open',
    ...(record.target ? { target: record.target } : {}),
    ...(record.maxRounds ? { maxRounds: record.maxRounds } : {}),
    ...(record.requiredApprovals ? { requiredApprovals: record.requiredApprovals } : {}),
    messages: [],
    approvals: [],
  };
}

export async function readConversationRecords(cwd: string, id: string): Promise<ConversationRecord[]> {
  let content: string;
  try {
    content = await readFile(conversationPath(cwd, id), 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') throw new Error(`Conversation not found: ${id}`);
    throw error;
  }

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as ConversationRecord;
      } catch {
        throw new Error(`Invalid JSONL in conversation ${id} at line ${index + 1}`);
      }
    });
}

function hydrateConversation(id: string, records: ConversationRecord[]): Conversation {
  const started = records[0];
  if (!started || started.type !== 'conversation' || started.id !== id) {
    throw new Error(`Conversation ${id} has no valid start record`);
  }

  let status: ConversationStatus = started.status;
  let updatedAt = started.createdAt;
  const messages: ConversationMessageRecord[] = [];
  const approvals: ConversationApprovalRecord[] = [];

  for (const record of records.slice(1)) {
    if (record.type === 'message') {
      messages.push(record);
      updatedAt = record.timestamp;
    } else if (record.type === 'status') {
      status = record.status;
      updatedAt = record.timestamp;
    } else if (record.type === 'approval') {
      approvals.push(record);
      updatedAt = record.timestamp;
    }
  }

  return {
    id: started.id,
    topic: started.topic,
    createdAt: started.createdAt,
    updatedAt,
    status,
    ...(started.target ? { target: started.target } : {}),
    ...(started.maxRounds ? { maxRounds: started.maxRounds } : {}),
    ...(started.requiredApprovals ? { requiredApprovals: started.requiredApprovals } : {}),
    messages,
    approvals,
  };
}

export async function readConversation(cwd: string, id: string): Promise<Conversation> {
  return hydrateConversation(assertConversationId(id), await readConversationRecords(cwd, id));
}

export async function listConversations(cwd = process.cwd()): Promise<ConversationSummary[]> {
  await ensureWorkspace(cwd);
  const entries = await readdir(conversationsPath(cwd), { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name.slice(0, -'.jsonl'.length));
  const conversations = await Promise.all(ids.map((id) => readConversation(cwd, id)));

  return conversations
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(({ messages, ...conversation }) => ({
      ...conversation,
      messageCount: messages.length,
    }));
}

export async function resolveConversation(
  cwd: string,
  id?: string,
  options: { allowLatestClosed?: boolean } = {},
): Promise<Conversation> {
  if (id) return readConversation(cwd, id);

  const conversations = await listConversations(cwd);
  const latest = conversations.find((conversation) => conversation.status === 'open')
    ?? (options.allowLatestClosed ? conversations[0] : undefined);
  if (!latest) throw new Error('No open conversation found. Start one with `agentlink start`.');
  return readConversation(cwd, latest.id);
}

export async function appendMessage(
  cwd: string,
  id: string,
  input: AppendMessageInput,
): Promise<ConversationMessageRecord> {
  const conversation = await readConversation(cwd, id);
  if (conversation.status !== 'open') throw new Error(`Conversation ${id} is closed`);
  if (conversation.maxRounds !== undefined && conversation.messages.length >= conversation.maxRounds) {
    throw new Error(`Conversation ${id} reached its max round limit (${conversation.maxRounds})`);
  }

  const record: ConversationMessageRecord = {
    type: 'message',
    role: assertNonEmpty(input.role, 'Role'),
    from: assertNonEmpty(input.from, 'From'),
    body: assertNonEmpty(input.body, 'Message body'),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  await appendRecord(cwd, id, record);
  return record;
}

export async function approveConversation(
  cwd: string,
  id: string,
  input: ApproveConversationInput,
): Promise<ConversationApprovalRecord> {
  const conversation = await readConversation(cwd, id);
  if (conversation.status !== 'open') throw new Error(`Conversation ${id} is closed`);
  const from = assertNonEmpty(input.from, 'From');
  if (conversation.approvals.some((approval) => approval.from === from)) {
    throw new Error(`Conversation ${id} already has approval from ${from}`);
  }
  const record: ConversationApprovalRecord = {
    type: 'approval',
    from,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  await appendRecord(cwd, id, record);
  return record;
}

export async function closeConversation(
  cwd: string,
  id: string,
  timestamp = new Date().toISOString(),
): Promise<Conversation> {
  const conversation = await readConversation(cwd, id);
  if (conversation.status === 'closed') return conversation;

  await appendRecord(cwd, id, {
    type: 'status',
    status: 'closed',
    timestamp,
  });
  return readConversation(cwd, id);
}
