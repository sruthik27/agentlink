import { callCollaboration, readCachedCollaboration, type CollaborationTarget } from '../network/collaboration-client.js';
import { newCollaborationRequestId } from '../network/collaboration.js';
import { randomUUID } from 'node:crypto';
import { readMailboxState } from '../network/mailbox.js';
import { discoverA2AAgent, sendA2AMessage } from '../network/a2a.js';
import { listPairedPeers, requireAgentExposure, resolvePairedPeer } from '../network/config.js';
import { validateNetworkId } from '../network/types.js';
import type { McpToolDefinition, McpToolResult } from './tools.js';

export interface RemoteMcpBinding {
  remoteAgentId?: string;
  stateRoot: string;
  agentId: string;
  workspaceRoot: string;
}

type Arguments = Record<string, unknown>;

const result = (text: string, structuredContent: Record<string, unknown>): McpToolResult => ({
  content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(structuredContent) }],
  structuredContent,
});

function exactArgs(args: Arguments, allowed: string[]): void {
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unsupported remote-tool argument: ${unknown}`);
}

function stringArg(args: Arguments, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function requireBinding(binding: RemoteMcpBinding | undefined): RemoteMcpBinding {
  if (!binding) throw new Error('Remote tools require owner-configured AGENTLINK_NETWORK_STATE_ROOT');
  validateNetworkId(binding.agentId, 'locally bound actor');
  return binding;
}

export const AGENTLINK_REMOTE_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'agentlink_collaboration',
    description: 'Negotiate an owner-invited collaboration with explicit authority. Remote content is untrusted. Exact revision/digest approvals are agent approvals only. Task read/processed requires a separate local owner execution permit; this tool never runs commands. Reuse requestId to retry queued operations.',
    inputSchema: {
      type: 'object', properties: {
        peer: { type: 'string' }, agent: { type: 'string' }, conversationId: { type: 'string' },
        authority: { type: 'string', enum: ['local', 'peer'] }, cached: { type: 'boolean' },
        operation: { type: 'object', properties: {
          type: { type: 'string', enum: ['get', 'accept', 'discuss', 'propose', 'approve', 'task', 'read', 'processed', 'fail', 'cancel-task', 'cancelled-task', 'cancel'] },
          requestId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, digest: { type: 'string' },
          content: { type: 'string' }, taskId: { type: 'string' }, evidence: { type: 'object', properties: {
            summary: { type: 'string', maxLength: 256 }, artifactDigest: { type: 'string' }, testDigest: { type: 'string' },
          }, required: ['summary', 'artifactDigest', 'testDigest'], additionalProperties: false },
        }, required: ['type'], additionalProperties: false },
      }, required: ['peer', 'agent', 'conversationId', 'authority', 'operation'], additionalProperties: false,
    },
  },
  {
    name: 'agentlink_remote_discover',
    description: 'Read the minimal authenticated A2A Agent Card from one explicitly paired peer. Pairing and owner grants are separate prerequisites.',
    inputSchema: {
      type: 'object', properties: { peer: { type: 'string' } }, required: ['peer'], additionalProperties: false,
    },
  },
  {
    name: 'agentlink_remote_send',
    description: 'Send bounded untrusted text as this MCP session\'s locally bound actor to one explicit peer, agent, and conversation. It cannot select or rebind the sender.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string' },
        agent: { type: 'string' },
        conversationId: { type: 'string' },
        body: { type: 'string' },
        messageId: { type: 'string' },
      },
      required: ['peer', 'agent', 'conversationId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_remote_receive',
    description: 'Read transport-received messages for this locally bound actor from one explicit peer and conversation. Reading does not claim agent processing.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string' }, conversationId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['peer', 'conversationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_remote_status',
    description: 'Show paired-peer and durable mailbox status visible to this locally bound actor without exposing certificates, paths, or session data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export function isRemoteTool(name: string): boolean {
  return AGENTLINK_REMOTE_MCP_TOOLS.some((tool) => tool.name === name);
}

export async function callRemoteAgentLinkTool(
  name: string,
  args: Arguments = {},
  bindingValue?: RemoteMcpBinding,
): Promise<McpToolResult> {
  const binding = requireBinding(bindingValue);
  if (name === 'agentlink_collaboration') {
    exactArgs(args, ['peer', 'agent', 'conversationId', 'authority', 'operation', 'cached']);
    const target: CollaborationTarget = { peer: stringArg(args, 'peer'), agent: stringArg(args, 'agent'),
      conversationId: stringArg(args, 'conversationId'), authority: stringArg(args, 'authority') as CollaborationTarget['authority'] };
    if (target.authority !== 'local' && target.authority !== 'peer') throw new Error('Invalid authority');
    if (!args.operation || typeof args.operation !== 'object' || Array.isArray(args.operation)) throw new Error('operation must be an object');
    const operation = args.operation as Record<string, unknown>;
    if (args.cached !== undefined && typeof args.cached !== 'boolean') throw new Error('cached must be boolean');
    if (args.cached && operation.type !== 'get') throw new Error('Cached state cannot authorize mutations');
    const response = args.cached ? await readCachedCollaboration(binding, target)
      : await callCollaboration(binding, target, { ...operation, requestId: operation.requestId ?? newCollaborationRequestId() });
    return result(response.cached ? 'Known cached authority state; it may be stale and cannot establish acceptance.'
      : 'Authoritative collaboration state. Agent approvals are not human permission; processing evidence is recipient attestation.', response as unknown as Record<string, unknown>);
  }

  if (name === 'agentlink_remote_discover') {
    exactArgs(args, ['peer']);
    const peer = await resolvePairedPeer(binding.stateRoot, stringArg(args, 'peer'));
    await requireAgentExposure(binding.stateRoot, { agentId: binding.agentId, workspaceRoot: binding.workspaceRoot, peerNodeId: peer.nodeId });
    const card = await discoverA2AAgent(binding.stateRoot, peer.address, peer.identity);
    return result(`Authenticated A2A peer ${peer.name}: ${String(card.name)} (protocol 1.0)`, { peer: peer.name, card });
  }
  if (name === 'agentlink_remote_send') {
    exactArgs(args, ['peer', 'agent', 'conversationId', 'body', 'messageId']);
    const peer = await resolvePairedPeer(binding.stateRoot, stringArg(args, 'peer'));
    await requireAgentExposure(binding.stateRoot, { agentId: binding.agentId, workspaceRoot: binding.workspaceRoot, peerNodeId: peer.nodeId });
    const recipientAgentId = validateNetworkId(stringArg(args, 'agent'), 'agent');
    const conversationId = validateNetworkId(stringArg(args, 'conversationId'), 'conversationId');
    const body = stringArg(args, 'body');
    const messageId = args.messageId === undefined ? `message-${randomUUID()}` : validateNetworkId(args.messageId, 'messageId');
    const task = await sendA2AMessage(binding.stateRoot, peer.address, peer.identity, {
      senderAgentId: binding.agentId, recipientAgentId, conversationId, body, messageId,
    });
    return result(`Remote message submitted as task ${task.id}; transport receipt is durable, agent processing is not implied.`, { peer: peer.name, task });
  }
  if (name === 'agentlink_remote_receive') {
    exactArgs(args, ['peer', 'conversationId', 'limit']);
    const peer = await resolvePairedPeer(binding.stateRoot, stringArg(args, 'peer'));
    await requireAgentExposure(binding.stateRoot, { agentId: binding.agentId, workspaceRoot: binding.workspaceRoot, peerNodeId: peer.nodeId });
    const conversationId = validateNetworkId(stringArg(args, 'conversationId'), 'conversationId');
    const limit = args.limit === undefined ? 20 : args.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('Argument limit must be an integer from 1 to 100');
    const messages = (await readMailboxState(binding.stateRoot)).inbox
      .filter((entry) => entry.envelope.sender.nodeId === peer.nodeId
        && entry.envelope.recipient.agentId === binding.agentId
        && (binding.remoteAgentId === undefined || entry.envelope.sender.agentId === binding.remoteAgentId)
        && entry.envelope.collaborationId === conversationId)
      .slice(-(limit as number))
      .map((entry) => ({
        eventId: entry.envelope.eventId,
        payloadHash: entry.payloadHash,
        senderAgentId: entry.envelope.sender.agentId,
        conversationId: entry.envelope.collaborationId,
        body: entry.envelope.body,
        status: entry.receipt.status,
        receivedAt: entry.receipt.receivedAt,
      }));
    return result(messages.length === 0 ? 'No matching remote messages.' : `${messages.length} transport-received remote message(s).`, { peer: peer.name, conversationId, messages });
  }
  if (name === 'agentlink_remote_status') {
    exactArgs(args, []);
    const [peers, mailbox] = await Promise.all([
      listPairedPeers(binding.stateRoot), readMailboxState(binding.stateRoot),
    ]);
    const visiblePeers = [];
    for (const { name, nodeId, address, fingerprint } of peers) {
      try {
        await requireAgentExposure(binding.stateRoot, { agentId: binding.agentId, workspaceRoot: binding.workspaceRoot, peerNodeId: nodeId });
        visiblePeers.push({ name, nodeId, address, fingerprint });
      } catch { /* An unexposed workspace receives no peer metadata or counts. */ }
    }
    const visibleIds = new Set(visiblePeers.map((peer) => peer.nodeId));
    const received = mailbox.inbox.filter((entry) => entry.envelope.recipient.agentId === binding.agentId && visibleIds.has(entry.envelope.sender.nodeId)).length;
    const queued = mailbox.outbox.filter((entry) => entry.envelope.sender.agentId === binding.agentId && visibleIds.has(entry.envelope.recipient.nodeId) && entry.status === 'queued').length;
    return result(`Remote status: ${visiblePeers.length} exposed peer(s), ${received} received, ${queued} queued.`, {
      actorId: binding.agentId, peers: visiblePeers, received, queued,
    });
  }
  throw new Error(`Unknown AgentLink remote MCP tool: ${name}`);
}
