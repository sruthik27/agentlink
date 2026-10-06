import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteFile, assertNotSymlink, readUtf8IfExists, withFileLock } from './atomic.js';
import { configureTrustedNotificationAdapter, type NotificationReferences } from './notifications.js';
import {
  ackMessagesForParticipant,
  readAcknowledgementForParticipant,
  readConversation,
  type ConversationMessageRecord,
} from './store.js';
import {
  heartbeatAgentForParticipant,
  initializeWorkspaceIdentity,
  listAgentRegistrations,
  registerAgentForParticipant,
  resolveActiveParticipant,
} from './workspace.js';

const CONFIG_VERSION = 1;
const STATE_VERSION = 1;
const DEFAULT_TTL_SECONDS = 90;
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

export interface CodexWakeConfig {
  schemaVersion: 1;
  recipientId: string;
  workspacePath: string;
  workspaceId: string;
  busId: string;
  busPath: string;
  participantId: string;
  registrationId: string;
  adapterId: string;
  conversationIds: string[];
  enrolledSequences: Record<string, number>;
  configPath: string;
  statePath: string;
  trustPath: string;
  codexExecutable: string;
  nodeExecutable: string;
  agentlinkCliEntrypoint: string;
  model: string;
  turnTimeoutMs: number;
  retryBackoffMs: number;
  maxAttempts: number;
  pollMs: number;
  registrationTtlSeconds: number;
  enrolledAt: string;
  initialThreadId?: string;
}

export interface EnrollCodexWakeInput {
  recipientId: string;
  workspacePath: string;
  conversationIds: string[];
  configPath?: string;
  statePath?: string;
  trustPath?: string;
  codexExecutable: string;
  agentlinkCliEntrypoint: string;
  model?: string;
  turnTimeoutMs?: number;
  retryBackoffMs?: number;
  maxAttempts?: number;
  pollMs?: number;
  registrationTtlSeconds?: number;
  initialThreadId?: string;
}

export type WakeJobState = 'pending' | 'running' | 'completed' | 'suspended';

export interface CodexWakeJob {
  jobId: string;
  eventIds: string[];
  busId: string;
  conversationId: string;
  messageId: string;
  messageSequence: number;
  recipientRegistrationId: string;
  state: WakeJobState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  transcriptPath?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  threadId?: string;
  beforeGitStatus?: string;
  afterGitStatus?: string;
  resultMessageId?: string;
}

interface CodexWakeState {
  schemaVersion: 1;
  paused: boolean;
  stopRequested: boolean;
  jobs: CodexWakeJob[];
  threadIds: Record<string, string>;
  updatedAt: string;
}

export interface CodexWakeStatus {
  recipientId: string;
  participantId: string;
  registrationId: string;
  workspacePath: string;
  paused: boolean;
  stopRequested: boolean;
  counts: Record<WakeJobState, number>;
  threadIds: Record<string, string>;
  jobs: CodexWakeJob[];
}

export interface EnqueueWakeResult {
  outcome: 'queued' | 'duplicate' | 'ignored';
  reason?: string;
  job?: CodexWakeJob;
}

export interface RunWakeResult {
  outcome: 'idle' | 'busy' | 'paused' | 'stopped' | 'completed' | 'retry_scheduled' | 'suspended';
  jobId?: string;
  detail?: string;
}

function assertId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return value;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

async function canonicalFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const canonical = await realpath(path);
  const details = await stat(canonical);
  if (!details.isFile()) throw new Error(`${label} must be a file: ${canonical}`);
  return canonical;
}

async function safeExternalDirectory(path: string, workspace: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  await assertNotSymlink(path, label);
  await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  if (pathIsWithin(workspace, canonical)) throw new Error(`${label} must be outside repository workspace ${workspace}`);
  return canonical;
}

function defaultConfigPath(recipientId: string): string {
  return join(homedir(), '.config', 'agentlink', 'wake', `${recipientId}.json`);
}

function defaultStatePath(recipientId: string): string {
  return join(homedir(), '.local', 'state', 'agentlink', 'wake', recipientId);
}

function stateFile(config: CodexWakeConfig): string {
  return join(config.statePath, 'queue.json');
}

function stateLocks(config: CodexWakeConfig): string {
  return join(config.statePath, 'locks');
}

function now(): string {
  return new Date().toISOString();
}

