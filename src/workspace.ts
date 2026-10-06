import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicWriteFile, assertNotSymlink, readUtf8IfExists, withFileLock } from './atomic.js';
import { computeContractContentDigest } from './contract-content.js';
import { journaledWriteFiles, recoverWriteTransactions, transactionPermittedRoots } from './transactions.js';

export const WORKSPACE_SCHEMA_VERSION = 1;
export const BUS_SCHEMA_VERSION = 1;

export interface WorkspaceIdentity {
  schemaVersion: 1;
  workspaceId: string;
  displayName: string;
  canonicalPath: string;
  createdAt: string;
}

export interface WorkspaceAssociation {
  schemaVersion: 1;
  busId: string;
  busPath: string;
  authorityWorkspaceId: string;
  associatedAt: string;
}

export interface RegisteredWorkspace {
  workspaceId: string;
  displayName: string;
  canonicalPath: string;
  registeredAt: string;
}

export interface BusManifest {
  schemaVersion: 1;
  busId: string;
  authorityWorkspaceId: string;
  createdAt: string;
  workspaces: RegisteredWorkspace[];
}

export interface ParticipantIdentity {
  participantId: string;
  workspaceId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

interface ParticipantRegistry {
  schemaVersion: 1;
  participants: ParticipantIdentity[];
}

export interface AgentRegistration {
  registrationId: string;
  participantId: string;
  workspaceId: string;
  label: string;
  clientKind: string;
  notificationAdapterId?: string;
  createdAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
}

interface AgentRegistrationRegistry {
  schemaVersion: 1;
  registrations: AgentRegistration[];
}

export interface RegisterAgentInput {
  label: string;
  clientKind?: string;
  notificationAdapterId?: string;
  registrationId?: string;
  ttlSeconds?: number;
}

export interface RegistrationClockOptions {
  now?: Date;
}

interface ActorSelection {
  schemaVersion: 1;
  participantId: string;
}

export interface ConversationSelection {
  schemaVersion: 1;
  busId: string;
  conversationId: string;
  compatibilityDigest?: string;
}

interface LegacyMigrationLedger {
  schemaVersion: 1;
  conversations: Record<string, { sha256: string; importedAt: string }>;
  contract?: { conversationId: string; sha256: string; importedAt: string };
}

export interface WorkspaceContext {
  rootPath: string;
  statePath: string;
  identity: WorkspaceIdentity;
  association: WorkspaceAssociation;
  bus: BusManifest;
}

export interface RegisterParticipantInput {
  displayName: string;
  participantId?: string;
  select?: boolean;
}

export interface AssociateWorkspaceOptions {
  conversationId?: string;
}

function assertId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return trimmed;
}

async function canonicalRoot(cwd: string): Promise<string> {
  return realpath(resolve(cwd));
}

async function withWorkspaceAssociationLock<T>(cwd: string, operation: (root: string) => Promise<T>): Promise<T> {
  const root = await canonicalRoot(cwd);
  const localStatePath = statePath(root);
  await mkdir(localStatePath, { recursive: true });
  await assertNotSymlink(localStatePath, 'AgentLink workspace directory');
  return withFileLock(join(localStatePath, 'locks'), 'workspace-association', () => operation(root), {
    timeoutMs: 10_000,
    staleMs: 30_000,
    retryMs: 10,
  });
}

function statePath(root: string): string {
  return join(root, '.agentlink');
}

function workspaceFile(root: string): string {
  return join(statePath(root), 'workspace.json');
}

function associationFile(root: string): string {
  return join(statePath(root), 'association.json');
}

function actorFile(root: string): string {
  return join(statePath(root), 'actor.json');
}

function selectedFile(root: string): string {
  return join(statePath(root), 'selected.json');
}

function migrationLedgerFile(root: string): string {
  return join(statePath(root), 'migration-v1.json');
}

function busManifestFile(busPath: string): string {
  return join(busPath, 'bus.json');
}

function participantRegistryFile(busPath: string): string {
  return join(busPath, 'participants.json');
}

function agentRegistryFile(busPath: string): string {
  return join(busPath, 'registrations.json');
}

export function busConversationsPath(busPath: string): string {
  return join(busPath, 'conversations');
}

export function busContractsPath(busPath: string): string {
  return join(busPath, 'contracts');
}

export function busAcknowledgementsPath(busPath: string): string {
  return join(busPath, 'acknowledgements');
}

