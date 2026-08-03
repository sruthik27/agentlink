import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export function parseSetupHarness(value: string): SetupHarness {
  const normalized = value.trim().toLowerCase();
  const harness = SETUP_HARNESSES.find((candidate) => candidate === normalized);
  if (!harness) {
    throw new Error(`Invalid setup harness: ${value}. Expected one of: ${SETUP_HARNESSES.join(', ')}`);
  }
  return harness;
}

export async function collectSetupGuide(cwd = process.cwd(), harness: SetupHarness | 'all' = 'all'): Promise<SetupGuide> {
  const manifest = await readPackage(cwd);
  return {
    packageName: manifest.name ?? 'agentlink',
    ...(manifest.version ? { version: manifest.version } : {}),
    workspacePath: cwd,
    mcpCommand: 'node',
    mcpArgs: [join(cwd, 'dist', 'mcp', 'server.js')],
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
    'After `npm run build`, add the local MCP server to this project:',
    '',
    '```bash',
    'claude mcp add -s local agentlink -- node "$PWD/dist/mcp/server.js"',
    '```',
  ];
}

function renderCodexSection(): string[] {
  return [
    '### Codex CLI',
    '',
    'Use the generic stdio MCP server config if your Codex build exposes MCP configuration; otherwise use AgentLink as the standalone control plane from shell commands:',
    '',
    '```bash',
    'npm run agentlink -- context',
    'npm run agentlink -- start --topic "<change>" --template api-change --max-rounds 6 --required-approvals 2',
    'npm run agentlink -- read',
    'npm run agentlink -- contract --set-section "Agreed Changes" --content "- ..."',
    '```',
  ];
}

function renderOpenCodeSection(): string[] {
  return [
    '### OpenCode',
    '',
    'Point OpenCode MCP settings at the generic stdio server above. Keep AgentLink as the durable bus and use tmux only for discovery/notification.',
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
    '- Build: `npm install && npm run build`',
    '- Smoke test: `node dist/mcp/server.js` with JSON-RPC initialize/list_tools, or `npm run agentlink -- doctor` for local readiness.',
    '',
    '## MCP Server',
    '',
    `Command: \`${guide.mcpCommand} ${guide.mcpArgs.map((arg) => JSON.stringify(arg)).join(' ')}\``,
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
