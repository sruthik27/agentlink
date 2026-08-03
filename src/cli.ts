#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendMessage,
  approveConversation,
  closeConversation,
  createConversation,
  ensureWorkspace,
  listConversations,
  readConversationRecords,
  resolveConversation,
  type ConversationRecord,
} from './store.js';
import {
  CONTRACT_STATUSES,
  CONTRACT_TEMPLATES,
  contractPath,
  initializeContract,
  readContractState,
  syncContractToWorkspace,
  updateContractSections,
  updateContractStatus,
  writeConversationContract,
  type ContractStatus,
  type ContractTemplate,
} from './contract.js';
import { filterAgentPanes, listTmuxPanes } from './tmux.js';
import {
  deliverTmuxMessage,
  type TmuxDeliveryInput,
  type TmuxDeliveryResult,
} from './tmux-delivery.js';
import { collectRepoContext, renderRepoContextMarkdown } from './context.js';
import { renderDemoMarkdown, runDemo } from './demo.js';
import { collectDoctorReport, renderDoctorReport } from './doctor.js';
import { collectLaunchBrief, renderLaunchBriefMarkdown } from './launch-brief.js';
import { collectShipCheckReport, renderShipCheckReport } from './ship-check.js';
import { collectSetupGuide, parseSetupHarness, renderSetupGuideMarkdown } from './setup.js';

const help = `AgentLink — local-first cross-repo coding-agent coordination

Usage:
  agentlink init
      Create .agentlink workspace files in the current repo
  agentlink list
      List active coding-agent tmux panes
  agentlink start --topic <topic> [--target <pane-or-agent>] [--template <template>] [--max-rounds <count>] [--required-approvals <count>]
      Start a conversation and prepare CONTRACT.md
      Templates: ${CONTRACT_TEMPLATES.join(', ')}
  agentlink status
      List conversations and the current contract status
  agentlink context [--format <markdown|json>]
      Print a compact repo fingerprint for agent handoffs without source content
  agentlink doctor [--format <text|json>]
      Check local AgentLink prerequisites, workspace state, tmux visibility, and MCP build output
  agentlink setup [--harness <stdio|claude-code|codex|copilot|opencode|gemini|all>] [--format <markdown|json>]
      Print local install, MCP, and harness setup instructions
  agentlink demo --peer <repo-path> [--topic <topic>] [--format <markdown|json>]
      Run a deterministic two-repo contract negotiation demo using the local bus
  agentlink ship-check [--format <text|json>]
      Check packaging/docs/readiness gates before requesting launch approval
  agentlink launch-brief [--format <markdown|json>]
      Print the final human approval brief, verification commands, artifacts, and launch boundary
  agentlink version
      Print the installed AgentLink package version
  agentlink send --body <message> [--role <role>] [--from <sender>] [--conversation <id>] [--deliver-to <pane-id>]
      Append a structured message, then optionally deliver it to a tmux pane
      (defaults: role=user, from=human; delivery is off by default)
  agentlink read [--conversation <id>] [--limit <count>]
      Print recent messages (defaults to the latest conversation)
  agentlink replay [--conversation <id>] [--format <text|json>]
      Print the full append-only conversation timeline, including approvals and close events
  agentlink contract [--status <Draft|Proposed|Accepted|Blocked|Implemented|Verified>] [--set-section <heading> --content <markdown>] [--sync-to <repo-path>]
      Print/update the current contract state or merge one section, and optionally copy it to another repo workspace
  agentlink approve --from <participant> [--conversation <id>]
      Record a participant approval toward the conversation's acceptance gate
  agentlink end [--conversation <id>]
      Close a conversation (defaults to the latest open conversation)
  agentlink help
      Show this help
`;

interface ParsedArguments {
  options: Record<string, string>;
  positionals: string[];
}

interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

type TmuxMessageDeliverer = (input: TmuxDeliveryInput) => Promise<TmuxDeliveryResult>;

class UsageError extends Error {}

