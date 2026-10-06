#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendMessage,
  ackMessages,
  approveConversation,
  capWarning,
  closeConversation,
  countRevisionApprovals,
  createConversation,
  ensureWorkspace,
  joinConversation,
  listConversations,
  MESSAGE_KINDS,
  MESSAGE_REFERENCE_TYPES,
  readConversationRecords,
  readMessage,
  readMessages,
  resolveConversation,
  revokeConversationParticipant,
  setMessageCap,
  waitForMessages,
  type MessageKind,
  type MessageReference,
  type ConversationRecord,
} from './store.js';
import {
  CONTRACT_STATUSES,
  CONTRACT_TEMPLATES,
  contractPath,
  initializeContract,
  readContractState,
  refreshContractCompatibilityView,
  syncContractToWorkspace,
  updateConversationContract,
  updateContractSections,
  updateContractStatus,
  writeConversationContract,
  type ContractStatus,
  type ContractTemplate,
} from './contract.js';
import {
  listParticipants,
  heartbeatAgent,
  listAgentRegistrations,
  registerParticipant,
  registerAgent,
  relabelParticipant,
  resolveActiveParticipant,
  rotateWorkspaceIdentity,
  selectParticipant,
  unregisterAgent,
} from './workspace.js';
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
import {
  configureTrustedNotificationAdapter,
  listTrustedNotificationAdapters,
  notifyMessage,
  receiveNotification,
  retryNotification,
} from './notifications.js';
import {
  enqueueCodexWake,
  enrollCodexWake,
  readCodexWakeStatus,
  requestCodexWakeStop,
  retryCodexWakeJob,
  runCodexWakeOnce,
  runCodexWakeSupervisor,
  setCodexWakePaused,
} from './auto-wake.js';

