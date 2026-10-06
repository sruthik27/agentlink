import {
  MESSAGE_KINDS,
  MESSAGE_REFERENCE_TYPES,
  ackMessages,
  appendMessage,
  approveConversation,
  capWarning,
  closeConversation,
  createConversation,
  joinConversation,
  listConversations,
  readConversation,
  readMessages,
  resolveConversation,
  revokeConversationParticipant,
  setMessageCap,
  waitForMessages,
  type MessageKind,
  type MessageReference,
} from '../store.js';
import { CONTRACT_STATUSES, readContractState, syncContractToWorkspace, updateConversationContract, writeConversationContract, type ContractStatus } from '../contract.js';
import { filterAgentPanes, listTmuxPanes } from '../tmux.js';
import { heartbeatAgent, listAgentRegistrations, registerAgent, unregisterAgent } from '../workspace.js';
import { notifyMessage, retryNotification } from '../notifications.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

type ToolArguments = Record<string, unknown>;

export interface McpCallContext {
  signal?: AbortSignal;
}

function stringArg(args: ToolArguments, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: ${name}`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`Argument ${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && required) throw new Error(`Argument ${name} cannot be empty`);
  return trimmed || undefined;
}

function preservedStringArg(args: ToolArguments, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Error(`Argument ${name} must be a string`);
  if (!value.trim()) throw new Error(`Argument ${name} cannot be empty`);
  return value;
}

function optionalNumberArg(args: ToolArguments, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Argument ${name} must be a positive integer`);
  }
  return value;
}

function numberArg(args: ToolArguments, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Argument ${name} must be a positive integer`);
  }
  return value;
}