async function readVersionAt(path: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { name?: unknown; version?: unknown };
    return typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

async function readPackageVersion(cwd: string): Promise<string> {
  const cwdVersion = await readVersionAt(join(cwd, 'package.json'));
  if (cwdVersion) return cwdVersion;

  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const version = await readVersionAt(join(cursor, 'package.json'));
    if (version) return version;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return 'unknown';
}

function parseArguments(args: string[]): ParsedArguments {
  const options: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    const value = inlineValue ?? args[index + 1];
    if (!name || value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new UsageError(`Option --${name || '?'} requires a value`);
    }
    options[name] = value;
    if (inlineValue === undefined) index += 1;
  }

  return { options, positionals };
}

function rejectUnknownOptions(options: Record<string, string>, allowed: string[]): void {
  const unknown = Object.keys(options).find((option) => !allowed.includes(option));
  if (unknown) throw new UsageError(`Unknown option: --${unknown}`);
}

function oneOptionalPositional(positionals: string[], command: string): string | undefined {
  if (positionals.length > 1) throw new UsageError(`Usage: agentlink ${command} [--conversation <id>]`);
  return positionals[0];
}

function parseContractStatusOption(value: string): ContractStatus {
  const status = CONTRACT_STATUSES.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase());
  if (!status) {
    throw new UsageError(`Invalid contract status: ${value}. Expected one of: ${CONTRACT_STATUSES.join(', ')}`);
  }
  return status;
}

function parsePositiveIntegerOption(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return parsed;
}

function parseContractTemplateOption(value: string): ContractTemplate {
  const template = CONTRACT_TEMPLATES.find(
    (candidate) => candidate === value.trim().toLowerCase(),
  );
  if (!template) {
    throw new UsageError(
      `Invalid contract template: ${value}. Expected one of: ${CONTRACT_TEMPLATES.join(', ')}`,
    );
  }
  return template;
}

function renderConversationRecord(record: ConversationRecord): string {
  if (record.type === 'conversation') {
    const target = record.target ? ` -> ${record.target}` : '';
    const limits = record.maxRounds ? `, max ${record.maxRounds} rounds` : '';
    const approvals = record.requiredApprovals ? `, requires ${record.requiredApprovals} approvals` : '';
    return `${record.createdAt} conversation started: ${record.topic}${target}${limits}${approvals}`;
  }
  if (record.type === 'message') {
    return `${record.timestamp} message ${record.role}/${record.from}: ${record.body}`;
  }
  if (record.type === 'approval') {
    return `${record.timestamp} approval from ${record.from}`;
  }
  return `${record.timestamp} status: ${record.status}`;
}

export async function initWorkspace(cwd = process.cwd()): Promise<string> {
  await ensureWorkspace(cwd);
  return initializeContract(cwd);
}

