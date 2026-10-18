import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// A fixed project binding works even when an MCP host launches from another cwd.
async function main(): Promise<void> {
  const options: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--workspace', '--state-root', '--wake-config'].includes(name) || !value || !isAbsolute(value) || options[name]) throw new Error('Usage: launch --workspace <absolute-path> [--state-root <absolute-path>] [--wake-config <absolute-path>]');
    options[name] = await realpath(value);
  }
  if (!options['--workspace'] || (options['--wake-config'] && !options['--state-root'])) throw new Error('A workspace is required; wake config also requires state root');
  for (const name of ['AGENTLINK_NETWORK_STATE_ROOT', 'AGENTLINK_WAKE_CONFIG', 'AGENTLINK_PARTICIPANT_ID', 'AGENTLINK_WAKE_JOB_ID']) delete process.env[name];
  process.chdir(options['--workspace']);
  if (options['--state-root']) process.env.AGENTLINK_NETWORK_STATE_ROOT = options['--state-root'];
  if (options['--wake-config']) process.env.AGENTLINK_WAKE_CONFIG = options['--wake-config'];
  const { serveStdio } = await import('./server.js');
  await serveStdio();
}
main().catch(() => { console.error('AgentLink MCP startup failed; verify project, state root and enrollment bindings with agentlink doctor/network doctor.'); process.exitCode = 1; });