function emptyState(initialThreadId: string | undefined, conversationIds: string[]): CodexWakeState {
  const threadIds: Record<string, string> = {};
  if (initialThreadId) {
    if (conversationIds.length !== 1) throw new Error('An initial thread id requires exactly one allowed conversation');
    threadIds[conversationIds[0]!] = initialThreadId;
  }
  return { schemaVersion: 1, paused: false, stopRequested: false, jobs: [], threadIds, updatedAt: now() };
}

async function readState(config: CodexWakeConfig): Promise<CodexWakeState> {
  const content = await readUtf8IfExists(stateFile(config));
  if (content === undefined) return emptyState(config.initialThreadId, config.conversationIds);
  const parsed = JSON.parse(content) as CodexWakeState;
  if (parsed.schemaVersion !== STATE_VERSION || !Array.isArray(parsed.jobs) || typeof parsed.threadIds !== 'object') {
    throw new Error(`Invalid Codex wake state: ${stateFile(config)}`);
  }
  return parsed;
}

async function writeState(config: CodexWakeConfig, state: CodexWakeState): Promise<void> {
  state.updatedAt = now();
  await atomicWriteFile(stateFile(config), `${JSON.stringify(state, null, 2)}\n`);
}

async function updateState<T>(config: CodexWakeConfig, operation: (state: CodexWakeState) => T | Promise<T>): Promise<T> {
  return withFileLock(stateLocks(config), 'queue', async () => {
    const state = await readState(config);
    const result = await operation(state);
    await writeState(config, state);
    return result;
  });
}

async function readConfig(configPath: string): Promise<CodexWakeConfig> {
  if (!isAbsolute(configPath)) throw new Error('Codex wake config path must be absolute');
  await assertNotSymlink(configPath, 'Codex wake config');
  await assertNotSymlink(dirname(configPath), 'Codex wake config directory');
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as CodexWakeConfig;
  if (parsed.schemaVersion !== CONFIG_VERSION || parsed.configPath !== resolve(configPath)) throw new Error(`Invalid Codex wake config: ${configPath}`);
  const workspace = await realpath(parsed.workspacePath);
  if (workspace !== parsed.workspacePath) throw new Error(`Codex wake workspace canonical path changed: ${parsed.workspacePath}`);
  if (pathIsWithin(workspace, parsed.configPath) || pathIsWithin(workspace, parsed.statePath) || pathIsWithin(workspace, parsed.trustPath)) {
    throw new Error('Codex wake config, state, and trust paths must remain outside the repository workspace');
  }
  await assertNotSymlink(parsed.statePath, 'Codex wake state directory');
  await assertNotSymlink(parsed.trustPath, 'Notification trust config');
  if (await realpath(parsed.statePath) !== parsed.statePath) throw new Error(`Codex wake state canonical path changed: ${parsed.statePath}`);
  if (await realpath(parsed.codexExecutable) !== parsed.codexExecutable) throw new Error(`Codex executable canonical path changed: ${parsed.codexExecutable}`);
  if (await realpath(parsed.agentlinkCliEntrypoint) !== parsed.agentlinkCliEntrypoint) throw new Error(`AgentLink CLI canonical path changed: ${parsed.agentlinkCliEntrypoint}`);
  const context = await initializeWorkspaceIdentity(workspace);
  if (context.identity.workspaceId !== parsed.workspaceId || context.bus.busId !== parsed.busId || context.association.busPath !== parsed.busPath) {
    throw new Error('Codex wake workspace/bus binding no longer matches enrollment');
  }
  assertId(parsed.recipientId, 'recipient id');
  assertId(parsed.participantId, 'participant id');
  assertId(parsed.registrationId, 'registration id');
  parsed.conversationIds.forEach((id) => assertId(id, 'conversation id'));
  return parsed;
}

