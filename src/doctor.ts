import { access, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readContractState } from './contract.js';
import { filterAgentPanes, listTmuxPanes, type TmuxPane } from './tmux.js';
import { AGENTLINK_DIRECTORY, CONVERSATIONS_DIRECTORY, listConversations } from './store.js';

export type DoctorCheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  status: DoctorCheckStatus;
  label: string;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  hasFailures: boolean;
}

export type TmuxPaneLister = () => Promise<TmuxPane[]>;

interface PackageManifest {
  name?: unknown;
  scripts?: unknown;
}

function check(status: DoctorCheckStatus, label: string, detail: string): DoctorCheck {
  return { status, label, detail };
}

function formatRelative(cwd: string, path: string): string {
  const local = relative(cwd, path);
  return local && !local.startsWith('..') ? local : path;
}

function parseNodeMajor(version: string): number | undefined {
  const match = version.match(/^v?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageManifest(cwd: string): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

export async function collectDoctorReport(
  cwd = process.cwd(),
  paneLister: TmuxPaneLister = listTmuxPanes,
  nodeVersion = process.version,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const nodeMajor = parseNodeMajor(nodeVersion);
  checks.push(
    nodeMajor !== undefined && nodeMajor >= 20
      ? check('ok', 'Node.js', `${nodeVersion} (>=20)`)
      : check('fail', 'Node.js', `${nodeVersion || 'unknown'}; AgentLink requires Node.js 20+`),
  );

  const manifest = await readPackageManifest(cwd);
  if (!manifest) {
    checks.push(check('fail', 'package.json', 'missing or unreadable'));
  } else {
    const name = typeof manifest.name === 'string' ? manifest.name : 'unnamed';
    checks.push(check('ok', 'package.json', name));
    const scripts = manifest.scripts && typeof manifest.scripts === 'object'
      ? Object.keys(manifest.scripts as Record<string, unknown>).sort()
      : [];
    const missingScripts = ['build', 'test', 'agentlink'].filter((script) => !scripts.includes(script));
    checks.push(
      missingScripts.length === 0
        ? check('ok', 'npm scripts', scripts.join(', '))
        : check('fail', 'npm scripts', `missing: ${missingScripts.join(', ')}`),
    );
  }

  const workspace = join(cwd, AGENTLINK_DIRECTORY);
  const conversations = join(workspace, CONVERSATIONS_DIRECTORY);
  checks.push(
    await pathExists(conversations)
      ? check('ok', 'workspace', formatRelative(cwd, workspace))
      : check('warn', 'workspace', 'not initialized; run `agentlink init`'),
  );

  const contract = await readContractState(cwd);
  checks.push(
    contract.status
      ? check('ok', 'contract', `${contract.status} at ${formatRelative(cwd, contract.path)}`)
      : check('warn', 'contract', `missing or unreadable at ${formatRelative(cwd, contract.path)}`),
  );

  try {
    const conversationsList = await listConversations(cwd);
    checks.push(check('ok', 'conversation store', `${conversationsList.length} conversation(s)`));
  } catch (error) {
    checks.push(check('warn', 'conversation store', error instanceof Error ? error.message : String(error)));
  }

  try {
    const panes = await paneLister();
    const agents = filterAgentPanes(panes);
    checks.push(
      agents.length > 0
        ? check('ok', 'tmux agents', `${agents.length} active coding-agent pane(s)`)
        : check('warn', 'tmux agents', 'no active coding-agent panes found'),
    );
  } catch (error) {
    checks.push(check('warn', 'tmux agents', error instanceof Error ? error.message : String(error)));
  }

  const mcpBuildPath = join(cwd, 'dist', 'mcp', 'server.js');
  checks.push(
    await pathExists(mcpBuildPath)
      ? check('ok', 'MCP build artifact', formatRelative(cwd, mcpBuildPath))
      : check('warn', 'MCP build artifact', 'missing; run `npm run build` before using agentlink-mcp'),
  );

  return {
    checks,
    hasFailures: checks.some((item) => item.status === 'fail'),
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = ['AgentLink Doctor', ''];
  for (const item of report.checks) {
    lines.push(`[${item.status}] ${item.label}: ${item.detail}`);
  }
  lines.push('', report.hasFailures ? 'Result: failures found.' : 'Result: ready with no hard failures.');
  return `${lines.join('\n')}\n`;
}
