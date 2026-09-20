import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface LaunchBrief {
  packageName: string;
  version?: string;
  productThesis: string;
  launchBoundary: string;
  approvalRequired: true;
  verificationCommands: string[];
  demoCommands: string[];
  launchArtifacts: string[];
  ceoDecisionsNeeded: string[];
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

function releaseNotesFileName(version: string | undefined): string {
  const normalized = version?.trim();
  return normalized && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)
    ? `release-notes-v${normalized}.md`
    : 'release-notes-v0.1.1.md';
}

export async function collectLaunchBrief(cwd = process.cwd()): Promise<LaunchBrief> {
  const manifest = await readPackage(cwd);
  const builtCliPath = join(resolve(cwd), 'dist', 'cli.js');
  const releaseNotesPath = releaseNotesFileName(manifest.version);
  return {
    packageName: manifest.name ?? '@sruthik/agentlink',
    ...(manifest.version ? { version: manifest.version } : {}),
    productThesis: 'AgentLink is a local-first coordination bus for coding-agent harnesses doing cross-repo contract negotiation. Structured .agentlink state is the source of truth; tmux is only discovery/notification; MCP/CLI are harness surfaces.',
    launchBoundary: 'Do not npm publish, push, create releases, or announce publicly without explicit Sruthik approval.',
    approvalRequired: true,
    verificationCommands: [
      'npm test',
      'npm run agentlink -- ship-check',
      'node dist/cli.js ship-check --format json',
      'npm --silent pack --dry-run --json',
      'npm run agentlink -- doctor',
      'node dist/cli.js setup --harness all --format json',
    ],
    demoCommands: [
      `tmp_local=$(mktemp -d) && tmp_peer=$(mktemp -d) && (cd "$tmp_local" && node ${builtCliPath} demo --peer "$tmp_peer" --format json)`,
      'node dist/cli.js replay --format json',
    ],
    launchArtifacts: [
      'README command/reference coverage',
      'agentlink setup harness instructions',
      'agentlink doctor local readiness report',
      'agentlink ship-check launch-readiness gate',
      'npm tarball dry-run/install smoke with agentlink and agentlink-mcp bins',
      'agentlink demo deterministic two-repo negotiation smoke',
      'README demo GIF plus asciinema cast source',
      `${releaseNotesPath} launch notes included in README and npm tarball`,
      'stdio MCP server at dist/mcp/server.js',
    ],
    ceoDecisionsNeeded: [
      'Approve whether to publish to npm or keep local/private for more dogfood.',
      'Approve public announcement/repo/release language before launch.',
      'Choose first external proof target: npm package, GitHub release, or private demo only.',
    ],
  };
}

export function renderLaunchBriefMarkdown(brief: LaunchBrief): string {
  const lines = [
    '# AgentLink Launch Approval Brief',
    '',
    `- Package: ${brief.packageName}${brief.version ? ` ${brief.version}` : ''}`,
    `- Approval required: ${brief.approvalRequired ? 'yes' : 'no'}`,
    '',
    '## Product thesis',
    '',
    brief.productThesis,
    '',
    '## Verification commands',
    '',
    ...brief.verificationCommands.map((command) => `- \`${command}\``),
    '',
    '## Demo commands',
    '',
    ...brief.demoCommands.map((command) => `- \`${command}\``),
    '',
    '## Launch artifacts',
    '',
    ...brief.launchArtifacts.map((artifact) => `- ${artifact}`),
    '',
    '## CEO decisions needed',
    '',
    ...brief.ceoDecisionsNeeded.map((decision) => `- ${decision}`),
    '',
    '## Launch boundary',
    '',
    brief.launchBoundary,
    '',
  ];
  return lines.join('\n');
}