export function busLocksPath(busPath: string): string {
  return join(busPath, 'locks');
}

export function busNotificationsPath(busPath: string): string {
  return join(busPath, 'notifications');
}

export function busTransactionsPath(busPath: string): string {
  return join(busPath, 'transactions');
}

async function parseJson<T>(path: string, label: string): Promise<T> {
  await assertNotSymlink(path, label);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${label}: ${path}`);
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function ensureBusDirectories(busPath: string): Promise<void> {
  if (!isAbsolute(busPath)) throw new Error(`Bus path must be absolute: ${busPath}`);
  await mkdir(busConversationsPath(busPath), { recursive: true });
  await mkdir(busContractsPath(busPath), { recursive: true });
  await mkdir(busAcknowledgementsPath(busPath), { recursive: true });
  await mkdir(busLocksPath(busPath), { recursive: true });
  await mkdir(busNotificationsPath(busPath), { recursive: true });
  await mkdir(busTransactionsPath(busPath), { recursive: true });
  await assertNotSymlink(busPath, 'Bus directory');
  await assertNotSymlink(busConversationsPath(busPath), 'Bus conversations directory');
  await assertNotSymlink(busContractsPath(busPath), 'Bus contracts directory');
  await assertNotSymlink(busAcknowledgementsPath(busPath), 'Bus acknowledgements directory');
  await assertNotSymlink(busLocksPath(busPath), 'Bus locks directory');
  await assertNotSymlink(busNotificationsPath(busPath), 'Bus notifications directory');
  await assertNotSymlink(busTransactionsPath(busPath), 'Bus transactions directory');
}

async function createLocalBus(root: string, identity: WorkspaceIdentity, customPath?: string): Promise<WorkspaceAssociation> {
  const busPath = customPath ?? join(statePath(root), 'bus');
  await ensureBusDirectories(busPath);
  const now = new Date().toISOString();
  const manifest: BusManifest = {
    schemaVersion: BUS_SCHEMA_VERSION,
    busId: randomUUID(),
    authorityWorkspaceId: identity.workspaceId,
    createdAt: now,
    workspaces: [{
      workspaceId: identity.workspaceId,
      displayName: identity.displayName,
      canonicalPath: identity.canonicalPath,
      registeredAt: now,
    }],
  };
  await writeJson(busManifestFile(busPath), manifest);
  await writeJson(participantRegistryFile(busPath), { schemaVersion: 1, participants: [] } satisfies ParticipantRegistry);
  await writeJson(agentRegistryFile(busPath), { schemaVersion: 1, registrations: [] } satisfies AgentRegistrationRegistry);
  const association: WorkspaceAssociation = {
    schemaVersion: 1,
    busId: manifest.busId,
    busPath,
    authorityWorkspaceId: identity.workspaceId,
    associatedAt: now,
  };
  await writeJson(associationFile(root), association);
  return association;
}

async function validateIdentity(root: string, identity: WorkspaceIdentity): Promise<void> {
  if (identity.schemaVersion !== WORKSPACE_SCHEMA_VERSION) throw new Error(`Unsupported workspace schema version: ${identity.schemaVersion}`);
  assertId(identity.workspaceId, 'workspace id');
  if (identity.canonicalPath !== root) {
    throw new Error(`AgentLink workspace identity belongs to ${identity.canonicalPath}, not ${root}. This may be a copied checkout; run \`agentlink init --new-workspace\` here.`);
  }
}

async function readAssociation(root: string): Promise<WorkspaceAssociation> {
  const association = await parseJson<WorkspaceAssociation>(associationFile(root), 'Workspace association');
  if (association.schemaVersion !== 1 || !isAbsolute(association.busPath)) throw new Error(`Invalid workspace association: ${associationFile(root)}`);
  assertId(association.busId, 'bus id');
  return association;
}

async function readAndValidateBus(association: WorkspaceAssociation): Promise<BusManifest> {
  await ensureBusDirectories(association.busPath);
  const bus = await parseJson<BusManifest>(busManifestFile(association.busPath), 'Bus manifest');
  if (bus.schemaVersion !== BUS_SCHEMA_VERSION) throw new Error(`Unsupported bus schema version: ${bus.schemaVersion}`);
  if (bus.busId !== association.busId || bus.authorityWorkspaceId !== association.authorityWorkspaceId) {
    throw new Error(`Workspace association does not match bus manifest at ${association.busPath}`);
  }
  if (await readUtf8IfExists(agentRegistryFile(association.busPath)) === undefined) {
    await writeJson(agentRegistryFile(association.busPath), { schemaVersion: 1, registrations: [] } satisfies AgentRegistrationRegistry);
  }
  return bus;
}

