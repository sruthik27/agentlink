import { basename, resolve } from 'node:path';
import { appendMessage, approveConversation, closeConversation, createConversation, ensureWorkspace } from './store.js';
import { contractPath, syncContractToWorkspace, updateContractSections, updateContractStatus, writeConversationContract } from './contract.js';

export interface DemoInput {
  topic?: string;
  peerPath: string;
  maxRounds?: number;
  requiredApprovals?: number;
}

export interface DemoResult {
  conversationId: string;
  topic: string;
  localPath: string;
  peerPath: string;
  localContractPath: string;
  peerContractPath: string;
  status: 'Accepted';
  messages: number;
  approvals: number;
}

function assertPeerPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Peer repo path cannot be empty');
  return resolve(trimmed);
}

export async function runDemo(cwd = process.cwd(), input: DemoInput): Promise<DemoResult> {
  const localPath = resolve(cwd);
  const peerPath = assertPeerPath(input.peerPath);
  const topic = input.topic?.trim() || 'Demo API contract: account summary endpoint';
  const maxRounds = input.maxRounds ?? 6;
  const requiredApprovals = input.requiredApprovals ?? 2;
  const peerName = basename(peerPath) || peerPath;

  await ensureWorkspace(localPath);
  await ensureWorkspace(peerPath);

  const conversation = await createConversation(localPath, {
    topic,
    target: peerName,
    maxRounds,
    requiredApprovals,
  });

  await writeConversationContract(localPath, {
    conversationId: conversation.id,
    topic,
    target: peerName,
    template: 'api-change',
  });

  await appendMessage(localPath, conversation.id, {
    role: 'assistant',
    from: 'producer-agent',
    body: 'Proposal: add GET /accounts/:id/summary returning { id, balance, currency, expiresAt }.',
  });
  await updateContractSections(localPath, [{
    heading: 'API Surface',
    content: [
      '- [x] Endpoint: `GET /accounts/:id/summary`',
      '- [x] Request schema: path param `id` as string',
      '- [x] Response schema: `{ id: string, balance: number, currency: string, expiresAt: string }`',
      '- [x] Errors: `404` for missing account, `503` for unavailable ledger',
    ].join('\n'),
  }]);

  await appendMessage(localPath, conversation.id, {
    role: 'assistant',
    from: 'consumer-agent',
    body: 'Accepted if expiresAt is ISO-8601 UTC and 404 remains non-retryable.',
  });
  await updateContractSections(localPath, [{
    heading: 'Verification',
    content: [
      '- [x] Producer adds contract/schema test for summary response',
      '- [x] Consumer adds fixture test for ISO-8601 `expiresAt` handling',
      '- [x] Cross-repo smoke: shared `.agentlink/CONTRACT.md` synced to both repos',
    ].join('\n'),
  }]);

  await approveConversation(localPath, conversation.id, { from: 'producer-agent' });
  await approveConversation(localPath, conversation.id, { from: 'consumer-agent' });
  await updateContractStatus(localPath, 'Accepted');
  await closeConversation(localPath, conversation.id);
  const peerContractPath = await syncContractToWorkspace(localPath, peerPath);

  return {
    conversationId: conversation.id,
    topic,
    localPath,
    peerPath,
    localContractPath: contractPath(localPath),
    peerContractPath,
    status: 'Accepted',
    messages: 2,
    approvals: requiredApprovals,
  };
}

export function renderDemoMarkdown(result: DemoResult): string {
  return [
    '# AgentLink Demo Result',
    '',
    `- Conversation: ${result.conversationId}`,
    `- Topic: ${result.topic}`,
    `- Status: ${result.status}`,
    `- Local repo: ${result.localPath}`,
    `- Peer repo: ${result.peerPath}`,
    `- Local contract: ${result.localContractPath}`,
    `- Peer contract: ${result.peerContractPath}`,
    `- Messages: ${result.messages}`,
    `- Approvals: ${result.approvals}`,
    '',
    'Next: run `agentlink replay --conversation ' + result.conversationId + '` in the local repo to inspect the append-only negotiation timeline.',
  ].join('\n');
}