function booleanArg(args: ToolArguments, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Argument ${name} must be a boolean`);
  return value;
}

function statusArg(args: ToolArguments, name: string): ContractStatus {
  const value = stringArg(args, name, true)!;
  const status = CONTRACT_STATUSES.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  if (!status) throw new Error(`Invalid contract status: ${value}. Expected one of: ${CONTRACT_STATUSES.join(', ')}`);
  return status;
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function structuredResult(text: string, structuredContent: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

function messageKindArg(args: ToolArguments): MessageKind | undefined {
  const value = stringArg(args, 'kind');
  if (value === undefined) return undefined;
  if (!MESSAGE_KINDS.includes(value as MessageKind)) throw new Error(`Invalid message kind: ${value}. Expected one of: ${MESSAGE_KINDS.join(', ')}`);
  return value as MessageKind;
}

function messageRefsArg(args: ToolArguments): MessageReference[] | undefined {
  const value = args.refs;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('Argument refs must be an array');
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`Argument refs[${index}] must be an object`);
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.type !== 'string' || !MESSAGE_REFERENCE_TYPES.includes(candidate.type as MessageReference['type'])) {
      throw new Error(`Argument refs[${index}].type must be one of: ${MESSAGE_REFERENCE_TYPES.join(', ')}`);
    }
    if (typeof candidate.value !== 'string') throw new Error(`Argument refs[${index}].value must be a string`);
    return { type: candidate.type as MessageReference['type'], value: candidate.value };
  });
}

export const AGENTLINK_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'agentlink_list_agents',
    description: 'List active, explicitly registered IDE/harness participants on the shared bus. Expired registrations are cleaned up. No tmux or filesystem crawling is required.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agentlink_register_agent',
    description: 'Register the configured stable participant as an expiring IDE/harness endpoint. An adapter id is only a reference; executable trust remains in user config outside the repo.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        clientKind: { type: 'string', default: 'mcp' },
        ttlSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
        notificationAdapterId: { type: 'string' },
        registrationId: { type: 'string', description: 'Optional stable lease id to renew deterministically.' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_heartbeat_agent',
    description: 'Renew an active registration owned by the configured stable participant.',
    inputSchema: {
      type: 'object',
      properties: {
        registrationId: { type: 'string' },
        ttlSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
      },
      required: ['registrationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_unregister_agent',
    description: 'Remove an IDE/harness registration owned by the configured stable participant.',
    inputSchema: {
      type: 'object',
      properties: { registrationId: { type: 'string' } },
      required: ['registrationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_list_tmux_agents',
    description: 'Optionally list coding-agent tmux panes. Absence of tmux is non-fatal and does not affect core AgentLink workflows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agentlink_list_conversations',
    description: 'List conversations on the authoritative bus with ids, topics, status, message counts, and latest message activity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agentlink_start_conversation',
    description: 'Start a structured AgentLink conversation in the current workspace and create CONTRACT.md.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Coordination topic or contract change.' },
        target: { type: 'string', description: 'Optional target pane, agent, or repo label.' },
        maxMessages: { type: 'number', description: 'Optional positive message cap. Omit for unlimited; only the owner can change it later.' },
        maxRounds: { type: 'number', description: 'Compatibility alias for maxMessages; counts messages, not conversational rounds.' },
        requiredApprovals: { type: 'number', description: 'Optional positive number of participant approvals required before Accepted.' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_send_message',
    description: 'Persist a structured message and automatically enqueue eligible explicitly enrolled recipients. Persistence remains distinct from notification and processing acknowledgement.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id. May be omitted only when exactly one open conversation exists.' },
        role: { type: 'string', description: 'Message role.', default: 'assistant' },
        body: { type: 'string', description: 'Message body, preserved byte-for-byte as a JSON string.' },
        kind: { type: 'string', enum: MESSAGE_KINDS, description: 'Optional message kind.' },
        refs: {
          type: 'array',
          description: 'Optional validated references to a commit, pull request, or prior message id.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: MESSAGE_REFERENCE_TYPES },
              value: { type: 'string' },
            },
            required: ['type', 'value'],
            additionalProperties: false,
          },
        },
        recipientParticipantId: { type: 'string', description: 'Optional stable participant id to target when several recipients are eligible.' },
        notify: { type: 'boolean', default: false, description: 'Compatibility flag; eligible enrolled adapters are now attempted automatically after persistence.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_join_conversation',
    description: 'Join a conversation as the stable participant configured for this MCP process/workspace.',
    inputSchema: {
      type: 'object',
      properties: { conversationId: { type: 'string', description: 'Conversation id. Defaults to the selected open conversation.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_revoke_participant',
    description: 'As the conversation owner, revoke one stable participant from eligibility while preserving its historical messages and approvals for audit.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Explicit conversation id.' },
        participantId: { type: 'string', description: 'Stable participant id to revoke.' },
      },
      required: ['conversationId', 'participantId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_approve_contract',
    description: 'Approve the current semantic contract revision as the stable participant configured for this MCP process/workspace.',
    inputSchema: {
      type: 'object',
      properties: { conversationId: { type: 'string', description: 'Conversation id. Defaults to the selected open conversation.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_read_inbox',
    description: 'Read ordered messages using a durable versioned cursor. Reading never acknowledges processing.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id. May be omitted only when exactly one conversation exists.' },
        after: { type: 'string', description: 'Opaque nextCursor from a prior page.' },
        since: { type: 'string', description: 'Message id after which to return messages.' },
        limit: { type: 'number', description: 'Maximum ordered messages to return (1-1000).', default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_wait_for_messages',
    description: 'Wait up to 30 seconds for messages after a durable cursor/message id. Timeout returns normally; cancellation does not acknowledge. Retry after restart with the same cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        after: { type: 'string', description: 'Opaque nextCursor from a prior read.' },
        since: { type: 'string', description: 'Message id after which to wait.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, default: 5000 },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20 },
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_ack_inbox',
    description: 'Durably acknowledge processing through one message id or cursor for the configured participant. This is separate from reading and notification.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Explicit conversation id.' },
        messageId: { type: 'string', description: 'A message id to acknowledge through.' },
        cursor: { type: 'string', description: 'A cursor to acknowledge through.' },
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_set_message_cap',
    description: 'As the conversation owner, raise, set, or remove the optional message cap while the conversation is open.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Explicit conversation id.' },
        maxMessages: { type: ['integer', 'null'], minimum: 1, description: 'Positive message cap, or null to remove it.' },
      },
      required: ['conversationId', 'maxMessages'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_retry_notification',
    description: 'Explicitly retry a failed notification event. Delivered events are deduplicated and are not executed again.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_update_contract',
    description: 'Update the local contract status and/or deterministically merge one markdown section, optionally syncing CONTRACT.md to a peer workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: CONTRACT_STATUSES, description: 'New contract status.' },
        conversationId: { type: 'string', description: 'Conversation id. Defaults to the explicitly selected compatibility view.' },
        expectedRevision: { type: 'string', description: 'Optional semantic revision precondition for stale-write rejection.' },
        section: { type: 'string', description: 'Optional CONTRACT.md section heading to replace or insert.' },
        content: { type: 'string', description: 'Markdown content for the section.' },
        syncTo: { type: 'string', description: 'Optional peer repo path to receive the current CONTRACT.md.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_accept_contract',
    description: 'Mark the local AgentLink contract Accepted, optionally syncing it to a peer workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        syncTo: { type: 'string', description: 'Optional peer repo path to receive the current CONTRACT.md.' },
        conversationId: { type: 'string', description: 'Conversation id. Defaults to the explicitly selected compatibility view.' },
        expectedRevision: { type: 'string', description: 'Optional semantic revision precondition for stale-write rejection.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_close_conversation',
    description: 'Close an explicitly identified AgentLink conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id.' },
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
  },
];

export async function callAgentLinkTool(name: string, args: ToolArguments = {}, cwd = process.cwd(), context: McpCallContext = {}): Promise<McpToolResult> {
  if (name === 'agentlink_list_agents') {
    const registrations = await listAgentRegistrations(cwd);
    const text = registrations.length === 0
      ? 'No active AgentLink registrations. Register each IDE/harness process explicitly.'
      : registrations.map((registration) => `${registration.registrationId} ${registration.label} [${registration.clientKind}] participant=${registration.participantId} workspace=${registration.workspaceId} expires=${registration.expiresAt}`).join('\n');
    return structuredResult(text, { registrations });
  }

  if (name === 'agentlink_register_agent') {
    const registration = await registerAgent(cwd, {
      label: stringArg(args, 'label', true)!,
      clientKind: stringArg(args, 'clientKind'),
      ttlSeconds: optionalNumberArg(args, 'ttlSeconds'),
      notificationAdapterId: stringArg(args, 'notificationAdapterId'),
      registrationId: stringArg(args, 'registrationId'),
    });
    return structuredResult(`Agent registered: ${registration.registrationId}; expires ${registration.expiresAt}`, { registration });
  }

  if (name === 'agentlink_heartbeat_agent') {
    const registration = await heartbeatAgent(cwd, stringArg(args, 'registrationId', true)!, optionalNumberArg(args, 'ttlSeconds'));
    return structuredResult(`Heartbeat renewed: ${registration.registrationId}; expires ${registration.expiresAt}`, { registration });
  }

  if (name === 'agentlink_unregister_agent') {
    const registrationId = stringArg(args, 'registrationId', true)!;
    await unregisterAgent(cwd, registrationId);
    return textResult(`Agent unregistered: ${registrationId}`);
  }

  if (name === 'agentlink_list_tmux_agents') {
    const panes = filterAgentPanes(await listTmuxPanes());
    if (panes.length === 0) return textResult('tmux capability unavailable or no coding-agent panes found; core AgentLink workflows remain available.');
    return textResult(panes.map((pane, index) => `${index + 1}. ${pane.agentKind} ${pane.paneId} ${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.currentPath}`).join('\n'));
  }

  if (name === 'agentlink_list_conversations') {
    const conversations = await listConversations(cwd);
    const text = conversations.length === 0
      ? 'No conversations.'
      : conversations.map((conversation) => `${conversation.id} [${conversation.status}] ${conversation.topic} (${conversation.messageCount} messages${conversation.requiredApprovals ? `, approvals ${conversation.currentApprovalCount}/${conversation.requiredApprovals}` : ''}, updated ${conversation.updatedAt})`).join('\n');
    return structuredResult(text, { conversations });
  }

  if (name === 'agentlink_start_conversation') {
    const topic = stringArg(args, 'topic', true)!;
    const target = stringArg(args, 'target');
    const maxMessages = optionalNumberArg(args, 'maxMessages');
    const maxRounds = optionalNumberArg(args, 'maxRounds');
    if (maxMessages !== undefined && maxRounds !== undefined && maxMessages !== maxRounds) {
      throw new Error('Arguments maxMessages and compatibility maxRounds cannot specify different message caps');
    }
    const conversation = await createConversation(cwd, {
      topic,
      target,
      maxMessages,
      maxRounds,
      requiredApprovals: optionalNumberArg(args, 'requiredApprovals'),
    });
    const contractPath = await writeConversationContract(cwd, {
      conversationId: conversation.id,
      topic: conversation.topic,
      target: conversation.target,
    });
    const lines = [`Started conversation ${conversation.id}: ${conversation.topic}`];
    if (conversation.messageCap) lines.push(`Message cap: ${conversation.messageCap}${maxRounds !== undefined ? ' (configured through maxRounds compatibility alias; counts messages)' : ''}`);
    if (conversation.requiredApprovals) lines.push(`Required approvals: ${conversation.requiredApprovals}`);
    lines.push(`Contract: ${contractPath}`);
    return textResult(lines.join('\n'));
  }

  if (name === 'agentlink_send_message') {
    if (args.from !== undefined) throw new Error('Sender aliases are no longer accepted; configure AGENTLINK_PARTICIPANT_ID or select an actor in the workspace.');
    const conversationId = stringArg(args, 'conversationId');
    const conversation = await resolveConversation(cwd, conversationId);
    const message = await appendMessage(cwd, conversation.id, {
      role: stringArg(args, 'role') ?? 'assistant',
      body: preservedStringArg(args, 'body'),
      kind: messageKindArg(args),
      refs: messageRefsArg(args),
      recipientParticipantId: stringArg(args, 'recipientParticipantId'),
    });
    const warning = capWarning(await readConversation(cwd, conversation.id));
    const notification = await notifyMessage(cwd, conversation.id, message.messageId!, message.participantId!);
    return structuredResult([
      `Persisted message ${message.messageId} in ${conversation.id} at ${message.timestamp}.`,
      `Message appended to ${conversation.id}.`,
      notification.attempted
        ? `Notification: attempted; delivered=${notification.delivered}, failed=${notification.failed}. Processing acknowledgement: pending.`
        : 'Notification: not attempted. Processing acknowledgement: pending.',
      ...notification.warnings.map((item) => `Warning: ${item}`),
      ...(warning ? [`Warning: ${warning}`] : []),
    ].join('\n'), { conversationId: conversation.id, message, notification, acknowledged: false, ...(warning ? { warning } : {}) });
  }

  if (name === 'agentlink_join_conversation') {
    const conversation = await resolveConversation(cwd, stringArg(args, 'conversationId'));
    const joined = await joinConversation(cwd, conversation.id);
    return textResult(`Participant ${joined.participantId} joined conversation ${conversation.id}`);
  }

  if (name === 'agentlink_revoke_participant') {
    const conversationId = stringArg(args, 'conversationId', true)!;
    const revoked = await revokeConversationParticipant(cwd, conversationId, stringArg(args, 'participantId', true)!);
    return structuredResult(
      `Revoked participant ${revoked.participantId} from ${conversationId}; historical audit records remain intact.`,
      { conversationId, revoked },
    );
  }

  if (name === 'agentlink_approve_contract') {
    const conversation = await resolveConversation(cwd, stringArg(args, 'conversationId'));
    const approval = await approveConversation(cwd, conversation.id);
    return textResult(`Approval recorded for ${conversation.id} by participant ${approval.participantId} on revision ${approval.revision}`);
  }

  if (name === 'agentlink_read_inbox') {
    const conversation = await resolveConversation(cwd, stringArg(args, 'conversationId'), { allowLatestClosed: true });
    const limit = numberArg(args, 'limit', 20);
    const page = await readMessages(cwd, conversation.id, {
      after: stringArg(args, 'after'),
      since: stringArg(args, 'since'),
      limit,
    });
    const messages = page.messages;
    const lines = [`Conversation ${conversation.id} [${conversation.status}]: ${conversation.topic}`];
    if (messages.length === 0) lines.push('No messages.');
    for (const message of messages) {
      const metadata = [`id=${message.messageId}`, `seq=${message.sequence}`, ...(message.kind ? [`kind=${message.kind}`] : [])].join(' ');
      lines.push(`${message.timestamp} ${message.role}/${message.from} ${metadata}: ${message.body}`);
    }
    lines.push(`Next cursor: ${page.nextCursor}`, `Has more: ${page.hasMore}`, `Unread: ${page.unreadCount}`);
    return structuredResult(lines.join('\n'), { ...page, status: conversation.status, topic: conversation.topic });
  }

  if (name === 'agentlink_wait_for_messages') {
    const conversationId = stringArg(args, 'conversationId', true)!;
    const page = await waitForMessages(cwd, conversationId, {
      after: stringArg(args, 'after'),
      since: stringArg(args, 'since'),
      limit: numberArg(args, 'limit', 20),
      timeoutMs: numberArg(args, 'timeoutMs', 5_000),
      signal: context.signal,
    });
    return structuredResult(
      page.outcome === 'message'
        ? `Received ${page.messages.length} message(s) after ${page.waitedMs}ms.`
        : `Wait timed out after ${page.waitedMs}ms; no acknowledgement was recorded.`,
      { ...page },
    );
  }

  if (name === 'agentlink_ack_inbox') {
    const conversationId = stringArg(args, 'conversationId', true)!;
    const acknowledgement = await ackMessages(cwd, conversationId, {
      messageId: stringArg(args, 'messageId'),
      cursor: stringArg(args, 'cursor'),
    });
    return structuredResult(
      `Acknowledged processing through ${acknowledgement.acknowledgedMessageId ?? `sequence ${acknowledgement.acknowledgedSequence}`} for ${conversationId}.`,
      { acknowledgement },
    );
  }

  if (name === 'agentlink_set_message_cap') {
    const conversationId = stringArg(args, 'conversationId', true)!;
    if (!Object.hasOwn(args, 'maxMessages')) throw new Error('Missing required argument: maxMessages');
    const rawCap = args.maxMessages;
    let messageCap: number | null;
    if (rawCap === null) messageCap = null;
    else {
      const parsed = optionalNumberArg(args, 'maxMessages');
      if (parsed === undefined) throw new Error('Argument maxMessages must be a positive integer or null');
      messageCap = parsed;
    }
    const conversation = await setMessageCap(cwd, conversationId, messageCap);
    const text = conversation.messageCap === undefined ? `Message cap removed for ${conversationId}.` : `Message cap: ${conversation.messageCap} for ${conversationId}.`;
    return structuredResult(text, { conversationId, messageCap: conversation.messageCap ?? null, messageCount: conversation.messages.length });
  }

  if (name === 'agentlink_retry_notification') {
    const event = await retryNotification(cwd, stringArg(args, 'eventId', true)!);
    return structuredResult(`Notification ${event.eventId}: ${event.state}; attempts=${event.attempts.length}`, { event });
  }

  if (name === 'agentlink_update_contract' || name === 'agentlink_accept_contract') {
    const section = stringArg(args, 'section');
    const content = stringArg(args, 'content');
    if ((section === undefined) !== (content === undefined)) {
      throw new Error('Arguments section and content must be provided together');
    }
    const status = name === 'agentlink_accept_contract'
      ? 'Accepted'
      : stringArg(args, 'status') === undefined
        ? undefined
        : statusArg(args, 'status');
    if (args.approvedBy !== undefined) throw new Error('Approval aliases are no longer accepted; call agentlink_approve_contract as the configured actor.');
    if (name === 'agentlink_update_contract' && status === undefined && section === undefined) {
      throw new Error('agentlink_update_contract requires status and/or section with content');
    }
    let contract = await readContractState(cwd, stringArg(args, 'conversationId'));
    if (!contract.conversationId) throw new Error('No selected contract. Provide conversationId.');
    contract = await updateConversationContract(cwd, contract.conversationId, {
      ...(status ? { status } : {}),
      ...(section !== undefined && content !== undefined ? { sections: [{ heading: section, content }] } : {}),
      ...(stringArg(args, 'expectedRevision') ? { expectedRevision: stringArg(args, 'expectedRevision') } : {}),
    });
    const lines = [`Contract: ${contract.status ?? 'not initialized'}`];
    if (contract.conversationId) lines.push(`Conversation: ${contract.conversationId}`);
    lines.push(`Path: ${contract.path}`);
    const syncTo = stringArg(args, 'syncTo');
    if (syncTo) lines.push(`Synced contract: ${await syncContractToWorkspace(cwd, syncTo, contract.conversationId)}`);
    return textResult(lines.join('\n'));
  }

  if (name === 'agentlink_close_conversation') {
    const conversation = await resolveConversation(cwd, stringArg(args, 'conversationId', true));
    await closeConversation(cwd, conversation.id);
    return textResult(`Closed conversation ${conversation.id}`);
  }

  throw new Error(`Unknown AgentLink MCP tool: ${name}`);
}

export async function readContractSummary(cwd = process.cwd()): Promise<string> {
  const contract = await readContractState(cwd);
  return `Contract: ${contract.status ?? 'not initialized'}\nPath: ${contract.path}`;
}
