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
  peerWorkflow: string[];
  processingSemantics: string[];
  notificationBoundary: string[];
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
    peerWorkflow: [
      'Initialize both repos and configure/select one stable actor per harness process.',
      'Create a conversation in the owner repo, then explicitly pair the peer with contract --sync-to and join it.',
      'Register each live IDE/harness process with a bounded TTL and renew it with heartbeat.',
    ],
    processingSemantics: [
      'Read returns a durable cursor without acknowledgement; acknowledge only after processing succeeds.',
      'Wait requires a prior cursor/message id, is bounded to 30 seconds, and returns timeout normally.',
      'After cancellation or process restart, repeat read/wait with the same durable cursor.',
    ],
    notificationBoundary: [
      'A supervised Codex recipient is opt-in at enrollment; ordinary sends then enqueue eligible recipients automatically without a per-send flag.',
      'Adapter argv comes only from user trust config outside the repo, runs without a shell, and receives event/message references rather than the message body.',
      'AgentLink MCP alone cannot wake an idle LLM session. The concrete supported wake path is the enrolled supervised/headless Codex runner; arbitrary interactive Codex, Claude, tmux, and IDE sessions remain unsupported.',
    ],
    agentPrompt: [
      'Use AgentLink for cross-repo coordination. Keep repo source isolated; exchange compact contract updates only.',
      'List conversations first, pass explicit conversation ids whenever more than one candidate exists, page messages with nextCursor, and acknowledge processing explicitly after acting.',
      'Before implementation, read the authoritative local AgentLink bus, update conversation-scoped CONTRACT.md sections deterministically, and record stable-actor approvals before accepting.',
      'Register the current harness with a bounded TTL, renew its heartbeat while active, use bounded waits from durable cursors, and treat notification as distinct from processing acknowledgement.',
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
    '- Cross-repo pairing: from the owner repo run `agentlink contract --conversation <id> --sync-to ../peer`, then from the peer run `agentlink join --conversation <id>`.',
    '- Message processing: use explicit conversation ids, persist the returned `nextCursor`, and call `agentlink ack` only after processing succeeds.',
    '- Core discovery is the explicit expiring bus registry; tmux is optional and never required.',
    '',
    '## Two-peer workflow',
    '',
    '```bash',
    '# owner repo',
    'agentlink init',
    'agentlink actor show',
    'agentlink start --topic "Shared API"',
    'agentlink contract --conversation <id> --sync-to ../peer',
    'agentlink register --label owner-codex --client codex --ttl 300',
    '',
    '# peer repo',
    'agentlink init',
    'agentlink actor show',
    'agentlink join --conversation <id>',
    'agentlink register --label peer-agent --client other-ide --ttl 300',
    'agentlink heartbeat --registration <registration-id> --ttl 300',
    '```',
    '',
    ...guide.peerWorkflow.map((item) => `- ${item}`),
    '',
    '## Cursor, wait, and acknowledgement',
    '',
    ...guide.processingSemantics.map((item) => `- ${item}`),
    '',
    '```bash',
    'agentlink read --conversation <id> --limit 20',
    'agentlink wait --conversation <id> --after <next-cursor> --timeout-ms 10000',
    'agentlink ack --conversation <id> --message-id <message-id>',
    '```',
    '',
    '## Trusted local notification receiver',
    '',
    ...guide.notificationBoundary.map((item) => `- ${item}`),
    '',
    'Configure fixed argv using absolute paths (the command intentionally does not print argv back):',
    '',
    '```bash',
    'agentlink notify trust --id local-receiver --argv-json \'["/absolute/path/to/node","/absolute/path/to/agentlink/dist/cli.js","receiver","--inbox","/absolute/user/path/agentlink-events.jsonl"]\'',
    'agentlink register --label peer-agent --adapter local-receiver --ttl 300',
    'agentlink send --conversation <id> --body "Review the durable message" --notify',
    'agentlink notify retry --event <event-id>',
    '```',
    '',
    '## Supervised headless Codex auto-wake',
    '',
    'Run enrollment in the recipient repo. The config, queue, transcripts, and trusted argv stay in user-owned paths outside the repo:',
    '',
    '```bash',
    'CODEX_BIN="$(command -v codex)"',
    'agentlink wake enroll --recipient peer-codex --conversation <id> --codex "$CODEX_BIN" --model gpt-5.6-sol',
    'agentlink wake run --config "$HOME/.config/agentlink/wake/peer-codex.json"',
    '',
    '# sender repo; --to is recommended when several participants are eligible',
    'agentlink send --conversation <id> --to <peer-participant-id> --body "Implement the durable task"',
    '',
    'agentlink wake status --config "$HOME/.config/agentlink/wake/peer-codex.json"',
    'agentlink wake pause --config "$HOME/.config/agentlink/wake/peer-codex.json"',
    'agentlink wake resume --config "$HOME/.config/agentlink/wake/peer-codex.json"',
    'agentlink wake stop --config "$HOME/.config/agentlink/wake/peer-codex.json"',
    'agentlink wake retry --config "$HOME/.config/agentlink/wake/peer-codex.json" --job <job-id>',
    '```',
    '',
    'The runner uses `codex exec --json` and resumes only the saved per-conversation thread. It is serial, bounded, sandboxed `workspace-write`, and acknowledges only after a validated completion checkpoint. Timeout/crash work is suspended for explicit recovery because arbitrary side effects cannot be promised exactly once.',
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