export async function enrollCodexWake(input: EnrollCodexWakeInput): Promise<CodexWakeConfig> {
  const recipientId = assertId(input.recipientId, 'recipient id');
  if (!Array.isArray(input.conversationIds) || input.conversationIds.length === 0) throw new Error('At least one allowed conversation is required');
  const conversationIds = [...new Set(input.conversationIds.map((id) => assertId(id, 'conversation id')))];
  const workspacePath = await realpath(resolve(input.workspacePath));
  const context = await initializeWorkspaceIdentity(workspacePath);
  const actor = await resolveActiveParticipant(workspacePath);
  const configTarget = resolve(input.configPath ?? defaultConfigPath(recipientId));
  if (pathIsWithin(workspacePath, configTarget)) throw new Error('Codex wake config must be outside the repository workspace');
  await assertNotSymlink(configTarget, 'Codex wake config');
  await assertNotSymlink(dirname(configTarget), 'Codex wake config directory');
  await mkdir(dirname(configTarget), { recursive: true });
  const statePath = await safeExternalDirectory(resolve(input.statePath ?? defaultStatePath(recipientId)), workspacePath, 'Codex wake state directory');
  const trustPath = resolve(input.trustPath ?? join(homedir(), '.config', 'agentlink', 'notifications.json'));
  if (pathIsWithin(workspacePath, trustPath)) throw new Error('Notification trust config must be outside the repository workspace');
  const codexExecutable = await canonicalFile(input.codexExecutable, 'Codex executable');
  const agentlinkCliEntrypoint = await canonicalFile(input.agentlinkCliEntrypoint, 'AgentLink CLI entrypoint');
  const nodeExecutable = await canonicalFile(process.execPath, 'Node executable');
  const existingConfig = await readUtf8IfExists(configTarget) === undefined ? undefined : await readConfig(configTarget);
  if (existingConfig) {
    if (existingConfig.recipientId !== recipientId || existingConfig.workspaceId !== context.identity.workspaceId
      || existingConfig.busId !== context.bus.busId || existingConfig.participantId !== actor.participantId) {
      throw new Error('Existing Codex wake enrollment belongs to a different recipient, workspace, bus, or participant; refusing destructive replacement');
    }
    if (existingConfig.statePath !== statePath || existingConfig.trustPath !== trustPath) {
      throw new Error('Re-enrollment must retain the existing state and trust paths; use an explicit new recipient id for a separate enrollment');
    }
    const removed = existingConfig.conversationIds.filter((conversationId) => !conversationIds.includes(conversationId));
    if (removed.length > 0) throw new Error(`Re-enrollment cannot silently remove allowed conversations with durable state: ${removed.join(', ')}`);
    if (await readUtf8IfExists(stateFile(existingConfig)) === undefined) {
      throw new Error(`Existing Codex wake queue is missing: ${stateFile(existingConfig)}. Refusing to advance reconciliation baselines.`);
    }
    await readState(existingConfig);
  }
  const enrolledSequences: Record<string, number> = {};
  for (const conversationId of conversationIds) {
    const conversation = await readConversation(workspacePath, conversationId);
    if (!conversation.participantIds.includes(actor.participantId)) {
      throw new Error(`Participant ${actor.participantId} is not eligible in conversation ${conversationId}`);
    }
    enrolledSequences[conversationId] = existingConfig?.enrolledSequences[conversationId] ?? conversation.messages.at(-1)?.sequence ?? 0;
  }
  const registrationId = `reg_${recipientId}`;
  const adapterId = `wake_${recipientId}`;
  const config: CodexWakeConfig = {
    schemaVersion: 1,
    recipientId,
    workspacePath,
    workspaceId: context.identity.workspaceId,
    busId: context.bus.busId,
    busPath: context.association.busPath,
    participantId: actor.participantId,
    registrationId,
    adapterId,
    conversationIds,
    enrolledSequences,
    configPath: configTarget,
    statePath,
    trustPath,
    codexExecutable,
    nodeExecutable,
    agentlinkCliEntrypoint,
    model: input.model?.trim() || 'gpt-5.6-sol',
    turnTimeoutMs: positiveInteger(input.turnTimeoutMs ?? 15 * 60_000, 'Turn timeout', 60 * 60_000),
    retryBackoffMs: positiveInteger(input.retryBackoffMs ?? 30_000, 'Retry backoff', 60 * 60_000),
    maxAttempts: positiveInteger(input.maxAttempts ?? 3, 'Max attempts', 10),
    pollMs: positiveInteger(input.pollMs ?? 1_000, 'Poll interval', 60_000),
    registrationTtlSeconds: positiveInteger(input.registrationTtlSeconds ?? DEFAULT_TTL_SECONDS, 'Registration TTL', 86_400),
    enrolledAt: now(),
    ...(input.initialThreadId || existingConfig?.initialThreadId
      ? { initialThreadId: assertId(input.initialThreadId ?? existingConfig!.initialThreadId!, 'Codex thread id') }
      : {}),
  };
  await atomicWriteFile(configTarget, `${JSON.stringify(config, null, 2)}\n`);
  if (!existingConfig) await writeState(config, emptyState(config.initialThreadId, conversationIds));
  await configureTrustedNotificationAdapter(workspacePath, {
    id: adapterId,
    argv: [nodeExecutable, agentlinkCliEntrypoint, 'wake', 'enqueue', '--config', configTarget],
    timeoutMs: 5_000,
  }, trustPath);
  await registerAgentForParticipant(workspacePath, {
    registrationId,
    label: `Headless Codex ${recipientId}`,
    clientKind: 'codex-headless-supervisor',
    notificationAdapterId: adapterId,
    ttlSeconds: config.registrationTtlSeconds,
  }, actor.participantId);
  return config;
}