async function registerWorkspaceOnBus(context: WorkspaceContext): Promise<BusManifest> {
  return withFileLock(busLocksPath(context.association.busPath), 'bus-manifest', async () => {
    const manifest = await parseJson<BusManifest>(busManifestFile(context.association.busPath), 'Bus manifest');
    const existing = manifest.workspaces.find((entry) => entry.workspaceId === context.identity.workspaceId);
    if (existing && existing.canonicalPath !== context.rootPath) {
      throw new Error(`Workspace id ${context.identity.workspaceId} is already registered for ${existing.canonicalPath}; refusing to conflate cloned peers`);
    }
    if (!existing) {
      manifest.workspaces.push({
        workspaceId: context.identity.workspaceId,
        displayName: context.identity.displayName,
        canonicalPath: context.rootPath,
        registeredAt: new Date().toISOString(),
      });
      await writeJson(busManifestFile(context.association.busPath), manifest);
    }
    return manifest;
  });
}

async function migrateLegacy(root: string, context: WorkspaceContext): Promise<void> {
  if (context.association.authorityWorkspaceId !== context.identity.workspaceId) return;
  await withFileLock(busLocksPath(context.association.busPath), 'legacy-migration', async () => {
    const ledgerPath = migrationLedgerFile(root);
    const ledgerContent = await readUtf8IfExists(ledgerPath);
    const ledger: LegacyMigrationLedger = ledgerContent === undefined
      ? { schemaVersion: 1, conversations: {} }
      : JSON.parse(ledgerContent) as LegacyMigrationLedger;
    if (ledger.schemaVersion !== 1 || typeof ledger.conversations !== 'object' || ledger.conversations === null) {
      throw new Error(`Invalid legacy migration ledger: ${ledgerPath}`);
    }
    const persistLedger = (): Promise<void> => writeJson(ledgerPath, ledger);
    const digest = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

    const legacyConversations = join(statePath(root), 'conversations');
    try {
      await assertNotSymlink(legacyConversations, 'Legacy conversations directory');
      const entries = await readdir(legacyConversations, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const id = assertId(entry.name.slice(0, -'.jsonl'.length), 'conversation id');
        const source = join(legacyConversations, entry.name);
        const sourceContent = await readFile(source, 'utf8');
        const sourceDigest = digest(sourceContent);
        const completed = ledger.conversations[id];
        if (completed) {
          if (completed.sha256 !== sourceDigest) {
            throw new Error(`Legacy conversation ${id} changed after migration; reconcile the preserved legacy log explicitly`);
          }
          continue;
        }
        const destination = join(busConversationsPath(context.association.busPath), `${id}.jsonl`);
        const destinationContent = await readUtf8IfExists(destination);
        if (destinationContent === undefined) await atomicWriteFile(destination, sourceContent);
        else if (destinationContent !== sourceContent) throw new Error(`Legacy conversation ${id} conflicts with authoritative bus data`);
        ledger.conversations[id] = { sha256: sourceDigest, importedAt: new Date().toISOString() };
        await persistLedger();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (ledger.contract) return;
    const compatibilityPath = join(statePath(root), 'CONTRACT.md');
    const content = await readUtf8IfExists(compatibilityPath);
    if (!content || content.match(/<!--\s*agentlink-bus:\s*([a-zA-Z0-9_-]+)\s*-->/)?.[1] === context.bus.busId) return;
    const conversationId = content.match(/<!--\s*agentlink-conversation:\s*([a-zA-Z0-9_-]+)\s*-->/)?.[1];
    if (!conversationId) {
      const preserved = join(statePath(root), 'legacy', 'CONTRACT.unassigned.md');
      const existing = await readUtf8IfExists(preserved);
      if (existing === undefined) await atomicWriteFile(preserved, content);
      else if (existing !== content) throw new Error(`Unassigned legacy contract conflicts with preserved copy: ${preserved}`);
      return;
    }
    const logPath = join(busConversationsPath(context.association.busPath), `${conversationId}.jsonl`);
    try {
      await stat(logPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const destination = join(busContractsPath(context.association.busPath), conversationId, 'CONTRACT.md');
    const existing = await readUtf8IfExists(destination);
    if (existing === undefined) await atomicWriteFile(destination, content);
    else if (existing !== content) throw new Error(`Legacy contract ${conversationId} conflicts with authoritative bus data`);
    ledger.contract = { conversationId, sha256: digest(content), importedAt: new Date().toISOString() };
    await persistLedger();
    const selection: ConversationSelection = {
      schemaVersion: 1,
      busId: context.bus.busId,
      conversationId,
      compatibilityDigest: computeContractContentDigest(content),
    };
    const selected = await readUtf8IfExists(selectedFile(root));
    if (selected === undefined) await writeJson(selectedFile(root), selection);
  });
}

async function ensureDefaultParticipant(context: WorkspaceContext): Promise<void> {
  const actorPath = actorFile(context.rootPath);
  if (await readUtf8IfExists(actorPath) !== undefined) return;
  await withFileLock(busLocksPath(context.association.busPath), 'participants', async () => {
    const registry = await parseJson<ParticipantRegistry>(participantRegistryFile(context.association.busPath), 'Participant registry');
    const now = new Date().toISOString();
    const participant: ParticipantIdentity = {
      participantId: randomUUID(),
      workspaceId: context.identity.workspaceId,
      displayName: context.identity.displayName,
      createdAt: now,
      updatedAt: now,
    };
    registry.participants.push(participant);
    await writeJson(participantRegistryFile(context.association.busPath), registry);
    await writeJson(actorPath, { schemaVersion: 1, participantId: participant.participantId } satisfies ActorSelection);
  });
}

export async function initializeWorkspaceIdentity(cwd = process.cwd()): Promise<WorkspaceContext> {
  const root = await canonicalRoot(cwd);
  const localStatePath = statePath(root);
  await mkdir(localStatePath, { recursive: true });
  await assertNotSymlink(localStatePath, 'AgentLink workspace directory');
  return withFileLock(join(localStatePath, 'locks'), 'workspace-initialize', async () => {
    const identityPath = workspaceFile(root);
    let identity: WorkspaceIdentity;
    const existingIdentity = await readUtf8IfExists(identityPath);
    if (existingIdentity === undefined) {
      const now = new Date().toISOString();
      identity = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        workspaceId: randomUUID(),
        displayName: basename(root) || 'workspace',
        canonicalPath: root,
        createdAt: now,
      };
      await writeJson(identityPath, identity);
    } else {
      identity = JSON.parse(existingIdentity) as WorkspaceIdentity;
      await validateIdentity(root, identity);
    }

    let association: WorkspaceAssociation;
    try {
      association = await readAssociation(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      association = await createLocalBus(root, identity);
    }
    let bus = await readAndValidateBus(association);
    let context: WorkspaceContext = { rootPath: root, statePath: localStatePath, identity, association, bus };
    bus = await registerWorkspaceOnBus(context);
    context = { ...context, bus };
    await recoverWriteTransactions(
      association.busPath,
      transactionPermittedRoots(association.busPath, bus.workspaces.map((workspace) => workspace.canonicalPath)),
    );
    await migrateLegacy(root, context);
    await ensureDefaultParticipant(context);
    return context;
  }, { timeoutMs: 10_000, staleMs: 30_000, retryMs: 10 });
}

export async function readWorkspaceIdentity(cwd = process.cwd()): Promise<WorkspaceIdentity> {
  const root = await canonicalRoot(cwd);
  const identity = await parseJson<WorkspaceIdentity>(workspaceFile(root), 'Workspace identity');
  await validateIdentity(root, identity);
  return identity;
}

export async function rotateWorkspaceIdentity(cwd = process.cwd()): Promise<WorkspaceIdentity> {
  const root = await canonicalRoot(cwd);
  const now = new Date().toISOString();
  const identity: WorkspaceIdentity = {
    schemaVersion: 1,
    workspaceId: randomUUID(),
    displayName: basename(root) || 'workspace',
    canonicalPath: root,
    createdAt: now,
  };
  await mkdir(statePath(root), { recursive: true });
  await writeJson(workspaceFile(root), identity);
  await rmIfExists(actorFile(root));
  await rmIfExists(selectedFile(root));
  await createLocalBus(root, identity, join(statePath(root), `bus-${identity.workspaceId}`));
  await initializeWorkspaceIdentity(root);
  return identity;
}

async function rmIfExists(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path, { force: true });
}

export async function registerParticipant(cwd: string, input: RegisterParticipantInput): Promise<ParticipantIdentity> {
  return withWorkspaceAssociationLock(cwd, async (root) => {
    const context = await initializeWorkspaceIdentity(root);
    return withFileLock(busLocksPath(context.association.busPath), 'participants', async () => {
      const registry = await parseJson<ParticipantRegistry>(participantRegistryFile(context.association.busPath), 'Participant registry');
      const participantId = assertId(input.participantId ?? randomUUID(), 'participant id');
      if (registry.participants.some((participant) => participant.participantId === participantId)) {
        throw new Error(`Participant already exists: ${participantId}`);
      }
      const now = new Date().toISOString();
      const participant: ParticipantIdentity = {
        participantId,
        workspaceId: context.identity.workspaceId,
        displayName: nonEmpty(input.displayName, 'Participant display name'),
        createdAt: now,
        updatedAt: now,
      };
      registry.participants.push(participant);
      await writeJson(participantRegistryFile(context.association.busPath), registry);
      if (input.select !== false) {
        await writeJson(actorFile(context.rootPath), { schemaVersion: 1, participantId } satisfies ActorSelection);
      }
      return participant;
    });
  });
}

export async function listParticipants(cwd = process.cwd()): Promise<ParticipantIdentity[]> {
  const context = await initializeWorkspaceIdentity(cwd);
  const registry = await parseJson<ParticipantRegistry>(participantRegistryFile(context.association.busPath), 'Participant registry');
  return registry.participants.filter((participant) => participant.workspaceId === context.identity.workspaceId);
}

export async function selectParticipant(cwd: string, participantId: string): Promise<ParticipantIdentity> {
  const context = await initializeWorkspaceIdentity(cwd);
  const registry = await parseJson<ParticipantRegistry>(participantRegistryFile(context.association.busPath), 'Participant registry');
  const participant = registry.participants.find((candidate) => candidate.participantId === assertId(participantId, 'participant id'));
  if (!participant || participant.workspaceId !== context.identity.workspaceId) {
    throw new Error(`Participant ${participantId} is not registered for workspace ${context.identity.workspaceId}`);
  }
  await writeJson(actorFile(context.rootPath), { schemaVersion: 1, participantId } satisfies ActorSelection);
  return participant;
}

export async function resolveActiveParticipant(cwd = process.cwd()): Promise<ParticipantIdentity> {
  const context = await initializeWorkspaceIdentity(cwd);
  const configuredId = process.env.AGENTLINK_PARTICIPANT_ID?.trim();
  const selection = configuredId
    ? { schemaVersion: 1, participantId: assertId(configuredId, 'participant id') } satisfies ActorSelection
    : await parseJson<ActorSelection>(actorFile(context.rootPath), 'Actor selection');
  const registry = await parseJson<ParticipantRegistry>(participantRegistryFile(context.association.busPath), 'Participant registry');
  const participant = registry.participants.find((candidate) => candidate.participantId === selection.participantId);
  if (!participant || participant.workspaceId !== context.identity.workspaceId) {
    throw new Error(`Active participant ${selection.participantId} is not registered for workspace ${context.identity.workspaceId}. Run \`agentlink actor use --id <id>\`.`);
  }
  return participant;
}

export async function relabelParticipant(cwd: string, participantId: string, displayName: string): Promise<ParticipantIdentity> {
  return withWorkspaceAssociationLock(cwd, async (root) => {
    const context = await initializeWorkspaceIdentity(root);
    return withFileLock(busLocksPath(context.association.busPath), 'participants', async () => {
      const registry = await parseJson<ParticipantRegistry>(participantRegistryFile(context.association.busPath), 'Participant registry');
      const participant = registry.participants.find((candidate) => candidate.participantId === assertId(participantId, 'participant id'));
      if (!participant || participant.workspaceId !== context.identity.workspaceId) throw new Error(`Participant not found in this workspace: ${participantId}`);
      participant.displayName = nonEmpty(displayName, 'Participant display name');
      participant.updatedAt = new Date().toISOString();
      await writeJson(participantRegistryFile(context.association.busPath), registry);
      return participant;
    });
  });
}

async function busHasConversationData(busPath: string): Promise<boolean> {
  const entries = await readdir(busConversationsPath(busPath));
  return entries.some((entry) => entry.endsWith('.jsonl'));
}

export async function associateWorkspace(sourceCwd: string, targetCwd: string, options: AssociateWorkspaceOptions = {}): Promise<WorkspaceAssociation> {
  const source = await initializeWorkspaceIdentity(sourceCwd);
  return withWorkspaceAssociationLock(targetCwd, async (targetRoot) => {
    const target = await initializeWorkspaceIdentity(targetRoot);
    if (source.bus.busId === target.bus.busId) {
      if (options.conversationId) await selectConversation(target.rootPath, options.conversationId, true);
      return target.association;
    }
    if (await busHasConversationData(target.association.busPath)) {
      throw new Error(`Target workspace is already associated with bus ${target.bus.busId} containing conversations; refusing to fork or discard authority`);
    }

    const targetRegistry = await withFileLock(busLocksPath(target.association.busPath), 'participants', () => (
      parseJson<ParticipantRegistry>(participantRegistryFile(target.association.busPath), 'Participant registry')
    ));
    await withFileLock(busLocksPath(source.association.busPath), 'bus-manifest', async () => {
      const manifest = await parseJson<BusManifest>(busManifestFile(source.association.busPath), 'Bus manifest');
      const collision = manifest.workspaces.find((workspace) => workspace.workspaceId === target.identity.workspaceId);
      if (collision && collision.canonicalPath !== target.rootPath) throw new Error(`Workspace id ${target.identity.workspaceId} is already registered for ${collision.canonicalPath}`);
      if (!collision) manifest.workspaces.push({
        workspaceId: target.identity.workspaceId,
        displayName: target.identity.displayName,
        canonicalPath: target.rootPath,
        registeredAt: new Date().toISOString(),
      });
      await writeJson(busManifestFile(source.association.busPath), manifest);
    });
    await withFileLock(busLocksPath(source.association.busPath), 'participants', async () => {
      const registry = await parseJson<ParticipantRegistry>(participantRegistryFile(source.association.busPath), 'Participant registry');
      for (const participant of targetRegistry.participants.filter((candidate) => candidate.workspaceId === target.identity.workspaceId)) {
        const existing = registry.participants.find((candidate) => candidate.participantId === participant.participantId);
        if (existing && existing.workspaceId !== participant.workspaceId) throw new Error(`Participant id collision while associating ${participant.participantId}`);
        if (!existing) registry.participants.push(participant);
      }
      await writeJson(participantRegistryFile(source.association.busPath), registry);
    });

    const association: WorkspaceAssociation = {
      schemaVersion: 1,
      busId: source.bus.busId,
      busPath: source.association.busPath,
      authorityWorkspaceId: source.bus.authorityWorkspaceId,
      associatedAt: new Date().toISOString(),
    };
    await writeJson(associationFile(target.rootPath), association);
    if (options.conversationId) await selectConversation(target.rootPath, options.conversationId, true);
    return association;
  });
}

export async function selectConversation(cwd: string, conversationId: string, refreshCompatibility = false): Promise<void> {
  const context = await initializeWorkspaceIdentity(cwd);
  const id = assertId(conversationId, 'conversation id');
  const authoritative = join(busContractsPath(context.association.busPath), id, 'CONTRACT.md');
  const content = refreshCompatibility ? await readUtf8IfExists(authoritative) : undefined;
  const selection: ConversationSelection = {
    schemaVersion: 1,
    busId: context.bus.busId,
    conversationId: id,
    ...(content !== undefined ? { compatibilityDigest: computeContractContentDigest(content) } : {}),
  };
  if (content === undefined) {
    await writeJson(selectedFile(context.rootPath), selection);
    return;
  }
  await journaledWriteFiles(context.association.busPath, `compatibility-${id}`, [
    { path: selectedFile(context.rootPath), content: `${JSON.stringify(selection, null, 2)}\n` },
    { path: join(context.statePath, 'CONTRACT.md'), content },
  ], transactionPermittedRoots(
    context.association.busPath,
    context.bus.workspaces.map((workspace) => workspace.canonicalPath),
  ));
}

export async function readConversationSelection(cwd = process.cwd()): Promise<ConversationSelection | undefined> {
  const context = await initializeWorkspaceIdentity(cwd);
  const content = await readUtf8IfExists(selectedFile(context.rootPath));
  if (content === undefined) return undefined;
  const selection = JSON.parse(content) as ConversationSelection;
  if (selection.busId !== context.bus.busId) throw new Error(`Selected conversation belongs to bus ${selection.busId}, not ${context.bus.busId}`);
  assertId(selection.conversationId, 'conversation id');
  if (selection.compatibilityDigest !== undefined && !/^[a-f0-9]{64}$/.test(selection.compatibilityDigest)) {
    throw new Error(`Invalid selected compatibility digest: ${selection.compatibilityDigest}`);
  }
  return selection;
}

export async function readSelectedConversation(cwd = process.cwd()): Promise<string | undefined> {
  return (await readConversationSelection(cwd))?.conversationId;
}

export async function refreshCompatibilityContract(cwd: string, conversationId: string, content: string): Promise<void> {
  const context = await initializeWorkspaceIdentity(cwd);
  const selected = await readConversationSelection(context.rootPath);
  if (selected?.conversationId === conversationId) {
    const nextSelection = {
      ...selected,
      compatibilityDigest: computeContractContentDigest(content),
    } satisfies ConversationSelection;
    await journaledWriteFiles(context.association.busPath, `compatibility-${conversationId}`, [
      { path: selectedFile(context.rootPath), content: `${JSON.stringify(nextSelection, null, 2)}\n` },
      { path: join(context.statePath, 'CONTRACT.md'), content },
    ], transactionPermittedRoots(
      context.association.busPath,
      context.bus.workspaces.map((workspace) => workspace.canonicalPath),
    ));
  }
}

function registrationTtl(value: number | undefined): number {
  const ttl = value ?? 300;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86_400) {
    throw new Error('Registration TTL must be an integer from 1 to 86400 seconds');
  }
  return ttl;
}

function registrationTime(options: RegistrationClockOptions): Date {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid registration clock');
  return now;
}

function validateRegistration(registration: AgentRegistration): AgentRegistration {
  assertId(registration.registrationId, 'registration id');
  assertId(registration.participantId, 'participant id');
  assertId(registration.workspaceId, 'workspace id');
  nonEmpty(registration.label, 'Registration label');
  nonEmpty(registration.clientKind, 'Client kind');
  if (registration.notificationAdapterId) assertId(registration.notificationAdapterId, 'notification adapter id');
  if (![registration.createdAt, registration.lastHeartbeatAt, registration.expiresAt].every((value) => Number.isFinite(Date.parse(value)))) {
    throw new Error(`Invalid timestamps in agent registration ${registration.registrationId}`);
  }
  return registration;
}

async function readAgentRegistry(busPath: string): Promise<AgentRegistrationRegistry> {
  const registry = await parseJson<AgentRegistrationRegistry>(agentRegistryFile(busPath), 'Agent registration registry');
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.registrations)) {
    throw new Error(`Invalid agent registration registry: ${agentRegistryFile(busPath)}`);
  }
  registry.registrations.forEach(validateRegistration);
  return registry;
}