const help = `AgentLink — local-first cross-repo coding-agent coordination

Usage:
  agentlink init [--new-workspace]
      Create .agentlink workspace files in the current repo
  agentlink actor <show|list|add|use|rename> [--name <label>] [--id <participant-id>]
      Configure stable participant identity; labels are display metadata only
  agentlink register --label <name> [--client <kind>] [--ttl <seconds>] [--adapter <trusted-adapter-id>] [--id <registration-id>]
      Register this stable actor as an expiring IDE/harness participant on the shared bus
  agentlink heartbeat --registration <id> [--ttl <seconds>]
      Renew a registration owned by the configured actor
  agentlink unregister --registration <id>
      Remove a registration owned by the configured actor
  agentlink list [--tmux]
      List active bus registrations; --tmux shows the optional pane-discovery capability
  agentlink start --topic <topic> [--target <pane-or-agent>] [--template <template>] [--max-messages <count>] [--max-rounds <count>] [--required-approvals <count>]
      Start a conversation and prepare CONTRACT.md
      Message limits are optional and count messages; --max-rounds is a compatibility alias
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
  agentlink join [--conversation <id>]
      Join the selected conversation as the configured participant
  agentlink revoke --conversation <id> --participant <participant-id>
      As conversation owner, revoke a participant's eligibility while preserving audit history
  agentlink send --body <message> [--role <role>] [--kind <kind>] [--refs <type:value,...>] [--conversation <id>] [--to <participant-id>] [--notify] [--deliver-to <pane-id>]
      Append a structured message, then automatically enqueue eligible enrolled recipients
      (--notify remains a compatibility flag; defaults: role=user, sender=configured participant)
  agentlink read [--conversation <id>] [--after <cursor>|--since <message-id>] [--limit <count>]
      Page ordered messages without acknowledging them; implicit targeting is allowed only when unambiguous
  agentlink wait --conversation <id> (--after <cursor>|--since <message-id>) [--timeout-ms <1-30000>] [--limit <count>]
      Wait a bounded time for new messages; timeout returns normally without acknowledging
  agentlink ack --conversation <id> (--message-id <id>|--cursor <cursor>)
      Durably acknowledge processing for the configured participant
  agentlink cap --conversation <id> (--set <count>|--remove)
      As conversation owner, set/raise or remove the optional message cap
  agentlink replay [--conversation <id>] [--format <text|json>]
      Print the full append-only conversation timeline, including approvals and close events
  agentlink contract [--conversation <id>] [--refresh] [--if-revision <sha256>] [--status <Draft|Proposed|Accepted|Blocked|Implemented|Verified>] [--set-section <heading> --content <markdown>] [--sync-to <repo-path>]
      Print/update authoritative contract state; --refresh explicitly regenerates the read-only compatibility view
  agentlink approve [--conversation <id>]
      Record the configured participant's approval for the current contract revision
  agentlink end --conversation <id>
      Close an explicitly identified conversation
  agentlink notify trust --id <adapter-id> --argv-json <json-array> [--timeout-ms <1-10000>]
      Store an argv-only adapter in user trust config outside the repo (never runs through a shell)
  agentlink notify <list|retry> [--event <event-id>]
      Inspect trusted adapter ids or explicitly retry a failed/deduplicated notification event
  agentlink receiver --inbox <absolute-path> --event-id <id> --bus-id <id> --conversation-id <id> --message-id <id> --registration-id <id>
      Concrete local receiver used by a trusted adapter; records event references only and deduplicates by event id
  agentlink wake enroll --recipient <id> --conversation <id[,id...]> --codex <absolute-path> [--config <absolute-path>] [--state <absolute-path>] [--trust-config <absolute-path>] [--model <model>]
      Enroll this workspace actor as a supervised headless Codex recipient using user-owned config/state
  agentlink wake <run|once|status|pause|resume|stop|retry> --config <absolute-path> [--job <job-id>]
      Run or inspect the durable serial recipient queue; stop/pause never delete contracts
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
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const manifestPath = join(cursor, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === '@sruthik/agentlink' && typeof manifest.version === 'string' && manifest.version.trim()) {
        return manifest.version;
      }
    } catch {
      // Keep walking toward the installed/source AgentLink package root.
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }

  const cwdVersion = await readVersionAt(join(cwd, 'package.json'));
  if (cwdVersion) return cwdVersion;
  return 'unknown';
}

function parseArguments(args: string[], booleanOptions: string[] = []): ParsedArguments {
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
    if (booleanOptions.includes(name)) {
      if (inlineValue !== undefined) throw new UsageError(`Option --${name} does not take a value`);
      options[name] = 'true';
      continue;
    }
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

function parseMessageKindOption(value: string): MessageKind {
  const kind = MESSAGE_KINDS.find((candidate) => candidate === value.trim().toLowerCase());
  if (!kind) throw new UsageError(`Invalid message kind: ${value}. Expected one of: ${MESSAGE_KINDS.join(', ')}`);
  return kind;
}

function parseMessageReferencesOption(value: string): MessageReference[] {
  if (!value.trim()) throw new UsageError('--refs cannot be empty');
  return value.split(',').map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new UsageError(`Invalid message reference: ${entry}. Expected type:value.`);
    const type = entry.slice(0, separator).trim();
    const referenceValue = entry.slice(separator + 1);
    if (!MESSAGE_REFERENCE_TYPES.includes(type as MessageReference['type'])) {
      throw new UsageError(`Invalid message reference type: ${type}. Expected one of: ${MESSAGE_REFERENCE_TYPES.join(', ')}`);
    }
    return { type: type as MessageReference['type'], value: referenceValue };
  });
}

function renderConversationRecord(record: ConversationRecord): string {
  if (record.type === 'conversation') {
    const target = record.target ? ` -> ${record.target}` : '';
    const cap = record.messageCap ?? record.maxRounds;
    const limits = cap ? `, message cap ${cap}` : '';
    const approvals = record.requiredApprovals ? `, requires ${record.requiredApprovals} approvals` : '';
    return `${record.createdAt} conversation started: ${record.topic}${target}${limits}${approvals}`;
  }
  if (record.type === 'message') {
    return `${record.timestamp} message ${record.role}/${record.from}: ${record.body}`;
  }
  if (record.type === 'approval') {
    const revision = record.revision ? ` for revision ${record.revision}` : '';
    return `${record.timestamp} approval from ${record.from}${revision}`;
  }
  if (record.type === 'participant') return `${record.timestamp} participant joined: ${record.displayName} (${record.participantId})`;
  if (record.type === 'participant_revoked') return `${record.timestamp} participant revoked: ${record.participantId} by ${record.revokedByParticipantId}`;
  if (record.type === 'settings') return `${record.timestamp} message cap: ${record.messageCap ?? 'unlimited'} (owner ${record.participantId})`;
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
    if (args.length > 2 || (args[1] !== undefined && args[1] !== '--tmux')) throw new UsageError('Usage: agentlink list [--tmux]');
    if (args[1] === '--tmux') {
      const panes = filterAgentPanes(await listTmuxPanes());
      if (panes.length === 0) {
        output.log('tmux capability unavailable or no coding-agent panes found; core registry and messaging remain available.');
        return;
      }
      for (const [index, pane] of panes.entries()) {
        output.log(`${index + 1}. ${pane.agentKind.padEnd(8)} ${pane.paneId.padEnd(4)} ${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.currentPath}`);
      }
      return;
    }
    const registrations = await listAgentRegistrations(cwd);
    if (registrations.length === 0) {
      output.log('No active AgentLink registrations. Run `agentlink register --label <name>` in each peer workspace.');
      return;
    }
    for (const registration of registrations) {
      output.log(`${registration.registrationId} ${registration.label} [${registration.clientKind}] participant=${registration.participantId} workspace=${registration.workspaceId} expires=${registration.expiresAt}${registration.notificationAdapterId ? ` adapter=${registration.notificationAdapterId}` : ''}`);
    }
    return;
  }

  if (command === 'init') {
    if (args.length === 2 && args[1] === '--new-workspace') {
      const identity = await rotateWorkspaceIdentity(cwd);
      output.log(`AgentLink workspace identity rotated: ${identity.workspaceId}`);
      return;
    }
    if (args.length > 1) throw new UsageError('Usage: agentlink init [--new-workspace]');
    const path = await initWorkspace(cwd);
    output.log(`AgentLink workspace ready: ${path}`);
    return;
  }

  const booleanOptions = command === 'contract'
    ? ['refresh']
    : command === 'cap'
      ? ['remove']
      : command === 'send'
        ? ['notify']
        : [];
  const { options, positionals } = parseArguments(args.slice(1), booleanOptions);

  if (command === 'actor') {
    rejectUnknownOptions(options, ['name', 'id']);
    const action = positionals[0] ?? 'show';
    if (positionals.length > 1) throw new UsageError('Usage: agentlink actor <show|list|add|use|rename> [--name <label>] [--id <participant-id>]');
    if (action === 'show') {
      const actor = await resolveActiveParticipant(cwd);
      output.log(`${actor.participantId} ${actor.displayName} (workspace ${actor.workspaceId})`);
      return;
    }
    if (action === 'list') {
      const active = await resolveActiveParticipant(cwd);
      for (const participant of await listParticipants(cwd)) output.log(`${participant.participantId === active.participantId ? '*' : ' '} ${participant.participantId} ${participant.displayName}`);
      return;
    }
    if (action === 'add') {
      if (!options.name) throw new UsageError('Usage: agentlink actor add --name <label>');
      const participant = await registerParticipant(cwd, { displayName: options.name });
      output.log(`Participant registered and selected: ${participant.participantId} ${participant.displayName}`);
      return;
    }
    if (action === 'use') {
      if (!options.id) throw new UsageError('Usage: agentlink actor use --id <participant-id>');
      const participant = await selectParticipant(cwd, options.id);
      output.log(`Participant selected: ${participant.participantId} ${participant.displayName}`);
      return;
    }
    if (action === 'rename') {
      if (!options.id || !options.name) throw new UsageError('Usage: agentlink actor rename --id <participant-id> --name <label>');
      const participant = await relabelParticipant(cwd, options.id, options.name);
      output.log(`Participant renamed: ${participant.participantId} ${participant.displayName}`);
      return;
    }
    throw new UsageError(`Unknown actor action: ${action}`);
  }

  if (command === 'register') {
    rejectUnknownOptions(options, ['label', 'client', 'ttl', 'adapter', 'id']);
    if (positionals.length > 0 || !options.label) {
      throw new UsageError('Usage: agentlink register --label <name> [--client <kind>] [--ttl <seconds>] [--adapter <trusted-adapter-id>] [--id <registration-id>]');
    }
    const registration = await registerAgent(cwd, {
      label: options.label,
      clientKind: options.client,
      notificationAdapterId: options.adapter,
      registrationId: options.id,
      ttlSeconds: options.ttl === undefined ? undefined : parsePositiveIntegerOption(options.ttl, 'ttl'),
    });
    output.log(`Agent registered: ${registration.registrationId} participant=${registration.participantId} expires=${registration.expiresAt}`);
    if (registration.notificationAdapterId) output.log(`Notification adapter reference: ${registration.notificationAdapterId} (execution still requires user trust config)`);
    return;
  }

  if (command === 'heartbeat') {
    rejectUnknownOptions(options, ['registration', 'ttl']);
    if (positionals.length > 0 || !options.registration) throw new UsageError('Usage: agentlink heartbeat --registration <id> [--ttl <seconds>]');
    const registration = await heartbeatAgent(
      cwd,
      options.registration,
      options.ttl === undefined ? undefined : parsePositiveIntegerOption(options.ttl, 'ttl'),
    );
    output.log(`Heartbeat renewed: ${registration.registrationId} expires=${registration.expiresAt}`);
    return;
  }

  if (command === 'unregister') {
    rejectUnknownOptions(options, ['registration']);
    if (positionals.length > 0 || !options.registration) throw new UsageError('Usage: agentlink unregister --registration <id>');
    await unregisterAgent(cwd, options.registration);
    output.log(`Agent unregistered: ${options.registration}`);
    return;
  }

  if (command === 'start') {
    rejectUnknownOptions(options, ['topic', 'target', 'template', 'max-messages', 'max-rounds', 'required-approvals']);
    const topic = options.topic ?? positionals.join(' ');
    if (!topic.trim()) {
      throw new UsageError(
        'Usage: agentlink start --topic <topic> [--target <pane-or-agent>] [--template <template>] [--max-messages <count>] [--max-rounds <count>] [--required-approvals <count>]',
      );
    }
    const template = options.template === undefined
      ? undefined
      : parseContractTemplateOption(options.template);
    const maxRounds = options['max-rounds'] === undefined
      ? undefined
      : parsePositiveIntegerOption(options['max-rounds'], 'max-rounds');
    const maxMessages = options['max-messages'] === undefined
      ? undefined
      : parsePositiveIntegerOption(options['max-messages'], 'max-messages');
    if (maxMessages !== undefined && maxRounds !== undefined && maxMessages !== maxRounds) {
      throw new UsageError('--max-messages and compatibility --max-rounds cannot specify different message caps');
    }
    const requiredApprovals = options['required-approvals'] === undefined
      ? undefined
      : parsePositiveIntegerOption(options['required-approvals'], 'required-approvals');
    const conversation = await createConversation(cwd, {
      topic,
      target: options.target,
      maxMessages,
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
    if (conversation.messageCap) {
      output.log(maxRounds !== undefined
        ? `Max rounds: ${conversation.messageCap} (compatibility alias; counts messages)`
        : `Message cap: ${conversation.messageCap}`);
    }
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
        const limits = conversation.messageCap ? `, message cap ${conversation.messageCap}` : '';
        const approvals = conversation.requiredApprovals
          ? `, approvals ${conversation.currentApprovalCount}/${conversation.requiredApprovals}`
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
    rejectUnknownOptions(options, ['body', 'conversation', 'role', 'from', 'kind', 'refs', 'notify', 'deliver-to', 'to']);
    const body = options.body ?? positionals.join(' ');
    if (!body.trim()) {
      throw new UsageError('Usage: agentlink send --body <message> [--role <role>] [--from <sender>] [--conversation <id>] [--deliver-to <pane-id>]');
    }
    const conversation = await resolveConversation(cwd, options.conversation);
    const message = await appendMessage(cwd, conversation.id, {
      role: options.role ?? 'user',
      ...(options.from ? { from: options.from } : {}),
      body,
      ...(options.kind ? { kind: parseMessageKindOption(options.kind) } : {}),
      ...(options.refs ? { refs: parseMessageReferencesOption(options.refs) } : {}),
      ...(options.to ? { recipientParticipantId: options.to } : {}),
    });
    output.log(`Persisted message ${message.messageId} in ${conversation.id} at ${message.timestamp}`);
    output.log(`Message appended to ${conversation.id}`);
    const notification = await notifyMessage(cwd, conversation.id, message.messageId!, message.participantId!);
    output.log(`Notification: ${notification.attempted ? `attempted; delivered=${notification.delivered}, failed=${notification.failed}` : 'not attempted; no active eligible adapter registration'}. Processing acknowledgement: pending.`);
    for (const warningText of notification.warnings) output.log(`Warning: ${warningText}`);
    const warning = capWarning(await resolveConversation(cwd, conversation.id));
    if (warning) output.log(`Warning: ${warning}`);
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

  if (command === 'join') {
    rejectUnknownOptions(options, ['conversation']);
    const positionalId = oneOptionalPositional(positionals, 'join');
    if (positionalId && options.conversation) throw new UsageError('Specify the conversation id either positionally or with --conversation, not both');
    const conversation = await resolveConversation(cwd, options.conversation ?? positionalId);
    const joined = await joinConversation(cwd, conversation.id);
    output.log(`Participant ${joined.participantId} joined conversation ${conversation.id}`);
    return;
  }

  if (command === 'read') {
    rejectUnknownOptions(options, ['conversation', 'after', 'since', 'limit', 'message-id']);
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
    if (options['message-id']) {
      if (options.after || options.since || options.limit) throw new UsageError('--message-id cannot be combined with --after, --since, or --limit');
      const message = await readMessage(cwd, conversation.id, options['message-id']);
      const metadata = [`id=${message.messageId}`, `seq=${message.sequence}`, ...(message.kind ? [`kind=${message.kind}`] : []), ...(message.recipientParticipantId ? [`to=${message.recipientParticipantId}`] : [])].join(' ');
      output.log(`Conversation ${conversation.id} [${conversation.status}]: ${conversation.topic}`);
      output.log(`${message.timestamp} ${message.role}/${message.from} ${metadata}: ${message.body}`);
      return;
    }
    const page = await readMessages(cwd, conversation.id, {
      after: options.after,
      since: options.since,
      limit,
    });
    output.log(`Conversation ${conversation.id} [${conversation.status}]: ${conversation.topic}`);
    const messages = page.messages;
    if (messages.length === 0) {
      output.log('No messages.');
    } else {
      for (const message of messages) {
        const metadata = [`id=${message.messageId}`, `seq=${message.sequence}`, ...(message.kind ? [`kind=${message.kind}`] : [])].join(' ');
        output.log(`${message.timestamp} ${message.role}/${message.from} ${metadata}: ${message.body}`);
      }
    }
    output.log(`Next cursor: ${page.nextCursor}`);
    output.log(`Has more: ${page.hasMore}`);
    output.log(`Unread: ${page.unreadCount}`);
    return;
  }

  if (command === 'wait') {
    rejectUnknownOptions(options, ['conversation', 'after', 'since', 'timeout-ms', 'limit']);
    if (positionals.length > 0 || !options.conversation || ((options.after === undefined) === (options.since === undefined))) {
      throw new UsageError('Usage: agentlink wait --conversation <id> (--after <cursor>|--since <message-id>) [--timeout-ms <1-30000>] [--limit <count>]');
    }
    const timeoutMs = options['timeout-ms'] === undefined ? 5_000 : parsePositiveIntegerOption(options['timeout-ms'], 'timeout-ms');
    const limit = options.limit === undefined ? 20 : parsePositiveIntegerOption(options.limit, 'limit');
    const page = await waitForMessages(cwd, options.conversation, {
      after: options.after,
      since: options.since,
      timeoutMs,
      limit,
    });
    output.log(`Wait outcome: ${page.outcome} after ${page.waitedMs}ms`);
    for (const message of page.messages) output.log(`${message.timestamp} ${message.role}/${message.from} id=${message.messageId} seq=${message.sequence}: ${message.body}`);
    output.log(`Next cursor: ${page.nextCursor}`);
    output.log(`Has more: ${page.hasMore}`);
    output.log(`Unread: ${page.unreadCount}`);
    return;
  }

  if (command === 'ack') {
    rejectUnknownOptions(options, ['conversation', 'message-id', 'cursor']);
    if (positionals.length > 0 || !options.conversation) {
      throw new UsageError('Usage: agentlink ack --conversation <id> (--message-id <id>|--cursor <cursor>)');
    }
    const acknowledgement = await ackMessages(cwd, options.conversation, {
      messageId: options['message-id'],
      cursor: options.cursor,
    });
    output.log(`Acknowledged through ${acknowledgement.acknowledgedMessageId ?? `sequence ${acknowledgement.acknowledgedSequence}`} for ${options.conversation}`);
    return;
  }

  if (command === 'cap') {
    rejectUnknownOptions(options, ['conversation', 'set', 'remove']);
    if (positionals.length > 0 || !options.conversation || ((options.set === undefined) === (options.remove === undefined))) {
      throw new UsageError('Usage: agentlink cap --conversation <id> (--set <count>|--remove)');
    }
    const cap = options.remove === 'true' ? null : parsePositiveIntegerOption(options.set!, 'set');
    const conversation = await setMessageCap(cwd, options.conversation, cap);
    output.log(conversation.messageCap === undefined ? `Message cap removed for ${conversation.id}` : `Message cap: ${conversation.messageCap} for ${conversation.id}`);
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
    if (options.from) throw new UsageError('Approval aliases are no longer accepted. Select a stable actor with `agentlink actor use --id <id>`, then run `agentlink approve`.');
    const conversation = await resolveConversation(cwd, options.conversation ?? positionalId);
    const approval = await approveConversation(cwd, conversation.id);
    const updated = await resolveConversation(cwd, conversation.id);
    const state = updated.requiredApprovals ? await readContractState(cwd, updated.id) : undefined;
    const currentApprovalCount = state?.revision ? countRevisionApprovals(updated, state.revision) : 0;
    const required = updated.requiredApprovals ? ` (${currentApprovalCount}/${updated.requiredApprovals})` : '';
    output.log(`Approval recorded for ${conversation.id} from ${approval.from}${required}`);
    return;
  }

  if (command === 'revoke') {
    rejectUnknownOptions(options, ['conversation', 'participant']);
    if (positionals.length > 0 || !options.conversation || !options.participant) {
      throw new UsageError('Usage: agentlink revoke --conversation <id> --participant <participant-id>');
    }
    const revoked = await revokeConversationParticipant(cwd, options.conversation, options.participant);
    output.log(`Revoked participant ${revoked.participantId} from ${options.conversation}; audit record preserved.`);
    return;
  }

  if (command === 'contract') {
    rejectUnknownOptions(options, ['conversation', 'refresh', 'if-revision', 'status', 'set-section', 'content', 'sync-to']);
    if (positionals.length > 0) {
      throw new UsageError('Usage: agentlink contract [--status <status>] [--set-section <heading> --content <markdown>] [--sync-to <repo-path>]');
    }
    if ((options['set-section'] === undefined) !== (options.content === undefined)) {
      throw new UsageError('--set-section and --content must be provided together');
    }
    let contract = await readContractState(cwd, options.conversation);
    if (options.refresh !== undefined) {
      if (options.refresh !== 'true') throw new UsageError('--refresh does not take a value');
      if (options.status !== undefined || options['set-section'] !== undefined || options['if-revision'] !== undefined || options['sync-to'] !== undefined) {
        throw new UsageError('--refresh cannot be combined with contract mutation or sync options');
      }
      if (!contract.conversationId) throw new UsageError('No selected contract. Specify --conversation <id>.');
      contract = await refreshContractCompatibilityView(cwd, contract.conversationId);
    }
    if (options.status !== undefined || options['set-section'] !== undefined) {
      if (!contract.conversationId) throw new UsageError('No selected contract. Specify --conversation <id>.');
      contract = await updateConversationContract(cwd, contract.conversationId, {
        ...(options.status !== undefined ? { status: parseContractStatusOption(options.status) } : {}),
        ...(options['set-section'] !== undefined && options.content !== undefined ? { sections: [{ heading: options['set-section'], content: options.content }] } : {}),
        ...(options['if-revision'] ? { expectedRevision: options['if-revision'] } : {}),
      });
    }
    output.log(`Contract: ${contract.status ?? 'not initialized'}`);
    if (contract.conversationId) output.log(`Conversation: ${contract.conversationId}`);
    if (contract.revision) output.log(`Revision: ${contract.revision}`);
    output.log(`Path: ${contract.path}`);
    if (options['sync-to']) {
      const targetPath = await syncContractToWorkspace(cwd, options['sync-to'], contract.conversationId);
      output.log(`Synced contract: ${targetPath}`);
    }
    return;
  }

  if (command === 'notify') {
    rejectUnknownOptions(options, ['id', 'argv-json', 'timeout-ms', 'event']);
    const action = positionals[0] ?? 'list';
    if (positionals.length > 1) throw new UsageError('Usage: agentlink notify <trust|list|retry> [options]');
    if (action === 'list') {
      if (Object.keys(options).length > 0) throw new UsageError('Usage: agentlink notify list');
      const adapters = await listTrustedNotificationAdapters(cwd);
      if (adapters.length === 0) output.log('No trusted notification adapters configured.');
      for (const adapter of adapters) output.log(`${adapter.id} timeout=${adapter.timeoutMs}ms`);
      return;
    }
    if (action === 'trust') {
      if (!options.id || !options['argv-json'] || options.event) {
        throw new UsageError('Usage: agentlink notify trust --id <adapter-id> --argv-json <json-array> [--timeout-ms <1-10000>]');
      }
      let argv: unknown;
      try {
        argv = JSON.parse(options['argv-json']);
      } catch {
        throw new UsageError('--argv-json must be valid JSON');
      }
      if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) throw new UsageError('--argv-json must be a JSON array of strings');
      const path = await configureTrustedNotificationAdapter(cwd, {
        id: options.id,
        argv,
        timeoutMs: options['timeout-ms'] === undefined ? 2_000 : parsePositiveIntegerOption(options['timeout-ms'], 'timeout-ms'),
      });
      output.log(`Trusted notification adapter ${options.id} saved in user config: ${path}`);
      output.log('Adapter argv is intentionally not printed. Repo-controlled data cannot change it and no shell is used.');
      return;
    }
    if (action === 'retry') {
      if (!options.event || options.id || options['argv-json'] || options['timeout-ms']) throw new UsageError('Usage: agentlink notify retry --event <event-id>');
      const event = await retryNotification(cwd, options.event);
      output.log(`Notification ${event.eventId}: ${event.state}; attempts=${event.attempts.length}`);
      return;
    }
    throw new UsageError(`Unknown notify action: ${action}`);
  }

  if (command === 'wake') {
    const action = positionals[0];
    if (!action || positionals.length > 1) throw new UsageError('Usage: agentlink wake <enroll|enqueue|run|once|status|pause|resume|stop|retry> [options]');
    if (action === 'enroll') {
      rejectUnknownOptions(options, ['recipient', 'conversation', 'codex', 'config', 'state', 'trust-config', 'model', 'timeout-ms', 'retry-backoff-ms', 'max-attempts', 'poll-ms', 'ttl', 'thread']);
      if (!options.recipient || !options.conversation || !options.codex) throw new UsageError('Usage: agentlink wake enroll --recipient <id> --conversation <id[,id...]> --codex <absolute-path> [options]');
      const config = await enrollCodexWake({
        recipientId: options.recipient,
        workspacePath: cwd,
        conversationIds: options.conversation.split(',').map((value) => value.trim()).filter(Boolean),
        codexExecutable: options.codex,
        agentlinkCliEntrypoint: fileURLToPath(import.meta.url),
        ...(options.config ? { configPath: options.config } : {}),
        ...(options.state ? { statePath: options.state } : {}),
        ...(options['trust-config'] ? { trustPath: options['trust-config'] } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options['timeout-ms'] ? { turnTimeoutMs: parsePositiveIntegerOption(options['timeout-ms'], 'timeout-ms') } : {}),
        ...(options['retry-backoff-ms'] ? { retryBackoffMs: parsePositiveIntegerOption(options['retry-backoff-ms'], 'retry-backoff-ms') } : {}),
        ...(options['max-attempts'] ? { maxAttempts: parsePositiveIntegerOption(options['max-attempts'], 'max-attempts') } : {}),
        ...(options['poll-ms'] ? { pollMs: parsePositiveIntegerOption(options['poll-ms'], 'poll-ms') } : {}),
        ...(options.ttl ? { registrationTtlSeconds: parsePositiveIntegerOption(options.ttl, 'ttl') } : {}),
        ...(options.thread ? { initialThreadId: options.thread } : {}),
      });
      output.log(`Supervised Codex recipient enrolled: ${config.recipientId}`);
      output.log(`Config: ${config.configPath}`);
      output.log(`State: ${config.statePath}`);
      output.log(`Registration: ${config.registrationId} participant=${config.participantId}`);
      return;
    }
    if (!options.config) throw new UsageError(`Usage: agentlink wake ${action} --config <absolute-path>`);
    if (action === 'enqueue') {
      rejectUnknownOptions(options, ['config', 'event-id', 'bus-id', 'conversation-id', 'message-id', 'registration-id']);
      if (!options['event-id'] || !options['bus-id'] || !options['conversation-id'] || !options['message-id'] || !options['registration-id']) {
        throw new UsageError('Wake enqueue requires event, bus, conversation, message, and registration ids');
      }
      const result = await enqueueCodexWake(options.config, {
        eventId: options['event-id'], busId: options['bus-id'], conversationId: options['conversation-id'],
        messageId: options['message-id'], registrationId: options['registration-id'],
      });
      output.log(`Wake enqueue: ${result.outcome}${result.job ? ` job=${result.job.jobId}` : ''}`);
      return;
    }
    if (action === 'run') {
      rejectUnknownOptions(options, ['config']);
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      output.log(`Supervised Codex recipient running with config ${options.config}`);
      try { await runCodexWakeSupervisor(options.config, controller.signal); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      output.log('Supervised Codex recipient stopped.');
      return;
    }
    if (action === 'once') {
      rejectUnknownOptions(options, ['config']);
      output.log(JSON.stringify(await runCodexWakeOnce(options.config)));
      return;
    }
    if (action === 'status') {
      rejectUnknownOptions(options, ['config']);
      output.log(JSON.stringify(await readCodexWakeStatus(options.config), null, 2));
      return;
    }
    if (action === 'pause' || action === 'resume') {
      rejectUnknownOptions(options, ['config']);
      await setCodexWakePaused(options.config, action === 'pause');
      output.log(`Supervised Codex recipient ${action === 'pause' ? 'paused' : 'resumed'}.`);
      return;
    }
    if (action === 'stop') {
      rejectUnknownOptions(options, ['config']);
      await requestCodexWakeStop(options.config);
      output.log('Supervised Codex recipient stop requested.');
      return;
    }
    if (action === 'retry') {
      rejectUnknownOptions(options, ['config', 'job']);
      if (!options.job) throw new UsageError('Usage: agentlink wake retry --config <absolute-path> --job <job-id>');
      await retryCodexWakeJob(options.config, options.job);
      output.log(`Supervised Codex job queued for explicit retry: ${options.job}`);
      return;
    }
    throw new UsageError(`Unknown wake action: ${action}`);
  }

  if (command === 'receiver') {
    rejectUnknownOptions(options, ['inbox', 'event-id', 'bus-id', 'conversation-id', 'message-id', 'registration-id']);
    if (positionals.length > 0 || !options.inbox || !options['event-id'] || !options['bus-id'] || !options['conversation-id'] || !options['message-id'] || !options['registration-id']) {
      throw new UsageError('Usage: agentlink receiver --inbox <absolute-path> --event-id <id> --bus-id <id> --conversation-id <id> --message-id <id> --registration-id <id>');
    }
    if (!isAbsolute(options.inbox)) throw new UsageError('--inbox must be an absolute path supplied by trusted user configuration');
    const outcome = await receiveNotification(options.inbox, {
      eventId: options['event-id'],
      busId: options['bus-id'],
      conversationId: options['conversation-id'],
      messageId: options['message-id'],
      registrationId: options['registration-id'],
    });
    output.log(`Notification receiver: ${outcome}`);
    return;
  }

  if (command === 'end') {
    rejectUnknownOptions(options, ['conversation']);
    const positionalId = oneOptionalPositional(positionals, 'end');
    if (positionalId && options.conversation) {
      throw new UsageError('Specify the conversation id either positionally or with --conversation, not both');
    }
    const conversationId = options.conversation ?? positionalId;
    if (!conversationId) throw new UsageError('Usage: agentlink end --conversation <id>');
    const conversation = await resolveConversation(cwd, conversationId);
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