function jobId(config: CodexWakeConfig, conversationId: string, messageId: string): string {
  const digest = createHash('sha256').update(config.busId).update('\0').update(conversationId).update('\0').update(messageId).update('\0').update(config.registrationId).digest('hex');
  return `job_${digest.slice(0, 32)}`;
}

function actionableFor(config: CodexWakeConfig, message: ConversationMessageRecord): { actionable: boolean; reason?: string } {
  if (message.participantId === config.participantId) return { actionable: false, reason: 'own message' };
  if (message.kind === 'status') return { actionable: false, reason: 'status-only message' };
  if (message.recipientParticipantId && message.recipientParticipantId !== config.participantId) {
    return { actionable: false, reason: 'message targets another participant' };
  }
  return { actionable: true };
}

async function enqueueMessage(config: CodexWakeConfig, conversationId: string, message: ConversationMessageRecord, eventId?: string): Promise<EnqueueWakeResult> {
  const id = jobId(config, conversationId, message.messageId!);
  return updateState(config, (state) => {
    const existing = state.jobs.find((job) => job.messageId === message.messageId && job.conversationId === conversationId);
    if (existing) {
      if (eventId && !existing.eventIds.includes(eventId)) existing.eventIds.push(eventId);
      return { outcome: 'duplicate', job: existing };
    }
    const timestamp = now();
    const job: CodexWakeJob = {
      jobId: id,
      eventIds: eventId ? [eventId] : [],
      busId: config.busId,
      conversationId,
      messageId: message.messageId!,
      messageSequence: message.sequence!,
      recipientRegistrationId: config.registrationId,
      state: 'pending',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.jobs.push(job);
    return { outcome: 'queued', job };
  });
}

async function enqueueValidatedMessage(config: CodexWakeConfig, conversationId: string, message: ConversationMessageRecord, eventId?: string): Promise<EnqueueWakeResult> {
  const check = actionableFor(config, message);
  if (!check.actionable) return { outcome: 'ignored', reason: check.reason };
  return enqueueMessage(config, conversationId, message, eventId);
}

export async function enqueueCodexWake(configPath: string, refs: NotificationReferences): Promise<EnqueueWakeResult> {
  Object.entries(refs).forEach(([label, value]) => assertId(value, label));
  const config = await readConfig(configPath);
  if (refs.busId !== config.busId) throw new Error(`Notification bus ${refs.busId} does not match enrolled bus ${config.busId}`);
  if (refs.registrationId !== config.registrationId) throw new Error(`Notification registration ${refs.registrationId} does not match enrolled registration ${config.registrationId}`);
  if (!config.conversationIds.includes(refs.conversationId)) throw new Error(`Conversation ${refs.conversationId} is not allowed for recipient ${config.recipientId}`);
  const registration = (await listAgentRegistrations(config.workspacePath)).find((candidate) => candidate.registrationId === config.registrationId);
  if (!registration || registration.participantId !== config.participantId || registration.workspaceId !== config.workspaceId || registration.notificationAdapterId !== config.adapterId) {
    throw new Error(`Enrolled registration ${config.registrationId} is missing or has different provenance`);
  }
  const conversation = await readConversation(config.workspacePath, refs.conversationId);
  if (!conversation.participantIds.includes(config.participantId)) throw new Error(`Recipient participant is not eligible in conversation ${refs.conversationId}`);
  const message = conversation.messages.find((candidate) => candidate.messageId === refs.messageId);
  if (!message) throw new Error(`Message ${refs.messageId} was not found in conversation ${refs.conversationId}`);
  return enqueueValidatedMessage(config, refs.conversationId, message, refs.eventId);
}

export async function reconcileCodexWake(configPath: string): Promise<{ queued: number; ignored: number }> {
  const config = await readConfig(configPath);
  let queued = 0;
  let ignored = 0;
  for (const conversationId of config.conversationIds) {
    const conversation = await readConversation(config.workspacePath, conversationId);
    if (!conversation.participantIds.includes(config.participantId)) throw new Error(`Recipient participant is no longer eligible in conversation ${conversationId}`);
    const acknowledgement = await readAcknowledgementForParticipant(config.workspacePath, conversationId, config.participantId);
    for (const message of conversation.messages) {
      if (message.sequence! <= (config.enrolledSequences[conversationId] ?? 0)) continue;
      if (message.sequence! <= (acknowledgement?.acknowledgedSequence ?? 0)) continue;
      const result = await enqueueValidatedMessage(config, conversationId, message);
      if (result.outcome === 'queued') queued += 1;
      else if (result.outcome === 'ignored') ignored += 1;
    }
  }
  return { queued, ignored };
}

async function gitStatus(workspacePath: string): Promise<string> {
  return new Promise((resolveResult) => {
    const child = spawn('git', ['-C', workspacePath, 'status', '--porcelain=v1', '--untracked-files=all'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 256_000) output += chunk.toString('utf8'); });
    child.once('error', () => resolveResult('<git status unavailable>'));
    child.once('exit', (code) => resolveResult(code === 0 ? output : '<git status unavailable>'));
  });
}