export async function registerAgentForParticipant(
  cwd: string,
  input: RegisterAgentInput,
  participantId: string,
  options: RegistrationClockOptions = {},
): Promise<AgentRegistration> {
  const context = await initializeWorkspaceIdentity(cwd);
  const ownerId = assertId(participantId, 'participant id');
  const participants = await parseJson<ParticipantRegistry>(participantRegistryFile(context.association.busPath), 'Participant registry');
  const actor = participants.participants.find((candidate) => candidate.participantId === ownerId && candidate.workspaceId === context.identity.workspaceId);
  if (!actor) throw new Error(`Participant ${ownerId} is not registered for workspace ${context.identity.workspaceId}`);
  const now = registrationTime(options);
  const ttlSeconds = registrationTtl(input.ttlSeconds);
  const registrationId = assertId(input.registrationId ?? `reg_${randomUUID()}`, 'registration id');
  const label = nonEmpty(input.label, 'Registration label');
  const clientKind = nonEmpty(input.clientKind ?? 'mcp', 'Client kind');
  const notificationAdapterId = input.notificationAdapterId
    ? assertId(input.notificationAdapterId, 'notification adapter id')
    : undefined;
  return withFileLock(busLocksPath(context.association.busPath), 'agent-registrations', async () => {
    const registry = await readAgentRegistry(context.association.busPath);
    const existing = registry.registrations.find((candidate) => candidate.registrationId === registrationId);
    if (existing && (existing.participantId !== actor.participantId || existing.workspaceId !== actor.workspaceId)) {
      throw new Error(`Registration ${registrationId} belongs to another participant or workspace`);
    }
    const timestamp = now.toISOString();
    const registration: AgentRegistration = {
      registrationId,
      participantId: actor.participantId,
      workspaceId: actor.workspaceId,
      label,
      clientKind,
      ...(notificationAdapterId ? { notificationAdapterId } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      lastHeartbeatAt: timestamp,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    if (existing) registry.registrations[registry.registrations.indexOf(existing)] = registration;
    else registry.registrations.push(registration);
    await writeJson(agentRegistryFile(context.association.busPath), registry);
    return registration;
  });
}

export async function registerAgent(
  cwd: string,
  input: RegisterAgentInput,
  options: RegistrationClockOptions = {},
): Promise<AgentRegistration> {
  const actor = await resolveActiveParticipant(cwd);
  return registerAgentForParticipant(cwd, input, actor.participantId, options);
}

export async function heartbeatAgentForParticipant(
  cwd: string,
  registrationId: string,
  participantId: string,
  ttlSeconds?: number,
  options: RegistrationClockOptions = {},
): Promise<AgentRegistration> {
  const context = await initializeWorkspaceIdentity(cwd);
  const id = assertId(registrationId, 'registration id');
  const ownerId = assertId(participantId, 'participant id');
  const ttl = registrationTtl(ttlSeconds);
  const now = registrationTime(options);
  return withFileLock(busLocksPath(context.association.busPath), 'agent-registrations', async () => {
    const registry = await readAgentRegistry(context.association.busPath);
    const registration = registry.registrations.find((candidate) => candidate.registrationId === id);
    if (!registration) throw new Error(`Agent registration not found or expired: ${id}`);
    if (registration.participantId !== ownerId || registration.workspaceId !== context.identity.workspaceId) {
      throw new Error(`Registration ${id} is owned by participant ${registration.participantId}, not ${ownerId}`);
    }
    registration.lastHeartbeatAt = now.toISOString();
    registration.expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    await writeJson(agentRegistryFile(context.association.busPath), registry);
    return registration;
  });
}

export async function heartbeatAgent(
  cwd: string,
  registrationId: string,
  ttlSeconds?: number,
  options: RegistrationClockOptions = {},
): Promise<AgentRegistration> {
  const actor = await resolveActiveParticipant(cwd);
  return heartbeatAgentForParticipant(cwd, registrationId, actor.participantId, ttlSeconds, options);
}

export async function unregisterAgent(cwd: string, registrationId: string): Promise<void> {
  const context = await initializeWorkspaceIdentity(cwd);
  const actor = await resolveActiveParticipant(cwd);
  const id = assertId(registrationId, 'registration id');
  await withFileLock(busLocksPath(context.association.busPath), 'agent-registrations', async () => {
    const registry = await readAgentRegistry(context.association.busPath);
    const registration = registry.registrations.find((candidate) => candidate.registrationId === id);
    if (!registration) return;
    if (registration.participantId !== actor.participantId || registration.workspaceId !== actor.workspaceId) {
      throw new Error(`Registration ${id} is owned by participant ${registration.participantId}, not ${actor.participantId}`);
    }
    registry.registrations = registry.registrations.filter((candidate) => candidate.registrationId !== id);
    await writeJson(agentRegistryFile(context.association.busPath), registry);
  });
}

export async function listAgentRegistrations(
  cwd = process.cwd(),
  options: RegistrationClockOptions = {},
): Promise<AgentRegistration[]> {
  const context = await initializeWorkspaceIdentity(cwd);
  const now = registrationTime(options).getTime();
  return withFileLock(busLocksPath(context.association.busPath), 'agent-registrations', async () => {
    const registry = await readAgentRegistry(context.association.busPath);
    const active = registry.registrations.filter((registration) => Date.parse(registration.expiresAt) > now);
    if (active.length !== registry.registrations.length) {
      registry.registrations = active;
      await writeJson(agentRegistryFile(context.association.busPath), registry);
    }
    return active.sort((left, right) => left.registrationId.localeCompare(right.registrationId));
  });
}
