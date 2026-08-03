import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ShipCheckStatus = 'ok' | 'warn' | 'fail';

export interface ShipCheckItem {
  status: ShipCheckStatus;
  label: string;
  detail: string;
}

export interface ShipCheckReport {
  packageName: string;
  version?: string;
  checks: ShipCheckItem[];
  hasFailures: boolean;
  launchBoundary: string;
  recommendedNextStep: string;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
  files?: unknown;
  scripts?: unknown;
  license?: unknown;
  description?: unknown;
  keywords?: unknown;
}

function item(status: ShipCheckStatus, label: string, detail: string): ShipCheckItem {
  return { status, label, detail };
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

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

function includesAll(text: string | undefined, needles: string[]): string[] {
  if (!text) return needles;
  return needles.filter((needle) => !text.includes(needle));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export async function collectShipCheckReport(cwd = process.cwd()): Promise<ShipCheckReport> {
  const checks: ShipCheckItem[] = [];
  const manifest = await readPackageManifest(cwd);
  const packageName = typeof manifest?.name === 'string' ? manifest.name : 'agentlink';
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined;

  if (!manifest) {
    checks.push(item('fail', 'package manifest', 'missing or unreadable package.json'));
  } else {
    checks.push(item('ok', 'package manifest', `${packageName}${version ? ` ${version}` : ''}`));
    const scripts = objectKeys(manifest.scripts);
    const missingScripts = ['agentlink', 'build', 'test'].filter((script) => !scripts.includes(script));
    checks.push(missingScripts.length === 0
      ? item('ok', 'required npm scripts', scripts.join(', '))
      : item('fail', 'required npm scripts', `missing: ${missingScripts.join(', ')}`));

    const bins = objectKeys(manifest.bin);
    const missingBins = ['agentlink', 'agentlink-mcp'].filter((bin) => !bins.includes(bin));
    checks.push(missingBins.length === 0
      ? item('ok', 'package bins', bins.join(', '))
      : item('fail', 'package bins', `missing: ${missingBins.join(', ')}`));

    const files = stringArray(manifest.files);
    const hasDistJs = files.includes('dist') || files.some((entry) => entry === 'dist/**/*.js' || entry === 'dist/**/*.cjs' || entry === 'dist/**/*.mjs');
    const hasDistTypes = files.includes('dist') || files.some((entry) => entry === 'dist/**/*.d.ts' || entry === 'dist/**/*.d.mts' || entry === 'dist/**/*.d.cts');
    const hasReadme = files.includes('README.md') || files.includes('README*');
    const includesSourceOrState = files.some((entry) => !entry.startsWith('!') && (
      entry === 'src'
      || entry.startsWith('src/')
      || entry === '.agentlink'
      || entry.startsWith('.agentlink/')
      || entry === '.hermes'
      || entry.startsWith('.hermes/')
    ));
    const missingFileEntries = [
      ...(hasDistJs ? [] : ['dist JavaScript']),
      ...(hasDistTypes ? [] : ['dist type declarations']),
      ...(hasReadme ? [] : ['README.md']),
    ];
    checks.push(files.length > 0 && missingFileEntries.length === 0 && !includesSourceOrState
      ? item('ok', 'package files allowlist', files.join(', '))
      : item('fail', 'package files allowlist', [
        files.length === 0 ? 'missing package.json files allowlist' : undefined,
        missingFileEntries.length > 0 ? `missing: ${missingFileEntries.join(', ')}` : undefined,
        includesSourceOrState ? 'must not include src/, .agentlink/, or .hermes/ state' : undefined,
      ].filter(Boolean).join('; ')));

    checks.push(typeof manifest.license === 'string' && manifest.license.trim()
      ? item('ok', 'license metadata', manifest.license)
      : item('warn', 'license metadata', 'missing package license'));

    const keywordList = Array.isArray(manifest.keywords) ? manifest.keywords.filter((value): value is string => typeof value === 'string') : [];
    const missingKeywords = ['mcp', 'tmux', 'multi-agent'].filter((keyword) => !keywordList.includes(keyword));
    checks.push(missingKeywords.length === 0
      ? item('ok', 'discovery keywords', keywordList.join(', '))
      : item('warn', 'discovery keywords', `missing useful keywords: ${missingKeywords.join(', ')}`));
  }

  const readme = await readTextIfPresent(join(cwd, 'README.md'));
  if (!readme) {
    checks.push(item('fail', 'README', 'missing README.md'));
  } else {
    const missingCommands = includesAll(readme, [
      'npm run agentlink -- setup',
      'npm run agentlink -- doctor',
      'npm run agentlink -- demo --peer',
      'npm run agentlink -- replay',
      'npm run agentlink -- version',
      'npm run agentlink -- launch-brief',
      'node dist/mcp/server.js',
    ]);
    checks.push(missingCommands.length === 0
      ? item('ok', 'README command coverage', 'setup, doctor, demo, replay, version, launch-brief, ship-check, and MCP smoke commands documented')
      : item('fail', 'README command coverage', `missing command docs: ${missingCommands.join(', ')}`));

    const missingPositioning = includesAll(readme, [
      'cross-repo contract negotiation',
      'Structured bus is source of truth',
      'tmux pane messaging is notification/bridge',
    ]);
    checks.push(missingPositioning.length === 0
      ? item('ok', 'README positioning', 'contract workflow, durable bus, and tmux boundary are explicit')
      : item('warn', 'README positioning', `missing positioning text: ${missingPositioning.join(', ')}`));
  }

  checks.push(await pathExists(join(cwd, 'dist', 'cli.js'))
    ? item('ok', 'CLI build artifact', 'dist/cli.js')
    : item('warn', 'CLI build artifact', 'missing; run `npm run build` before local install'));
  checks.push(await pathExists(join(cwd, 'dist', 'mcp', 'server.js'))
    ? item('ok', 'MCP build artifact', 'dist/mcp/server.js')
    : item('warn', 'MCP build artifact', 'missing; run `npm run build` before MCP setup'));

  return {
    packageName,
    ...(version ? { version } : {}),
    checks,
    hasFailures: checks.some((check) => check.status === 'fail'),
    launchBoundary: 'Do not npm publish, push, create releases, or announce publicly without explicit Sruthik approval.',
    recommendedNextStep: 'Run npm test, npm run agentlink -- doctor, and a temp-workspace demo smoke before requesting launch approval.',
  };
}

export function renderShipCheckReport(report: ShipCheckReport): string {
  const lines = [
    'AgentLink Ship Check',
    '',
    `Package: ${report.packageName}${report.version ? ` ${report.version}` : ''}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.label}: ${check.detail}`);
  }
  lines.push(
    '',
    `Launch boundary: ${report.launchBoundary}`,
    `Recommended next step: ${report.recommendedNextStep}`,
    '',
    report.hasFailures ? 'Result: not ready; fix failed checks before launch approval.' : 'Result: ready for final verified demo and human launch approval.',
  );
  return `${lines.join('\n')}\n`;
}