function workflowPrompt(config: CodexWakeConfig, job: CodexWakeJob): string {
  const command = `${JSON.stringify(config.nodeExecutable)} ${JSON.stringify(config.agentlinkCliEntrypoint)}`;
  return [
    'You are the explicitly enrolled supervised headless Codex recipient for AgentLink.',
    `Process exactly durable message ${job.messageId} in conversation ${job.conversationId}.`,
    'The notification contains references only. Retrieve the exact durable body from your own workspace with:',
    `${command} read --conversation ${job.conversationId} --message-id ${job.messageId}`,
    'Honor the authoritative contract and approval gates. Perform the requested task only inside the configured workspace and allowed AgentLink bus.',
    'Make the operation idempotent: inspect current state before changing anything. Do not acknowledge the message yourself; the supervisor owns acknowledgement after validating your completion checkpoint.',
    'After completing the work, report a concise status back to the same conversation with:',
    `${command} send --conversation ${job.conversationId} --kind status --refs msg_id:${job.messageId} --body "<concise result or blocker>"`,
    `Return only a JSON object matching the supplied schema. Use outcome "completed" only when the requested work and report succeeded, and set messageId to "${job.messageId}". Otherwise use outcome "blocked".`,
  ].join('\n');
}

interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

async function runChild(config: CodexWakeConfig, job: CodexWakeJob, outputPath: string, schemaPath: string, abortSignal?: AbortSignal): Promise<ChildResult> {
  const existingThread = (await readState(config)).threadIds[job.conversationId];
  const args = existingThread
    ? ['exec', 'resume', existingThread, '--json', '--model', config.model, '--output-schema', schemaPath, '--output-last-message', outputPath, '-']
    : ['exec', '--json', '--model', config.model, '--sandbox', 'workspace-write', '--cd', config.workspacePath, '--add-dir', config.busPath, '--output-schema', schemaPath, '--output-last-message', outputPath, '-'];
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(config.codexExecutable, args, {
      cwd: config.workspacePath,
      env: { ...process.env, AGENTLINK_PARTICIPANT_ID: config.participantId, AGENTLINK_TRUST_CONFIG: config.trustPath },
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(stopPoll);
      abortSignal?.removeEventListener('abort', abort);
      resolveResult({ exitCode, signal, stdout, stderr, timedOut, aborted, ...(spawnError ? { spawnError } : {}) });
    };
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      const force = setTimeout(() => terminate('SIGKILL'), 1_000);
      force.unref();
    }, config.turnTimeoutMs);
    const abort = (): void => {
      aborted = true;
      terminate('SIGTERM');
      const force = setTimeout(() => terminate('SIGKILL'), 1_000);
      force.unref();
    };
    const stopPoll = setInterval(() => {
      void readState(config).then((state) => {
        if (state.stopRequested && !settled) abort();
      }).catch(() => undefined);
    }, 250);
    stopPoll.unref();
    abortSignal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_TRANSCRIPT_BYTES) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_TRANSCRIPT_BYTES) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish(null, null, error.message));
    child.once('exit', (code, signal) => finish(code, signal));
    child.stdin.end(workflowPrompt(config, job));
    if (abortSignal?.aborted) abort();
  });
}

