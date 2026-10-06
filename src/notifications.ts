import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { atomicWriteFile, assertNotSymlink, readUtf8IfExists, withFileLock } from './atomic.js';
import { readConversation } from './store.js';
import {
  busLocksPath,
  busNotificationsPath,
  initializeWorkspaceIdentity,
  listAgentRegistrations,
} from './workspace.js';

export const MAX_NOTIFICATION_TIMEOUT_MS = 10_000;

export interface TrustedNotificationAdapter {
  id: string;
  argv: string[];
  timeoutMs: number;
}

interface TrustedNotificationConfig {
  schemaVersion: 1;
  adapters: TrustedNotificationAdapter[];
}

export interface NotificationAttempt {
  attemptedAt: string;
  outcome: 'delivered' | 'failed';
  detail: string;
}

export interface NotificationEvent {
  schemaVersion: 1;
  eventId: string;
  busId: string;
  conversationId: string;
  messageId: string;
  recipientRegistrationId: string;
  recipientParticipantId: string;
  adapterId: string;
  createdAt: string;
  state: 'pending' | 'delivered' | 'failed';
  attempts: NotificationAttempt[];
}

export interface NotificationDispatchResult {
  attempted: boolean;
  delivered: number;
  failed: number;
  skipped: number;
  events: NotificationEvent[];
  warnings: string[];
}

export interface NotificationReferences {
  eventId: string;
  busId: string;
  conversationId: string;
  messageId: string;
  registrationId: string;
}

function assertId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function assertTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_NOTIFICATION_TIMEOUT_MS) {
    throw new Error(`Notification timeout must be an integer from 1 to ${MAX_NOTIFICATION_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

export function notificationTrustPath(cwd = process.cwd()): string {
  const configured = process.env.AGENTLINK_TRUST_CONFIG?.trim();
  const path = resolve(configured || join(homedir(), '.config', 'agentlink', 'notifications.json'));
  const workspace = resolve(cwd);
  if (pathIsWithin(workspace, path)) {
    throw new Error(`Notification trust config must be outside the repo workspace: ${path}`);
  }
  return path;
}

function validateAdapter(adapter: TrustedNotificationAdapter): TrustedNotificationAdapter {
  assertId(adapter.id, 'notification adapter id');
  if (!Array.isArray(adapter.argv) || adapter.argv.length === 0 || adapter.argv.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error(`Trusted notification adapter ${adapter.id} must have a non-empty string argv array`);
  }
  if (!isAbsolute(adapter.argv[0]!)) throw new Error(`Trusted notification adapter ${adapter.id} executable must be an absolute path`);
  assertTimeout(adapter.timeoutMs);
  return adapter;
}

async function readTrustedConfig(path: string): Promise<TrustedNotificationConfig> {
  await assertNotSymlink(path, 'Notification trust config');
  const content = await readUtf8IfExists(path);
  if (content === undefined) return { schemaVersion: 1, adapters: [] };
  let parsed: TrustedNotificationConfig;
  try {
    parsed = JSON.parse(content) as TrustedNotificationConfig;
  } catch {
    throw new Error(`Invalid JSON in notification trust config: ${path}`);
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.adapters)) throw new Error(`Invalid notification trust config: ${path}`);
  parsed.adapters.forEach(validateAdapter);
  return parsed;
}

export async function configureTrustedNotificationAdapter(
  cwd: string,
  adapter: TrustedNotificationAdapter,
  path = notificationTrustPath(cwd),
): Promise<string> {
  const target = resolve(path);
  if (pathIsWithin(resolve(cwd), target)) throw new Error(`Notification trust config must be outside the repo workspace: ${target}`);
  validateAdapter(adapter);
  await mkdir(dirname(target), { recursive: true });
  const config = await readTrustedConfig(target);
  const existing = config.adapters.findIndex((candidate) => candidate.id === adapter.id);
  if (existing === -1) config.adapters.push(adapter);
  else config.adapters[existing] = adapter;
  config.adapters.sort((left, right) => left.id.localeCompare(right.id));
  await atomicWriteFile(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
}

export async function listTrustedNotificationAdapters(cwd: string): Promise<Array<{ id: string; timeoutMs: number }>> {
  const config = await readTrustedConfig(notificationTrustPath(cwd));
  return config.adapters.map(({ id, timeoutMs }) => ({ id, timeoutMs }));
}

function notificationEventId(busId: string, messageId: string, registrationId: string): string {
  const digest = createHash('sha256').update(busId).update('\0').update(messageId).update('\0').update(registrationId).digest('hex');
  return `evt_${digest.slice(0, 32)}`;
}

function notificationEventPath(busPath: string, eventId: string): string {
  return join(busNotificationsPath(busPath), 'events', `${assertId(eventId, 'notification event id')}.json`);
}

async function readEvent(path: string): Promise<NotificationEvent | undefined> {
  const content = await readUtf8IfExists(path);
  if (content === undefined) return undefined;
  const event = JSON.parse(content) as NotificationEvent;
  if (event.schemaVersion !== 1 || !Array.isArray(event.attempts)) throw new Error(`Invalid notification event: ${path}`);
  return event;
}

async function runAdapter(adapter: TrustedNotificationAdapter, refs: NotificationReferences): Promise<{ ok: boolean; detail: string }> {
  const args = [
    ...adapter.argv.slice(1),
    '--event-id', refs.eventId,
    '--bus-id', refs.busId,
    '--conversation-id', refs.conversationId,
    '--message-id', refs.messageId,
    '--registration-id', refs.registrationId,
  ];
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const child = spawn(adapter.argv[0]!, args, {
      detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolveResult({ ok, detail });
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      forceTimer = setTimeout(() => {
        terminate('SIGKILL');
        finish(false, `timed out after ${adapter.timeoutMs}ms; receiver process group terminated`);
      }, 100);
    }, adapter.timeoutMs);
    child.once('error', (error) => {
      if (timedOut) return;
      finish(false, `failed to start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (timedOut) return;
      finish(
        code === 0,
        code === 0
          ? 'receiver exited successfully'
          : `receiver exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`,
      );
    });
  });
}

