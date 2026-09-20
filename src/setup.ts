import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETUP_HARNESSES = ['stdio', 'claude-code', 'codex', 'copilot', 'opencode', 'gemini'] as const;
export type SetupHarness = typeof SETUP_HARNESSES[number];

export interface SetupGuide {
  packageName: string;
  version?: string;
  workspacePath: string;
  mcpCommand: string;
  mcpArgs: string[];
  harnesses: SetupHarness[];
  agentPrompt: string;
}

async function readPackage(cwd: string): Promise<{ name?: string; version?: string }> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
    };
  } catch {
    return {};
  }
}

async function readAgentLinkPackage(): Promise<{ name: string; version?: string }> {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    try {
      const parsed = JSON.parse(await readFile(join(cursor, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === '@sruthik/agentlink') {
        return {
          name: '@sruthik/agentlink',
          ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
        };
      }
    } catch {
      // Keep walking toward the installed/source AgentLink package root.
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return { name: '@sruthik/agentlink' };
}

export function parseSetupHarness(value: string): SetupHarness {
  const normalized = value.trim().toLowerCase();
  const harness = SETUP_HARNESSES.find((candidate) => candidate === normalized);
  if (!harness) {
    throw new Error(`Invalid setup harness: ${value}. Expected one of: ${SETUP_HARNESSES.join(', ')}`);
  }
  return harness;
}

export async function collectSetupGuide(cwd = process.cwd(), harness: SetupHarness | 'all' = 'all'): Promise<SetupGuide> {
  await readPackage(cwd);
  const manifest = await readAgentLinkPackage();
  return {
    packageName: manifest.name,
    ...(manifest.version ? { version: manifest.version } : {}),
    workspacePath: cwd,
    mcpCommand: 'agentlink-mcp',
    mcpArgs: [],
    harnesses: harness === 'all' ? [...SETUP_HARNESSES] : [harness],
    agentPrompt: [
      'Use AgentLink for cross-repo coordination. Keep repo source isolated; exchange compact contract updates only.',
      'Before implementation, call/read the local AgentLink bus, update CONTRACT.md sections deterministically, and record approvals before accepting.',
      'Do not use tmux pane typing unless the AgentLink CLI delivery guardrail has read the target pane and verified the text is visible.',
    ].join(' '),
  };
}

function renderStdioSection(guide: SetupGuide): string[] {
  return [
    '### Generic stdio MCP client',
    '',
    'Use this server definition from any MCP-capable harness:',
    '',
    '```json',
    JSON.stringify({
      mcpServers: {
        agentlink: {
          command: guide.mcpCommand,
          args: guide.mcpArgs,
        },
      },
    }, null, 2),
    '```',
  ];
}

function renderClaudeSection(): string[] {
  return [
    '### Claude Code',
    '',
    'After installing AgentLink, add the MCP server to your agent app:',
    '',
    '```bash',
    'claude mcp add -s user agentlink -- agentlink-mcp',
    '```',
  ];
}

function renderCodexSection(): string[] {
  return [
    '### Codex CLI',
    '',
    'Add AgentLink once, then use Codex normally. The agent sees AgentLink tools inside its MCP tool catalog:',
    '',
    '```bash',
    'codex mcp add agentlink -- agentlink-mcp',
    'codex',
    '```',
  ];
}

function renderOpenCodeSection(): string[] {
  return [
    '### OpenCode',
    '',
    'Add AgentLink to OpenCode as a stdio MCP server named `agentlink` with command `agentlink-mcp`, then use OpenCode normally. Keep tmux only for optional live-session discovery/notification.',
  ];
}

function renderCopilotSection(): string[] {
  return [
    '### GitHub Copilot CLI',
    '',
    'Use AgentLink as a standalone control-plane CLI beside Copilot CLI today. If your Copilot CLI environment exposes MCP configuration, point it at the generic stdio server above.',
    '',
    '```bash',
    'npm run agentlink -- context --format json',
    'npm run agentlink -- read',
    'npm run agentlink -- contract --set-section "Copilot Notes" --content "- ..."',
    '```',
  ];
}

function renderGeminiSection(): string[] {
  return [
    '### Gemini CLI',
    '',
    'Use the generic stdio MCP server config when Gemini CLI is running with MCP support. Without MCP, keep using the AgentLink CLI commands as the durable local bus.',
    '',
    '```bash',
    'npm run agentlink -- setup --harness stdio --format json',
    'npm run agentlink -- replay --format json',
    '```',
  ];
}

export function renderSetupGuideMarkdown(guide: SetupGuide): string {
  const lines = [
    '# AgentLink Setup Guide',
    '',
    `- Package: ${guide.packageName}${guide.version ? ` ${guide.version}` : ''}`,
    `- Workspace: ${guide.workspacePath}`,
    '- Install: `npm install -g @sruthik/agentlink` or run with `npx @sruthik/agentlink ...`',
    '- Quick check: `npx @sruthik/agentlink doctor`',
    '- Smoke test: `agentlink doctor`, then add `agentlink-mcp` to your coding agent MCP config.',
    '',
    '## MCP Server',
    '',
    `Command: \`${[guide.mcpCommand, ...guide.mcpArgs.map((arg) => JSON.stringify(arg))].join(' ')}\``,
    '',
  ];

  for (const harness of guide.harnesses) {
    if (harness === 'stdio') lines.push(...renderStdioSection(guide), '');
    if (harness === 'claude-code') lines.push(...renderClaudeSection(), '');
    if (harness === 'codex') lines.push(...renderCodexSection(), '');
    if (harness === 'copilot') lines.push(...renderCopilotSection(), '');
    if (harness === 'opencode') lines.push(...renderOpenCodeSection(), '');
    if (harness === 'gemini') lines.push(...renderGeminiSection(), '');
  }

  lines.push(
    '## Agent instruction prompt',
    '',
    '```text',
    guide.agentPrompt,
    '```',
    '',
  );
  return lines.join('\n');
}