function parseThreadId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown; session_id?: unknown };
      const id = typeof event.thread_id === 'string' ? event.thread_id : typeof event.session_id === 'string' ? event.session_id : undefined;
      if (id && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) && (event.type === 'thread.started' || event.type === 'session.started')) return id;
    } catch {
      // Non-JSON stderr-like output is retained in the transcript and fails only if no completion checkpoint exists.
    }
  }
  return undefined;
}

async function completionCheckpoint(path: string, expectedMessageId: string): Promise<{ outcome: 'completed' | 'blocked'; messageId: string; summary: string }> {
  await assertNotSymlink(path, 'Codex completion checkpoint');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { outcome?: unknown; messageId?: unknown; summary?: unknown };
  if (!['completed', 'blocked'].includes(String(parsed.outcome)) || parsed.messageId !== expectedMessageId || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new Error('Codex completion checkpoint is malformed or names the wrong message');
  }
  return parsed as { outcome: 'completed' | 'blocked'; messageId: string; summary: string };
}

function quotaFailure(result: ChildResult): boolean {
  return /(?:429|quota|rate.?limit|too many requests)/i.test(`${result.stderr}\n${result.stdout}`);
}

function codexFailureDetail(result: ChildResult): string | undefined {
  const lines = result.stdout.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: unknown; message?: unknown; error?: { message?: unknown } };
      const message = typeof event.error?.message === 'string' ? event.error.message : typeof event.message === 'string' ? event.message : undefined;
      if (message && (event.type === 'turn.failed' || event.type === 'error')) return message.slice(0, 1_000);
    } catch {
      // Keep looking for a structured Codex error event.
    }
  }
  const stderrLine = result.stderr.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
  return stderrLine?.slice(0, 1_000);
}

async function recoverStaleRunning(config: CodexWakeConfig, state: CodexWakeState): Promise<void> {
  for (const job of state.jobs.filter((candidate) => candidate.state === 'running')) {
    const ack = await readAcknowledgementForParticipant(config.workspacePath, job.conversationId, config.participantId);
    if ((ack?.acknowledgedSequence ?? 0) >= job.messageSequence) {
      job.state = 'completed';
      job.completedAt = now();
      job.lastError = 'Recovered completed job from durable processing acknowledgement';
    } else {
      job.state = 'suspended';
      job.lastError = 'Supervisor stopped while job was running; explicit retry required because side effects may have occurred';
    }
    job.updatedAt = now();
  }
}

function selectNextJob(state: CodexWakeState): CodexWakeJob | undefined {
  return state.jobs
    .filter((job) => job.state === 'pending' && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= Date.now()))
    .filter((job) => !state.jobs.some((earlier) => (
      earlier.conversationId === job.conversationId
      && earlier.messageSequence < job.messageSequence
      && earlier.state !== 'completed'
    )))
    .sort((left, right) => left.conversationId === right.conversationId
      ? left.messageSequence - right.messageSequence
      : left.createdAt.localeCompare(right.createdAt) || left.conversationId.localeCompare(right.conversationId))[0];
}

async function findCompletionReport(
  config: CodexWakeConfig,
  job: CodexWakeJob,
  afterSequence: number,
): Promise<ConversationMessageRecord | undefined> {
  const conversation = await readConversation(config.workspacePath, job.conversationId);
  return conversation.messages.find((message) => (
    message.sequence! > afterSequence
    && message.participantId === config.participantId
    && message.kind === 'status'
    && message.refs?.some((reference) => reference.type === 'msg_id' && reference.value === job.messageId)
  ));
}

