import { appendMessage, approveConversation, closeConversation, createConversation, listConversations, resolveConversation } from '../store.js';
import { CONTRACT_STATUSES, readContractState, syncContractToWorkspace, updateContractSections, updateContractStatus, writeConversationContract, type ContractStatus } from '../contract.js';
import { filterAgentPanes, listTmuxPanes } from '../tmux.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type ToolArguments = Record<string, unknown>;

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

function statusArg(args: ToolArguments, name: string): ContractStatus {
  const value = stringArg(args, name, true)!;
  const status = CONTRACT_STATUSES.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  if (!status) throw new Error(`Invalid contract status: ${value}. Expected one of: ${CONTRACT_STATUSES.join(', ')}`);
  return status;
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

export const AGENTLINK_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'agentlink_list_agents',
    description: 'List active coding-agent tmux panes discovered by AgentLink.',
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
        maxRounds: { type: 'number', description: 'Optional positive message-round limit before AgentLink blocks further sends.' },
        requiredApprovals: { type: 'number', description: 'Optional positive number of participant approvals required before Accepted.' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_send_message',
    description: 'Append a structured message to an AgentLink conversation. This MCP slice persists to the local bus only; use the CLI --deliver-to guardrail for tmux typing.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id. Defaults to latest open conversation.' },
        role: { type: 'string', description: 'Message role.', default: 'assistant' },
        from: { type: 'string', description: 'Sender label.', default: 'agent' },
        body: { type: 'string', description: 'Compact structured message body.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_read_inbox',
    description: 'Read recent messages from an AgentLink conversation, defaulting to the latest conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id. Defaults to latest open or latest closed conversation.' },
        limit: { type: 'number', description: 'Maximum messages to return.', default: 20 },
      },
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
        section: { type: 'string', description: 'Optional CONTRACT.md section heading to replace or insert.' },
        content: { type: 'string', description: 'Markdown content for the section.' },
        syncTo: { type: 'string', description: 'Optional peer repo path to receive the current CONTRACT.md.' },
        approvedBy: { type: 'string', description: 'Optional participant label to record as an approval before status gating.' },
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
        approvedBy: { type: 'string', description: 'Optional participant label to record as an approval before accepting.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlink_close_conversation',
    description: 'Close an AgentLink conversation, defaulting to the latest open conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id. Defaults to latest open conversation.' },
      },
      additionalProperties: false,
    },
  },
];

export async function callAgentLinkTool(name: string, args: ToolArguments = {}, cwd = process.cwd()): Promise<McpToolResult> {
  if (name === 'agentlink_list_agents') {
    const panes = filterAgentPanes(await listTmuxPanes());
    if (panes.length === 0) return textResult('No active coding-agent tmux panes found.');
    return textResult(panes.map((pane, index) => `${index + 1}. ${pane.agentKind} ${pane.paneId} ${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.currentPath}`).join('\n'));
  }

  if (name === 'agentlink_start_conversation') {
    const topic = stringArg(args, 'topic', true)!;
    const target = stringArg(args, 'target');
    const conversation = await createConversation(cwd, {
      topic,
      target,
      maxRounds: optionalNumberArg(args, 'maxRounds'),
      requiredApprovals: optionalNumberArg(args, 'requiredApprovals'),
    });
    const contractPath = await writeConversationContract(cwd, {
      conversationId: conversation.id,
      topic: conversation.topic,
      target: conversation.target,
    });
    const lines = [`Started conversation ${conversation.id}: ${conversation.topic}`];
    if (conversation.maxRounds) lines.push(`Max rounds: ${conversation.maxRounds}`);
    if (conversation.requiredApprovals) lines.push(`Required approvals: ${conversation.requiredApprovals}`);
    lines.push(`Contract: ${contractPath}`);
    return textResult(lines.join('\n'));
  }

  if (name === 'agentlink_send_message') {
    const conversationId = stringArg(args, 'conversationId');
    const conversation = await resolveConversation(cwd, conversationId);
    const message = await appendMessage(cwd, conversation.id, {
      role: stringArg(args, 'role') ?? 'assistant',
      from: stringArg(args, 'from') ?? 'agent',
      body: stringArg(args, 'body', true)!,
    });
    return textResult(`Message appended to ${conversation.id} at ${message.timestamp}`);
  }

  if (name === 'agentlink_read_inbox') {
    const conversation = await resolveConversation(cwd, stringArg(args, 'conversationId'), { allowLatestClosed: true });
    const limit = numberArg(args, 'limit', 20);
    const messages = conversation.messages.slice(-limit);
    const lines = [`Conversation ${conversation.id} [${conversation.status}]: ${conversation.topic}`];
    if (messages.length === 0) lines.push('No messages.');
    for (const message of messages) lines.push(`${message.timestamp} ${message.role}/${message.from}: ${message.body}`);
    return textResult(lines.join('\n'));
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
    const approvedBy = stringArg(args, 'approvedBy');
    if (name === 'agentlink_update_contract' && status === undefined && section === undefined && approvedBy === undefined) {
      throw new Error('agentlink_update_contract requires status, section with content, and/or approvedBy');
    }
    let contract = await readContractState(cwd);
    if (approvedBy !== undefined) {
      const conversation = await resolveConversation(cwd, contract.conversationId, { allowLatestClosed: true });
      await approveConversation(cwd, conversation.id, { from: approvedBy });
    }
    if (status !== undefined) {
      if (status === 'Accepted' && contract.conversationId) {
        const conversation = await resolveConversation(cwd, contract.conversationId, { allowLatestClosed: true });
        if (conversation.requiredApprovals && conversation.approvals.length < conversation.requiredApprovals) {
          throw new Error(`Cannot mark Accepted: conversation ${conversation.id} has ${conversation.approvals.length}/${conversation.requiredApprovals} required approvals`);
        }
      }
      contract = await updateContractStatus(cwd, status);
    }
    if (section !== undefined && content !== undefined) {
      contract = await updateContractSections(cwd, [{ heading: section, content }]);
    }
    const lines = [`Contract: ${contract.status ?? 'not initialized'}`];
    if (contract.conversationId) lines.push(`Conversation: ${contract.conversationId}`);
    lines.push(`Path: ${contract.path}`);
    const syncTo = stringArg(args, 'syncTo');
    if (syncTo) lines.push(`Synced contract: ${await syncContractToWorkspace(cwd, syncTo)}`);
    return textResult(lines.join('\n'));
  }

  if (name === 'agentlink_close_conversation') {
    const conversation = await resolveConversation(cwd, stringArg(args, 'conversationId'));
    await closeConversation(cwd, conversation.id);
    return textResult(`Closed conversation ${conversation.id}`);
  }

  throw new Error(`Unknown AgentLink MCP tool: ${name}`);
}

export async function readContractSummary(cwd = process.cwd()): Promise<string> {
  const contract = await readContractState(cwd);
  return `Contract: ${contract.status ?? 'not initialized'}\nPath: ${contract.path}`;
}