async function attemptEvent(cwd: string, event: NotificationEvent): Promise<NotificationEvent> {
  const context = await initializeWorkspaceIdentity(cwd);
  const path = notificationEventPath(context.association.busPath, event.eventId);
  return withFileLock(busLocksPath(context.association.busPath), `notification-${event.eventId}`, async () => {
    const current = await readEvent(path) ?? event;
    if (current.state === 'delivered') return current;
    const trusted = await readTrustedConfig(notificationTrustPath(cwd));
    const adapter = trusted.adapters.find((candidate) => candidate.id === current.adapterId);
    const outcome = adapter
      ? await runAdapter(adapter, {
        eventId: current.eventId,
        busId: current.busId,
        conversationId: current.conversationId,
        messageId: current.messageId,
        registrationId: current.recipientRegistrationId,
      })
      : { ok: false, detail: `adapter ${current.adapterId} is not trusted in user config` };
    current.attempts.push({ attemptedAt: new Date().toISOString(), outcome: outcome.ok ? 'delivered' : 'failed', detail: outcome.detail });
    current.state = outcome.ok ? 'delivered' : 'failed';
    await atomicWriteFile(path, `${JSON.stringify(current, null, 2)}\n`);
    return current;
  });
}

export async function notifyMessage(
  cwd: string,
  conversationId: string,
  messageId: string,
  senderParticipantId: string,
): Promise<NotificationDispatchResult> {
  const context = await initializeWorkspaceIdentity(cwd);
  const conversation = await readConversation(cwd, conversationId);
  const message = conversation.messages.find((candidate) => candidate.messageId === messageId);
  if (!message) throw new Error(`Message ${messageId} was not found in conversation ${conversationId}`);
  if (message.participantId !== senderParticipantId) throw new Error(`Message ${messageId} sender provenance does not match ${senderParticipantId}`);
  if (message.kind === 'status') {
    return { attempted: false, delivered: 0, failed: 0, skipped: 1, events: [], warnings: ['Status-only lifecycle messages do not trigger notification adapters.'] };
  }
  const eligible = new Set(conversation.participantIds);
  const recipients = (await listAgentRegistrations(cwd)).filter((registration) => (
    registration.participantId !== senderParticipantId
    && eligible.has(registration.participantId)
    && (!message.recipientParticipantId || registration.participantId === message.recipientParticipantId)
    && registration.notificationAdapterId
  ));
  const events: NotificationEvent[] = [];
  const warnings: string[] = [];
  for (const registration of recipients) {
    const eventId = notificationEventId(context.bus.busId, messageId, registration.registrationId);
    const path = notificationEventPath(context.association.busPath, eventId);
    const existing = await readEvent(path);
    const event: NotificationEvent = existing ?? {
      schemaVersion: 1,
      eventId,
      busId: context.bus.busId,
      conversationId,
      messageId,
      recipientRegistrationId: registration.registrationId,
      recipientParticipantId: registration.participantId,
      adapterId: registration.notificationAdapterId!,
      createdAt: new Date().toISOString(),
      state: 'pending',
      attempts: [],
    };
    if (!existing) await atomicWriteFile(path, `${JSON.stringify(event, null, 2)}\n`);
    const attempted = await attemptEvent(cwd, event);
    events.push(attempted);
    if (attempted.state === 'failed') warnings.push(`Notification ${eventId} failed: ${attempted.attempts.at(-1)?.detail ?? 'unknown failure'}. Retry explicitly.`);
  }
  if (recipients.length === 0) warnings.push('No active eligible agent registration has a notification adapter; message remains persisted.');
  return {
    attempted: recipients.length > 0,
    delivered: events.filter((event) => event.state === 'delivered').length,
    failed: events.filter((event) => event.state === 'failed').length,
    skipped: recipients.length === 0 ? 1 : 0,
    events,
    warnings,
  };
}

export async function retryNotification(cwd: string, eventId: string): Promise<NotificationEvent> {
  const context = await initializeWorkspaceIdentity(cwd);
  const path = notificationEventPath(context.association.busPath, eventId);
  const event = await readEvent(path);
  if (!event) throw new Error(`Notification event not found: ${eventId}`);
  return attemptEvent(cwd, event);
}

export async function receiveNotification(inboxPath: string, refs: NotificationReferences): Promise<'received' | 'duplicate'> {
  Object.entries(refs).forEach(([key, value]) => assertId(value, key));
  const path = resolve(inboxPath);
  await assertNotSymlink(path, 'Notification receiver inbox');
  const lockDirectory = join(dirname(path), '.agentlink-receiver-locks');
  return withFileLock(lockDirectory, `receiver-${refs.eventId}`, async () => {
    const content = await readUtf8IfExists(path) ?? '';
    const entries = content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as NotificationReferences);
    if (entries.some((entry) => entry.eventId === refs.eventId)) return 'duplicate';
    await atomicWriteFile(path, `${content}${JSON.stringify({ ...refs, receivedAt: new Date().toISOString() })}\n`);
    return 'received';
  });
}

export async function readNotificationEvent(cwd: string, eventId: string): Promise<NotificationEvent> {
  const context = await initializeWorkspaceIdentity(cwd);
  const event = await readEvent(notificationEventPath(context.association.busPath, eventId));
  if (!event) throw new Error(`Notification event not found: ${eventId}`);
  return event;
}