export async function runCodexWakeOnce(configPath: string, abortSignal?: AbortSignal): Promise<RunWakeResult> {
  const config = await readConfig(configPath);
  await reconcileCodexWake(configPath);
  try {
    return await withFileLock(stateLocks(config), 'runner', async () => {
      let selected: CodexWakeJob | undefined;
      const gate = await updateState(config, async (state) => {
        await recoverStaleRunning(config, state);
        if (state.stopRequested) return 'stopped' as const;
        if (state.paused) return 'paused' as const;
        selected = selectNextJob(state);
        if (!selected) return 'idle' as const;
        selected.state = 'running';
        selected.attempts += 1;
        selected.startedAt = now();
        selected.updatedAt = selected.startedAt;
        delete selected.nextAttemptAt;
        return 'run' as const;
      });
      if (gate === 'stopped') return { outcome: 'stopped' };
      if (gate === 'paused') return { outcome: 'paused' };
      if (gate === 'idle' || !selected) return { outcome: 'idle' };
      const job = selected;
      const attemptDirectory = join(config.statePath, 'attempts', job.jobId, String(job.attempts));
      await mkdir(attemptDirectory, { recursive: true });
      const outputPath = join(attemptDirectory, 'last-message.json');
      const transcriptPath = join(attemptDirectory, 'transcript.json');
      const schemaPath = join(config.statePath, 'completion-schema.json');
      await atomicWriteFile(schemaPath, `${JSON.stringify({
        type: 'object', additionalProperties: false,
        properties: { outcome: { type: 'string', enum: ['completed', 'blocked'] }, messageId: { type: 'string' }, summary: { type: 'string' } },
        required: ['outcome', 'messageId', 'summary'],
      }, null, 2)}\n`);
      const conversationBefore = await readConversation(config.workspacePath, job.conversationId);
      const reportAfterSequence = conversationBefore.messages.at(-1)?.sequence ?? 0;
      const beforeGitStatus = await gitStatus(config.workspacePath);
      const result = await runChild(config, job, outputPath, schemaPath, abortSignal);
      const afterGitStatus = await gitStatus(config.workspacePath);
      const observedThreadId = parseThreadId(result.stdout);
      if (observedThreadId) {
        await updateState(config, (state) => {
          state.threadIds[job.conversationId] = observedThreadId;
          const current = state.jobs.find((candidate) => candidate.jobId === job.jobId);
          if (current) current.threadId = observedThreadId;
        });
      }
      await atomicWriteFile(transcriptPath, `${JSON.stringify({
        jobId: job.jobId, conversationId: job.conversationId, messageId: job.messageId,
        startedAt: job.startedAt, finishedAt: now(), exitCode: result.exitCode, signal: result.signal,
        timedOut: result.timedOut, aborted: result.aborted, spawnError: result.spawnError, stdout: result.stdout, stderr: result.stderr,
        beforeGitStatus, afterGitStatus,
      }, null, 2)}\n`);

      let checkpoint: Awaited<ReturnType<typeof completionCheckpoint>> | undefined;
      let completionReport: ConversationMessageRecord | undefined;
      let failure: string | undefined;
      if (result.aborted) failure = 'Codex turn terminated during supervisor shutdown';
      else if (result.timedOut) failure = `Codex turn timed out after ${config.turnTimeoutMs}ms`;
      else if (result.spawnError) failure = `Codex failed to start: ${result.spawnError}`;
      else if (result.exitCode !== 0) {
        const detail = codexFailureDetail(result);
        failure = `Codex exited with ${result.signal ? `signal ${result.signal}` : `code ${result.exitCode}`}${detail ? `: ${detail}` : ''}`;
      }
      else {
        try { checkpoint = await completionCheckpoint(outputPath, job.messageId); }
        catch (error) { failure = (error as Error).message; }
        if (checkpoint?.outcome === 'blocked') failure = `Codex reported blocker: ${checkpoint.summary}`;
        if (!(await readState(config)).threadIds[job.conversationId] && !observedThreadId) failure = 'Codex did not emit a thread id for the new conversation session';
        if (!failure && checkpoint?.outcome === 'completed') {
          completionReport = await findCompletionReport(config, job, reportAfterSequence);
          if (!completionReport) failure = `Codex completion evidence is missing a new recipient-authored status message referencing ${job.messageId}`;
        }
      }

      if (!failure && checkpoint && completionReport) {
        await ackMessagesForParticipant(config.workspacePath, job.conversationId, { messageId: job.messageId }, config.participantId);
        await updateState(config, (state) => {
          const current = state.jobs.find((candidate) => candidate.jobId === job.jobId)!;
          current.state = 'completed';
          current.completedAt = now();
          current.updatedAt = current.completedAt;
          current.exitCode = result.exitCode;
          current.signal = result.signal;
          current.transcriptPath = transcriptPath;
          current.beforeGitStatus = beforeGitStatus;
          current.afterGitStatus = afterGitStatus;
          current.resultMessageId = completionReport.messageId;
          if (observedThreadId) state.threadIds[job.conversationId] = observedThreadId;
          current.threadId = state.threadIds[job.conversationId];
          delete current.lastError;
        });
        return { outcome: 'completed', jobId: job.jobId };
      }

      const retryable = quotaFailure(result) && job.attempts < config.maxAttempts;
      await updateState(config, (state) => {
        const current = state.jobs.find((candidate) => candidate.jobId === job.jobId)!;
        current.state = retryable ? 'pending' : 'suspended';
        current.updatedAt = now();
        current.lastError = failure ?? 'Codex completion failed';
        current.exitCode = result.exitCode;
        current.signal = result.signal;
        current.transcriptPath = transcriptPath;
        current.beforeGitStatus = beforeGitStatus;
        current.afterGitStatus = afterGitStatus;
        if (retryable) current.nextAttemptAt = new Date(Date.now() + config.retryBackoffMs * (2 ** (current.attempts - 1))).toISOString();
      });
      return { outcome: retryable ? 'retry_scheduled' : 'suspended', jobId: job.jobId, detail: failure };
    }, { timeoutMs: 25, retryMs: 5, staleMs: Math.max(config.turnTimeoutMs + 5_000, 30_000) });
  } catch (error) {
    if (/Timed out acquiring lock runner/.test((error as Error).message)) return { outcome: 'busy' };
    throw error;
  }
}

