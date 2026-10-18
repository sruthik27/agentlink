import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { assertNotSymlink, atomicWriteFile, withFileLock } from './atomic.js';
import type { SetupHarness } from './setup.js';

export interface SetupPlan {
  harness: SetupHarness; workspace: string; name: string; configPath: string | null;
  scope: 'project' | 'user';
  command: string; args: string[]; config: Record<string, unknown> | string;
  verification: string; next: string[];
}
export async function planSetup(cwd: string, harness: SetupHarness, stateRoot?: string, wakeConfig?: string, scope: 'project' | 'user' = 'project', userHome = homedir(), configEnv: NodeJS.ProcessEnv = process.env): Promise<SetupPlan> {
  if (scope !== 'project' && scope !== 'user') throw new Error('--scope must be project or user');
  if (scope === 'user' && (stateRoot || wakeConfig)) throw new Error('User-wide setup cannot pin a project network state root or wake enrollment; use project scope for these');
  const workspace = await realpath(cwd);
  const args = [fileURLToPath(new URL('./mcp/launch.js', import.meta.url)), ...(scope === 'user' ? ['--session'] : ['--workspace', workspace])];
  if (stateRoot) {
    if (!isAbsolute(stateRoot)) throw new Error('--state-root must be absolute');
    const root = await realpath(stateRoot), rel = relative(workspace, root);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('Private state root must be outside the workspace');
    args.push('--state-root', root);
  }
  if (wakeConfig) {
    if (!stateRoot || !isAbsolute(wakeConfig)) throw new Error('--wake-config requires --state-root and an absolute path');
    args.push('--wake-config', await realpath(wakeConfig));
  }
  const command = await realpath(process.execPath), name = stateRoot ? 'agentlink-network' : 'agentlink';
  const entry = { command, args };
  let config: SetupPlan['config'] = { mcpServers: { [name]: entry } };
  let configPath: string | null = join(workspace, '.mcp.json');
  if (harness === 'copilot' || harness === 'claude-code') config = { mcpServers: { [name]: { type: 'stdio', ...entry } } };
  if (harness === 'gemini') configPath = join(workspace, '.gemini/settings.json');
  if (harness === 'opencode') { configPath = join(workspace, 'opencode.json'); config = { mcp: { [name]: { type: 'local', command: [command, ...args], enabled: true } } }; }
  if (harness === 'codex') {
    configPath = join(workspace, '.codex/config.toml');
    config = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
  }
  if (scope === 'user') {
    const base = (value: string | undefined, fallback: string): string => {
      const directory = value || fallback;
      if (!isAbsolute(directory)) throw new Error('Harness config directory must be absolute');
      return directory;
    };
    if (harness === 'claude-code') {
      if (configEnv.CLAUDE_CONFIG_DIR) throw new Error('Custom CLAUDE_CONFIG_DIR: use the native claude mcp add --scope user with the stdio preview; setup will not guess a global config path');
      configPath = join(userHome, '.claude.json');
    }
    if (harness === 'codex') configPath = join(base(configEnv.CODEX_HOME, join(userHome, '.codex')), 'config.toml');
    if (harness === 'copilot') configPath = join(base(configEnv.COPILOT_HOME, join(userHome, '.copilot')), 'mcp-config.json');
    if (harness === 'gemini') configPath = join(userHome, '.gemini/settings.json');
    if (harness === 'opencode') configPath = join(base(configEnv.XDG_CONFIG_HOME, join(userHome, '.config')), 'opencode/opencode.json');
  }
  if (harness === 'stdio') configPath = null;
  return { harness, workspace, scope, name, configPath, command, args, config,
    verification: 'Configuration only; use --check for a real MCP initialize/tools-list check. Native model use and automatic wake are separate acceptance gates.',
    next: [scope === 'user' ? 'Reconnect the harness once. AgentLink is available across repositories; each new MCP session uses agentlink_session to bind its current workspace before any project operation.' : 'Start/reconnect your coding agent in this project and approve its normal project/MCP trust prompt.', 'Ask the agent to list AgentLink tools and conversations. MCP approval and organization policies still apply.', 'For two-host use, ask the agent to connect by code. Setup never creates grants, renews expiry or starts a daemon.'] };
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export async function writeSetup(plan: SetupPlan): Promise<{ status: string; configPath: string; backup?: string }> {
  if (!plan.configPath) throw new Error('Generic stdio clients: copy the generated server definition into your client configuration');
  const file = plan.configPath, parent = dirname(file);
  await assertNotSymlink(parent, 'Project config directory'); await mkdir(parent, { recursive: true });
  return withFileLock(join(parent, '.agentlink-setup-locks'), 'config', async () => {
    await assertNotSymlink(file, 'Project config');
    if (plan.harness === 'opencode') {
      try { await lstat(join(parent, 'opencode.jsonc')); throw new Error('Existing opencode.jsonc: merge the printed MCP entry there; setup will not shadow it'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    let before: string | undefined;
    try { if ((await lstat(file)).size > 256000) throw new Error('Config exceeds 256000 bytes'); before = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let after: string;
    if (typeof plan.config === 'string') {
      if (before !== undefined && before !== plan.config) throw new Error('Existing Codex TOML preserved. Merge the printed mcp_servers entry into it, or use codex mcp add; setup will not rewrite unrelated TOML');
      after = plan.config;
    } else {
      let current: Record<string, unknown> = {};
      if (before !== undefined) { try { const parsed: unknown = JSON.parse(before); if (!object(parsed)) throw new Error(); current = parsed; } catch { throw new Error('Existing config is not a JSON object; preserved without changes'); } }
      const key = plan.harness === 'opencode' ? 'mcp' : 'mcpServers';
      if (current[key] !== undefined && !object(current[key])) throw new Error(`Existing ${key} must be an object; config preserved`);
      // Copilot supports bare server maps; do not silently convert or shadow them.
      if (plan.harness === 'copilot' && current.mcpServers === undefined && Object.keys(current).length) throw new Error('Existing bare Copilot config preserved; merge the printed server definition explicitly');
      const servers = (current[key] ?? {}) as Record<string, unknown>, proposed = (plan.config[key] as Record<string, unknown>)[plan.name];
      if (servers[plan.name] !== undefined && JSON.stringify(servers[plan.name]) !== JSON.stringify(proposed)) throw new Error(`Existing ${plan.name} entry differs; preserved. Review the printed config before replacing it`);
      if (servers[plan.name] !== undefined) return { status: 'already-configured', configPath: file };
      current[key] = { ...servers, [plan.name]: proposed }; after = JSON.stringify(current, null, 2) + '\n';
    }
    if (before === after) return { status: 'already-configured', configPath: file };
    const backup = before === undefined ? undefined : file + '.agentlink-backup-' + randomUUID();
    if (backup) await atomicWriteFile(backup, before!);
    await atomicWriteFile(file, after);
    return { status: 'configured', configPath: file, ...(backup ? { backup } : {}) };
  });
}

/** Real stdio handshake only. Starting MCP initializes local workspace metadata. */
export async function checkSetup(plan: SetupPlan): Promise<{ status: string; tools: number; nativeAgentVerified: false }> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { cwd: plan.workspace, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let settled = false, bytes = 0;
    const finish = (error?: Error, tools = 0): void => {
      if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      error ? reject(error) : resolve({ status: 'mcp-handshake-passed', tools, nativeAgentVerified: false });
    };
    const timer = setTimeout(() => finish(new Error('MCP startup timed out; check project/state/enrollment bindings')), 10000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    const lines = createInterface({ input: child.stdout });
    child.stderr.on('data', () => {}); child.once('error', () => finish(new Error('Could not start installed Node/MCP runtime')));
    child.once('exit', () => finish(new Error('MCP exited before tool discovery; check project/state/enrollment bindings')));
    child.stdin.on('error', () => finish(new Error('MCP input closed before handshake completed')));
    lines.on('line', line => {
      bytes += Buffer.byteLength(line); if (bytes > 2_000_000) return finish(new Error('MCP response exceeded setup quota'));
      try {
        const m = JSON.parse(line);
        if (m.error) return finish(new Error('MCP rejected setup handshake'));
        if (m.id === 1) { if (!m.result?.serverInfo) return finish(new Error('Invalid MCP initialization response')); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
        if (m.id === 2) { if (!Array.isArray(m.result?.tools) || !m.result.tools.some((t: { name?: string }) => t.name?.startsWith('agentlink_'))) return finish(new Error('AgentLink tools missing')); finish(undefined, m.result.tools.length); }
      } catch { finish(new Error('Invalid MCP JSON response')); }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentlink-setup-check', version: '1' } } });
  });
}
