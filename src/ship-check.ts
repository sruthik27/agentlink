import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  homepage?: unknown;
  repository?: unknown;
  bugs?: unknown;
  engines?: unknown;
  publishConfig?: unknown;
}

interface NpmPackDryRunResult {
  files?: Array<{ path?: unknown; mode?: unknown }>;
}

interface PackedFile {
  path: string;
  mode?: number;
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

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function includesAll(text: string | undefined, needles: string[]): string[] {
  if (!text) return needles;
  return needles.filter((needle) => !text.includes(needle));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function releaseNotesFileName(version: string | undefined): string {
  const normalized = version?.trim();
  return normalized && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)
    ? `release-notes-v${normalized}.md`
    : 'release-notes-v0.1.1.md';
}

function nodeEngineSupportsLaunchBaseline(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  if (/(?:^|\s)(?:<=|<)\s*20(?:\.0\.0)?(?:\s|$)/.test(normalized)) return false;
  return /(?:^|[\s||])(?:>=|>|\^|~)?\s*(?:2[0-9]|[3-9][0-9])(?:\.\d+)?(?:\.\d+)?(?:\s|$)/.test(normalized);
}

async function validateDemoMedia(cwd: string): Promise<string[]> {
  const problems: string[] = [];
  try {
    const gif = await readFile(join(cwd, 'demos', 'agentlink-demo.gif'));
    if (gif.length < 6 || gif.subarray(0, 6).toString('ascii').slice(0, 4) !== 'GIF8') {
      problems.push('demos/agentlink-demo.gif is missing a GIF header');
    }
  } catch {
    problems.push('demos/agentlink-demo.gif');
  }

  try {
    const cast = await readFile(join(cwd, 'demos', 'agentlink-demo.cast'), 'utf8');
    const firstLine = cast.split(/\r?\n/, 1)[0];
    const header = JSON.parse(firstLine) as { version?: unknown; title?: unknown };
    if (header.version !== 2 || typeof header.title !== 'string' || !cast.includes('AgentLink demo')) {
      problems.push('demos/agentlink-demo.cast is not a valid AgentLink asciinema v2 recording');
    }
  } catch {
    problems.push('demos/agentlink-demo.cast');
  }
  return problems;
}

async function collectNpmPackDryRunFiles(cwd: string): Promise<PackedFile[]> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agentlink-pack-inspect-'));
  try {
    const { stdout } = await execFileAsync('npm', ['--silent', 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd,
      env: { ...process.env, npm_config_cache: join(tempRoot, 'npm-cache') },
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as NpmPackDryRunResult[];
    const first = parsed[0];
    return Array.isArray(first?.files)
      ? first.files
        .flatMap((entry) => (typeof entry.path === 'string'
          ? [{ path: entry.path, ...(typeof entry.mode === 'number' ? { mode: entry.mode } : {}) }]
          : []))
        .sort((left, right) => left.path.localeCompare(right.path))
      : [];
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function gitIgnoresReleaseNotes(cwd: string, releaseNotesPath: string): Promise<boolean | undefined> {
  if (!(await pathExists(join(cwd, '.git')))) return undefined;
  try {
    await execFileAsync('git', ['check-ignore', '--quiet', releaseNotesPath], {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === 1) return false;
    return undefined;
  }
}

async function runInstalledTarballSmoke(cwd: string, expectedVersion: string | undefined): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agentlink-pack-smoke-'));
  try {
    const packDir = join(tempRoot, 'pack');
    const prefix = join(tempRoot, 'prefix');
    const npmEnvironment = { ...process.env, npm_config_cache: join(tempRoot, 'npm-cache') };
    await mkdir(packDir, { recursive: true });
    await mkdir(prefix, { recursive: true });
    const { stdout: packStdout } = await execFileAsync('npm', ['--silent', 'pack', '--json', '--pack-destination', packDir, '--ignore-scripts'], {
      cwd,
      env: npmEnvironment,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const packed = JSON.parse(packStdout) as Array<{ filename?: unknown }>;
    const filename = packed[0]?.filename;
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('npm pack did not report a tarball filename');
    const tarballPath = join(packDir, filename);

    await execFileAsync('npm', ['install', '--global', '--prefix', prefix, tarballPath], {
      cwd,
      env: npmEnvironment,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const { stdout: versionStdout } = await execFileAsync(join(prefix, 'bin', 'agentlink'), ['version'], {
      cwd: tempRoot,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const installedVersion = versionStdout.trim();
    if (expectedVersion && installedVersion !== expectedVersion) {
      throw new Error(`installed agentlink version ${installedVersion || '<empty>'} did not match package version ${expectedVersion}`);
    }
    await runInstalledMcpInitializeSmoke(join(prefix, 'bin', 'agentlink-mcp'), tempRoot, expectedVersion);
    return expectedVersion
      ? `installed agentlink ${installedVersion} and initialized agentlink-mcp from packed tarball`
      : 'installed agentlink and initialized agentlink-mcp from packed tarball';
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInstalledMcpInitializeSmoke(binPath: string, cwd: string, expectedVersion: string | undefined): Promise<void> {
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agentlink-ship-check', version: '0.1.1' },
    },
  }), 'utf8');
  const request = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binPath, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      settle(new Error(`installed agentlink-mcp initialize smoke timed out${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    }, 30_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => settle(error));
    child.on('exit', (code, signal) => {
      if (!settled && code !== 0) settle(new Error(`installed agentlink-mcp exited before initialize response with code ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      try {
        const separator = stdout.indexOf('\r\n\r\n');
        if (separator === -1) return;
        const header = stdout.subarray(0, separator).toString('utf8');
        const match = header.match(/^Content-Length:\s*(\d+)$/im);
        if (!match) throw new Error('installed agentlink-mcp response missing Content-Length header');
        const bodyLength = Number(match[1]);
        const bodyOffset = separator + 4;
        if (stdout.length < bodyOffset + bodyLength) return;
        const response = JSON.parse(stdout.subarray(bodyOffset, bodyOffset + bodyLength).toString('utf8')) as {
          id?: unknown;
          result?: { serverInfo?: { name?: unknown; version?: unknown } };
          error?: unknown;
        };
        if (response.id !== 1) throw new Error('installed agentlink-mcp initialize response id mismatch');
        if (response.error) throw new Error(`installed agentlink-mcp initialize failed: ${JSON.stringify(response.error)}`);
        if (response.result?.serverInfo?.name !== 'agentlink-mcp') {
          throw new Error('installed agentlink-mcp initialize response missing serverInfo.name');
        }
        if (expectedVersion && response.result.serverInfo.version !== expectedVersion) {
          throw new Error(`installed agentlink-mcp version ${String(response.result.serverInfo.version ?? '<missing>')} did not match package version ${expectedVersion}`);
        }
        settle();
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stdin.end(request);
  });
}

export async function collectShipCheckReport(cwd = process.cwd()): Promise<ShipCheckReport> {
  const checks: ShipCheckItem[] = [];
  const manifest = await readPackageManifest(cwd);
  const packageName = typeof manifest?.name === 'string' ? manifest.name : '@sruthik/agentlink';
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined;
  const releaseNotesPath = releaseNotesFileName(version);

  if (!manifest) {
    checks.push(item('fail', 'package manifest', 'missing or unreadable package.json'));
  } else {
    checks.push(packageName === '@sruthik/agentlink'
      ? item('ok', 'package manifest', `${packageName}${version ? ` ${version}` : ''}`)
      : item('fail', 'package manifest', `expected @sruthik/agentlink, found ${packageName}`));
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
    const hasLicense = files.includes('LICENSE') || files.includes('LICENSE*');
    const hasChangelog = files.includes('CHANGELOG.md') || files.includes('CHANGELOG*');
    const hasReleaseNotes = files.includes(releaseNotesPath) || files.includes('release-notes*.md');
    const hasDemoGif = files.includes('demos/agentlink-demo.gif') || files.includes('demos/**');
    const hasDemoCast = files.includes('demos/agentlink-demo.cast') || files.includes('demos/**');
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
      ...(hasLicense ? [] : ['LICENSE']),
      ...(hasChangelog ? [] : ['CHANGELOG.md']),
      ...(hasReleaseNotes ? [] : ['release notes']),
      ...(hasDemoGif ? [] : ['README demo GIF']),
      ...(hasDemoCast ? [] : ['README demo cast']),
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

    const publicationMetadataMissing = [
      typeof manifest.description === 'string' && manifest.description.trim() ? undefined : 'description',
      typeof manifest.homepage === 'string' && manifest.homepage.trim() ? undefined : 'homepage',
      typeof objectValue(manifest.repository, 'url') === 'string' && String(objectValue(manifest.repository, 'url')).trim() ? undefined : 'repository.url',
      typeof objectValue(manifest.bugs, 'url') === 'string' && String(objectValue(manifest.bugs, 'url')).trim() ? undefined : 'bugs.url',
      nodeEngineSupportsLaunchBaseline(objectValue(manifest.engines, 'node')) ? undefined : 'engines.node >=20',
      objectValue(manifest.publishConfig, 'access') === 'public' ? undefined : 'publishConfig.access public',
    ].filter(Boolean) as string[];
    checks.push(publicationMetadataMissing.length === 0
      ? item('ok', 'publication metadata', 'description, repository, homepage, bugs, Node engine, and public publish config are set')
      : item('fail', 'publication metadata', `missing or incomplete: ${publicationMetadataMissing.join(', ')}`));
  }

  const readme = await readTextIfPresent(join(cwd, 'README.md'));
  if (!readme) {
    checks.push(item('fail', 'README', 'missing README.md'));
  } else {
    const missingCommands = includesAll(readme, [
      'npm run agentlink -- setup',
      'npm run agentlink -- doctor',
      'npm run agentlink -- ship-check',
      'npm run agentlink -- demo --peer',
      'npm run agentlink -- replay',
      'npm run agentlink -- version',
      'npm run agentlink -- launch-brief',
      'node dist/mcp/server.js',
    ]);
    checks.push(missingCommands.length === 0
      ? item('ok', 'README command coverage', 'setup, doctor, demo, replay, version, launch-brief, ship-check, and MCP smoke commands documented')
      : item('fail', 'README command coverage', `missing command docs: ${missingCommands.join(', ')}`));

    const missingInstallUx = includesAll(readme, [
      'npx @sruthik/agentlink doctor',
      'npm install -g @sruthik/agentlink',
      'agentlink setup --harness',
    ]);
    checks.push(missingInstallUx.length === 0
      ? item('ok', 'README install UX', 'npx quickstart, global install, and harness setup commands documented')
      : item('fail', 'README install UX', `missing install docs: ${missingInstallUx.join(', ')}`));

    const missingPositioning = includesAll(readme, [
      'cross-repo contract negotiation',
      'Structured bus is source of truth',
      'tmux pane messaging is notification/bridge',
    ]);
    checks.push(missingPositioning.length === 0
      ? item('ok', 'README positioning', 'contract workflow, durable bus, and tmux boundary are explicit')
      : item('warn', 'README positioning', `missing positioning text: ${missingPositioning.join(', ')}`));

    const demoMediaProblems = await validateDemoMedia(cwd);
    const readmeReferencesDemoMedia = readme.includes('demos/agentlink-demo.gif') && readme.includes('demos/agentlink-demo.cast');
    checks.push(readmeReferencesDemoMedia && demoMediaProblems.length === 0
      ? item('ok', 'README demo media', 'GIF preview and asciinema source are present and parseable')
      : item('fail', 'README demo media', [
        readmeReferencesDemoMedia ? undefined : 'README must reference demos/agentlink-demo.gif and demos/agentlink-demo.cast',
        demoMediaProblems.length > 0 ? `invalid or missing files: ${demoMediaProblems.join(', ')}` : undefined,
      ].filter(Boolean).join('; ')));

    const releaseNotes = await readTextIfPresent(join(cwd, releaseNotesPath));
    const readmeReferencesReleaseNotes = readme.includes(releaseNotesPath);
    const releaseNotesReady = Boolean(
      releaseNotes
      && releaseNotes.includes(`AgentLink ${version ?? '0.1.1'}`)
      && releaseNotes.includes('Verification before release')
      && releaseNotes.includes('Known limitation')
    );
    checks.push(readmeReferencesReleaseNotes && releaseNotesReady
      ? item('ok', 'release notes artifact', `${releaseNotesPath} is present, linked, and includes verification notes`)
      : item('fail', 'release notes artifact', [
        readmeReferencesReleaseNotes ? undefined : `README must reference ${releaseNotesPath}`,
        releaseNotes ? undefined : `missing ${releaseNotesPath}`,
        releaseNotes && !releaseNotesReady ? 'release notes must include title, verification, and known limitation sections' : undefined,
      ].filter(Boolean).join('; ')));

    const releaseNotesIgnored = await gitIgnoresReleaseNotes(cwd, releaseNotesPath);
    if (releaseNotesIgnored !== undefined) {
      checks.push(releaseNotesIgnored
        ? item('fail', 'release notes git ignore', `${releaseNotesPath} is ignored by git; add a negated .gitignore rule before launch`)
        : item('ok', 'release notes git ignore', `${releaseNotesPath} is not ignored by git`));
    }
  }

  checks.push(await pathExists(join(cwd, 'dist', 'cli.js'))
    ? item('ok', 'CLI build artifact', 'dist/cli.js')
    : item('warn', 'CLI build artifact', 'missing; run `npm run build` before local install'));
  checks.push(await pathExists(join(cwd, 'dist', 'mcp', 'server.js'))
    ? item('ok', 'MCP build artifact', 'dist/mcp/server.js')
    : item('warn', 'MCP build artifact', 'missing; run `npm run build` before MCP setup'));

  try {
    const packedEntries = await collectNpmPackDryRunFiles(cwd);
    const packedFiles = packedEntries.map((entry) => entry.path);
    const forbiddenPackedFiles = packedFiles.filter((path) => (
      path === 'src'
      || path.startsWith('src/')
      || path === '.agentlink'
      || path.startsWith('.agentlink/')
      || path === '.hermes'
      || path.startsWith('.hermes/')
      || path.endsWith('.map')
      || /(^|\/)dist\/.*\.test\.(js|d\.ts)$/.test(path)
    ));
    const missingPackedFiles = [
      ...(packedFiles.includes('README.md') ? [] : ['README.md']),
      ...(packedFiles.includes('LICENSE') ? [] : ['LICENSE']),
      ...(packedFiles.includes('CHANGELOG.md') ? [] : ['CHANGELOG.md']),
      ...(packedFiles.includes('package.json') ? [] : ['package.json']),
      ...(packedFiles.includes(releaseNotesPath) ? [] : [releaseNotesPath]),
      ...(packedFiles.includes('dist/cli.js') ? [] : ['dist/cli.js']),
      ...(packedFiles.includes('dist/mcp/server.js') ? [] : ['dist/mcp/server.js']),
      ...(packedFiles.includes('demos/agentlink-demo.gif') ? [] : ['demos/agentlink-demo.gif']),
      ...(packedFiles.includes('demos/agentlink-demo.cast') ? [] : ['demos/agentlink-demo.cast']),
    ];
    checks.push(forbiddenPackedFiles.length === 0 && missingPackedFiles.length === 0
      ? item('ok', 'npm pack dry-run', `${packedFiles.length} publishable files; no source/test/map/local-state leaks`)
      : item('fail', 'npm pack dry-run', [
        missingPackedFiles.length > 0 ? `missing: ${missingPackedFiles.join(', ')}` : undefined,
        forbiddenPackedFiles.length > 0 ? `must not ship: ${forbiddenPackedFiles.join(', ')}` : undefined,
      ].filter(Boolean).join('; ')));

    const packedBinProblems = ['dist/cli.js', 'dist/mcp/server.js'].flatMap((path) => {
      const entry = packedEntries.find((candidate) => candidate.path === path);
      if (!entry) return [`${path} missing`];
      return typeof entry.mode === 'number' && (entry.mode & 0o111) !== 0 ? [] : [`${path} not executable in npm tarball`];
    });
    checks.push(packedBinProblems.length === 0
      ? item('ok', 'npm bin executability', 'agentlink and agentlink-mcp are executable in the npm tarball')
      : item('fail', 'npm bin executability', packedBinProblems.join('; ')));

    try {
      checks.push(item('ok', 'installed tarball smoke', await runInstalledTarballSmoke(cwd, version)));
    } catch (error) {
      checks.push(item('fail', 'installed tarball smoke', error instanceof Error ? error.message : String(error)));
    }
  } catch (error) {
    checks.push(item('fail', 'npm pack dry-run', `failed to inspect tarball: ${error instanceof Error ? error.message : String(error)}`));
  }

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