export async function readCodexWakeStatus(configPath: string): Promise<CodexWakeStatus> {
  const config = await readConfig(configPath);
  const state = await readState(config);
  const counts: Record<WakeJobState, number> = { pending: 0, running: 0, completed: 0, suspended: 0 };
  state.jobs.forEach((job) => { counts[job.state] += 1; });
  return {
    recipientId: config.recipientId,
    participantId: config.participantId,
    registrationId: config.registrationId,
    workspacePath: config.workspacePath,
    paused: state.paused,
    stopRequested: state.stopRequested,
    counts,
    threadIds: { ...state.threadIds },
    jobs: state.jobs.map((job) => ({ ...job, eventIds: [...job.eventIds] })),
  };
}

export async function setCodexWakePaused(configPath: string, paused: boolean): Promise<void> {
  const config = await readConfig(configPath);
  await updateState(config, (state) => { state.paused = paused; });
}

export async function requestCodexWakeStop(configPath: string): Promise<void> {
  const config = await readConfig(configPath);
  await updateState(config, (state) => { state.stopRequested = true; });
}

export async function retryCodexWakeJob(configPath: string, requestedJobId: string): Promise<void> {
  const config = await readConfig(configPath);
  assertId(requestedJobId, 'wake job id');
  await updateState(config, (state) => {
    const job = state.jobs.find((candidate) => candidate.jobId === requestedJobId);
    if (!job) throw new Error(`Codex wake job not found: ${requestedJobId}`);
    if (job.state === 'completed') throw new Error(`Completed Codex wake job cannot be retried: ${requestedJobId}`);
    job.state = 'pending';
    job.attempts = 0;
    job.updatedAt = now();
    delete job.nextAttemptAt;
    delete job.lastError;
  });
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait) => {
    if (signal?.aborted) return resolveWait();
    const timer = setTimeout(resolveWait, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolveWait(); }, { once: true });
  });
}

export async function runCodexWakeSupervisor(configPath: string, signal?: AbortSignal): Promise<void> {
  const config = await readConfig(configPath);
  await registerAgentForParticipant(config.workspacePath, {
    registrationId: config.registrationId,
    label: `Headless Codex ${config.recipientId}`,
    clientKind: 'codex-headless-supervisor',
    notificationAdapterId: config.adapterId,
    ttlSeconds: config.registrationTtlSeconds,
  }, config.participantId);
  await updateState(config, (state) => { state.stopRequested = false; });
  let nextHeartbeat = 0;
  while (!signal?.aborted) {
    const state = await readState(config);
    if (state.stopRequested) return;
    if (Date.now() >= nextHeartbeat) {
      await heartbeatAgentForParticipant(config.workspacePath, config.registrationId, config.participantId, config.registrationTtlSeconds);
      nextHeartbeat = Date.now() + Math.max(1_000, Math.floor(config.registrationTtlSeconds * 1_000 / 3));
    }
    await runCodexWakeOnce(configPath, signal);
    await wait(config.pollMs, signal);
  }
}