export async function runCli(
  args = process.argv.slice(2),
  cwd = process.cwd(),
  output: CliOutput = console,
  deliverMessage: TmuxMessageDeliverer = deliverTmuxMessage,
): Promise<void> {
  const command = args[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    output.log(help);
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    if (args.length > 1) throw new UsageError('Usage: agentlink version');
    output.log(await readPackageVersion(cwd));
    return;
  }

  if (command === 'list') {
    if (args.length > 1) throw new UsageError('Usage: agentlink list');
    const panes = filterAgentPanes(await listTmuxPanes());
    if (panes.length === 0) {
      output.log('No active coding-agent tmux panes found. Start Claude Code/Codex/OpenCode inside tmux, then retry.');
      return;
    }
    for (const [index, pane] of panes.entries()) {
      output.log(`${index + 1}. ${pane.agentKind.padEnd(8)} ${pane.paneId.padEnd(4)} ${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.currentPath}`);
    }
    return;
  }

  if (command === 'init') {
    if (args.length > 1) throw new UsageError('Usage: agentlink init');
    const path = await initWorkspace(cwd);
    output.log(`AgentLink workspace ready: ${path}`);
    return;
  }

  const { options, positionals } = parseArguments(args.slice(1));

  if (command === 'start') {
    rejectUnknownOptions(options, ['topic', 'target', 'template', 'max-rounds', 'required-approvals']);
    const topic = options.topic ?? positionals.join(' ');
    if (!topic.trim()) {
      throw new UsageError(
        'Usage: agentlink start --topic <topic> [--target <pane-or-agent>] [--template <template>] [--max-rounds <count>] [--required-approvals <count>]',
      );
    }
    const template = options.template === undefined
      ? undefined
      : parseContractTemplateOption(options.template);
    const maxRounds = options['max-rounds'] === undefined
      ? undefined
      : parsePositiveIntegerOption(options['max-rounds'], 'max-rounds');
    const requiredApprovals = options['required-approvals'] === undefined
      ? undefined
      : parsePositiveIntegerOption(options['required-approvals'], 'required-approvals');
    const conversation = await createConversation(cwd, {
      topic,
      target: options.target,
      maxRounds,
      requiredApprovals,
    });
    await writeConversationContract(cwd, {
      conversationId: conversation.id,
      topic: conversation.topic,
      target: conversation.target,
      template,
    });
    output.log(`Started conversation ${conversation.id}: ${conversation.topic}`);
    if (conversation.target) output.log(`Target: ${conversation.target}`);
    if (conversation.maxRounds) output.log(`Max rounds: ${conversation.maxRounds}`);
    if (conversation.requiredApprovals) output.log(`Required approvals: ${conversation.requiredApprovals}`);
    output.log(`Contract: ${contractPath(cwd)}`);
    return;
  }

  if (command === 'status') {
    rejectUnknownOptions(options, []);
    if (positionals.length > 0) throw new UsageError('Usage: agentlink status');
    const conversations = await listConversations(cwd);
    const activeId = conversations.find((conversation) => conversation.status === 'open')?.id;
    if (conversations.length === 0) {
      output.log('No conversations.');
    } else {
      output.log('Conversations:');
      for (const conversation of conversations) {
        const active = conversation.id === activeId ? '*' : ' ';
        const target = conversation.target ? ` -> ${conversation.target}` : '';
        const limits = conversation.maxRounds ? `, max ${conversation.maxRounds} rounds` : '';
        const approvals = conversation.requiredApprovals
          ? `, approvals ${conversation.approvals.length}/${conversation.requiredApprovals}`
          : '';
        output.log(`${active} ${conversation.id} [${conversation.status}] ${conversation.topic}${target} (${conversation.messageCount} messages${limits}${approvals})`);
      }
    }
    const contract = await readContractState(cwd);
    output.log(`Contract: ${contract.status ?? 'not initialized'}`);
    return;
  }

  if (command === 'context') {
    rejectUnknownOptions(options, ['format']);
    if (positionals.length > 0) throw new UsageError('Usage: agentlink context [--format <markdown|json>]');
    const format = options.format ?? 'markdown';
    if (!['markdown', 'json'].includes(format)) throw new UsageError('--format must be markdown or json');
    const summary = await collectRepoContext(cwd);
    output.log(format === 'json'
      ? JSON.stringify(summary, null, 2)
      : renderRepoContextMarkdown(summary));
    return;
  }

  if (command === 'doctor') {
    rejectUnknownOptions(options, ['format']);
    if (positionals.length > 0) throw new UsageError('Usage: agentlink doctor [--format <text|json>]');
    const format = options.format ?? 'text';
    if (!['text', 'json'].includes(format)) throw new UsageError('--format must be text or json');
    const report = await collectDoctorReport(cwd);
    output.log(format === 'json'
      ? JSON.stringify(report, null, 2)
      : renderDoctorReport(report));
    if (report.hasFailures) process.exitCode = 1;
    return;
  }

  if (command === 'setup') {
    rejectUnknownOptions(options, ['harness', 'format']);
    if (positionals.length > 0) throw new UsageError('Usage: agentlink setup [--harness <stdio|claude-code|codex|copilot|opencode|gemini|all>] [--format <markdown|json>]');
    const format = options.format ?? 'markdown';
    if (!['markdown', 'json'].includes(format)) throw new UsageError('--format must be markdown or json');
    const harness = options.harness === undefined || options.harness === 'all'
      ? 'all'
      : parseSetupHarness(options.harness);
    const guide = await collectSetupGuide(cwd, harness);
    output.log(format === 'json'
      ? JSON.stringify(guide, null, 2)
      : renderSetupGuideMarkdown(guide));
    return;
  }

  if (command === 'demo') {
    rejectUnknownOptions(options, ['peer', 'topic', 'format']);
    if (positionals.length > 0) throw new UsageError('Usage: agentlink demo --peer <repo-path> [--topic <topic>] [--format <markdown|json>]');
    if (!options.peer) throw new UsageError('Usage: agentlink demo --peer <repo-path> [--topic <topic>] [--format <markdown|json>]');
    const format = options.format ?? 'markdown';
    if (!['markdown', 'json'].includes(format)) throw new UsageError('--format must be markdown or json');
    const result = await runDemo(cwd, {
      peerPath: options.peer,
      topic: options.topic,
    });
    output.log(format === 'json'
      ? JSON.stringify(result, null, 2)
      : renderDemoMarkdown(result));
    return;
  }

  if (command === 'ship-check') {
    rejectUnknownOptions(options, ['format']);
    if (positionals.length > 0) throw new UsageError('Usage: agentlink ship-check [--format <text|json>]');
    const format = options.format ?? 'text';
    if (!['text', 'json'].includes(format)) throw new UsageError('--format must be text or json');
    const report = await collectShipCheckReport(cwd);
    output.log(format === 'json'
      ? JSON.stringify(report, null, 2)
      : renderShipCheckReport(report));
    if (report.hasFailures) process.exitCode = 1;
    return;
  }

  if (command === 'launch-brief') {
    rejectUnknownOptions(options, ['format']);
    if (positionals.length > 0) throw new UsageError('Usage: agentlink launch-brief [--format <markdown|json>]');
    const format = options.format ?? 'markdown';
    if (!['markdown', 'json'].includes(format)) throw new UsageError('--format must be markdown or json');
    const brief = await collectLaunchBrief(cwd);
    output.log(format === 'json'
      ? JSON.stringify(brief, null, 2)
      : renderLaunchBriefMarkdown(brief));
    return;
  }

  if (command === 'send') {
    rejectUnknownOptions(options, ['body', 'conversation', 'role', 'from', 'deliver-to']);
    const body = options.body ?? positionals.join(' ');
    if (!body.trim()) {
      throw new UsageError('Usage: agentlink send --body <message> [--role <role>] [--from <sender>] [--conversation <id>] [--deliver-to <pane-id>]');
    }
    const conversation = await resolveConversation(cwd, options.conversation);
    const message = await appendMessage(cwd, conversation.id, {
      role: options.role ?? 'user',
      from: options.from ?? 'human',
      body,
    });
    output.log(`Message appended to ${conversation.id} at ${message.timestamp}`);
    if (options['deliver-to']) {
      const result = await deliverMessage({
        paneId: options['deliver-to'],
        text: JSON.stringify({
          conversationId: conversation.id,
          ...message,
        }),
      });
      output.log(`Message delivered to tmux pane ${result.paneId}`);
    }
    return;
  }

  if (command === 'read') {
    rejectUnknownOptions(options, ['conversation', 'limit']);
    const positionalId = oneOptionalPositional(positionals, 'read');
    if (positionalId && options.conversation) {
      throw new UsageError('Specify the conversation id either positionally or with --conversation, not both');
    }
    const limit = options.limit === undefined ? 20 : Number(options.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new UsageError('--limit must be a positive integer');
    const conversation = await resolveConversation(
      cwd,
      options.conversation ?? positionalId,
      { allowLatestClosed: true },
    );
    output.log(`Conversation ${conversation.id} [${conversation.status}]: ${conversation.topic}`);
    const messages = conversation.messages.slice(-limit);
    if (messages.length === 0) {
      output.log('No messages.');
      return;
    }
    for (const message of messages) {
      output.log(`${message.timestamp} ${message.role}/${message.from}: ${message.body}`);
    }
    return;
  }

  if (command === 'replay') {
    rejectUnknownOptions(options, ['conversation', 'format']);
    const positionalId = oneOptionalPositional(positionals, 'replay');
    if (positionalId && options.conversation) {
      throw new UsageError('Specify the conversation id either positionally or with --conversation, not both');
    }
    const format = options.format ?? 'text';
    if (!['text', 'json'].includes(format)) throw new UsageError('--format must be text or json');
    const conversation = await resolveConversation(
      cwd,
      options.conversation ?? positionalId,
      { allowLatestClosed: true },
    );
    const records = await readConversationRecords(cwd, conversation.id);
    if (format === 'json') {
      output.log(JSON.stringify({ conversation, records }, null, 2));
      return;
    }
    output.log(`Conversation ${conversation.id} [${conversation.status}]: ${conversation.topic}`);
    for (const record of records) output.log(renderConversationRecord(record));
    return;
  }

  if (command === 'approve') {
    rejectUnknownOptions(options, ['from', 'conversation']);
    const positionalId = oneOptionalPositional(positionals, 'approve');
    if (positionalId && options.conversation) {
      throw new UsageError('Specify the conversation id either positionally or with --conversation, not both');
    }
    if (!options.from) throw new UsageError('Usage: agentlink approve --from <participant> [--conversation <id>]');
    const conversation = await resolveConversation(cwd, options.conversation ?? positionalId);
    const approval = await approveConversation(cwd, conversation.id, { from: options.from });
    const updated = await resolveConversation(cwd, conversation.id);
    const required = updated.requiredApprovals ? ` (${updated.approvals.length}/${updated.requiredApprovals})` : '';
    output.log(`Approval recorded for ${conversation.id} from ${approval.from}${required}`);
    return;
  }

  if (command === 'contract') {
    rejectUnknownOptions(options, ['status', 'set-section', 'content', 'sync-to']);
    if (positionals.length > 0) {
      throw new UsageError('Usage: agentlink contract [--status <status>] [--set-section <heading> --content <markdown>] [--sync-to <repo-path>]');
    }
    if ((options['set-section'] === undefined) !== (options.content === undefined)) {
      throw new UsageError('--set-section and --content must be provided together');
    }
    let contract = await readContractState(cwd);
    if (options.status !== undefined) {
      const nextStatus = parseContractStatusOption(options.status);
      if (nextStatus === 'Accepted' && contract.conversationId) {
        const conversation = await resolveConversation(cwd, contract.conversationId, { allowLatestClosed: true });
        if (conversation.requiredApprovals && conversation.approvals.length < conversation.requiredApprovals) {
          throw new UsageError(`Cannot mark Accepted: conversation ${conversation.id} has ${conversation.approvals.length}/${conversation.requiredApprovals} required approvals`);
        }
      }
      contract = await updateContractStatus(cwd, nextStatus);
    }
    if (options['set-section'] !== undefined && options.content !== undefined) {
      contract = await updateContractSections(cwd, [{
        heading: options['set-section'],
        content: options.content,
      }]);
    }
    output.log(`Contract: ${contract.status ?? 'not initialized'}`);
    if (contract.conversationId) output.log(`Conversation: ${contract.conversationId}`);
    output.log(`Path: ${contract.path}`);
    if (options['sync-to']) {
      const targetPath = await syncContractToWorkspace(cwd, options['sync-to']);
      output.log(`Synced contract: ${targetPath}`);
    }
    return;
  }

  if (command === 'end') {
    rejectUnknownOptions(options, ['conversation']);
    const positionalId = oneOptionalPositional(positionals, 'end');
    if (positionalId && options.conversation) {
      throw new UsageError('Specify the conversation id either positionally or with --conversation, not both');
    }
    const conversation = await resolveConversation(cwd, options.conversation ?? positionalId);
    await closeConversation(cwd, conversation.id);
    output.log(`Closed conversation ${conversation.id}`);
    return;
  }

  throw new UsageError(`Unknown command: ${command}`);
}

async function main(): Promise<void> {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError) console.error('\nRun `agentlink help` for usage.');
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => process.argv[1] ?? '')
  : '';
const realModulePath = await realpath(modulePath).catch(() => modulePath);

if (invokedPath && (modulePath === invokedPath || realModulePath === invokedPath || import.meta.url === pathToFileURL(process.argv[1] ?? '').href)) {
  void main();
}
