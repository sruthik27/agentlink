# Install and connect your coding agent

For agent-operated installation, paste the [README installation prompt](../README.md#let-your-agent-set-it-up) into your current coding session. It installs the official package, configures that harness and verifies readiness; [scope and follow-up](agent-install.md).

Project configuration flags `--write`, `--config` and `--check` are available in version 0.3.0+.

Requires Node.js 20+. Terminal-capable agents can use the CLI immediately. For MCP, the recommended 0.3.1+ setup is once per user/harness:

```sh
npm install -g @sruthik/agentlink
agentlink setup --harness copilot --scope user --write --check
copilot
```

Choose your agent instead of `copilot`:

| Harness | User configuration | Optional project configuration |
| --- | --- | --- |
| `claude-code` | `~/.claude.json` | `.mcp.json` |
| `codex` | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `.codex/config.toml` |
| `copilot` | `$COPILOT_HOME/mcp-config.json` or `~/.copilot/mcp-config.json` | `.mcp.json` |
| `gemini` | `~/.gemini/settings.json` | `.gemini/settings.json` |
| `opencode` | `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json` | `opencode.json` |
| `stdio` | Definition printed for the client's user configuration | Definition printed only |

Preview: `agentlink setup --harness copilot --scope user --config`. Use `--scope project` to intentionally configure one fixed repository. Omitting scope keeps the original project mode for compatibility. Version 0.3.0 supports project setup; version 0.3.1 adds user scope.

User-wide entries use absolute runtime paths plus `--session`, without a fixed repo path. The agent uses the advertised `agentlink_session` tool to select its actual working directory automatically at first use. Workspace/actor binding stays pinned to that MCP process, so simultaneous independent sessions stay isolated. It does not infer a repository from the harness's config directory or discover unrelated workspaces. If a host shares one MCP process across projects, use separate server instances or the CLI for those projects. Reconnect existing sessions once to load newly installed tools; no per-repo installation is needed.

Project entries retain the fixed absolute workspace launcher. Re-run project setup after moving that repo. For both scopes, keep the installed Node/package paths available and use a persistent install instead of an evictable `npx` cache.

The writer merges only AgentLink, preserves unrelated configuration, backs up original bytes, refuses symlinks/malformed or oversized files, and never replaces a conflicting entry. Existing Codex TOML, OpenCode JSONC and bare Copilot maps require an explicit merge. Custom `CLAUDE_CONFIG_DIR` requires the native Claude user-scope command with the generated stdio definition rather than guessing a config path. Client-specific command-line config overrides must also be handled using that client's documented config location. Existing project entries can shadow global entries; inspect and migrate only the relevant AgentLink entry deliberately.

`--check` performs a real MCP initialize/tools-list exchange without a coding-agent account or model call. Project MCP startup creates workspace/actor metadata; user-wide startup defers this until session binding. It proves the installed server starts and advertises tools; verify native tool loading in your actual agent next. It does not bypass folder trust, tool approvals, enterprise allowlists or login. MCP support alone does not provide idle wake.

## Two machines

For the ordinary flow, tell your agent to connect to the developer at their IP. It uses `agentlink connect --to Alice --ip <ip>` and returns one short-lived code; the other developer gives that code to their agent, which runs `agentlink connect --code <code>`. Identities, scoped communication grants and listeners are managed automatically for those current projects. This works through the CLI in an existing terminal-capable agent or `agentlink_connect` in an already attached MCP session. See [connect by code](connect.md) for the complete flow and reachability limits.

The low-level commands remain available for custom deployments: each owner initializes a node, exchanges and verifies public identities, pairs routes, exposes a local actor and grants finite scoped access. See [network foundation](network-foundation.md). The `setup` command itself only configures MCP; it does not create network trust/grants, renew permissions, change identities or launch a daemon.

After that, connect an agent to existing network state without copying a script:

```sh
agentlink setup --harness copilot --state-root /absolute/private/node-state --write --check
```

For an already authorized native wake enrollment, add `--wake-config /absolute/private/node-state/wake/enrollment.json`. Its project/actor/state binding and expiry must match; setup does not enroll or extend it. See [network wake](network-wake.md) for supported adapters. Copilot/Gemini MCP setup does not claim automatic idle-wake adapters for those agents.

## Troubleshooting

If configuration conflicts, run `--config` and merge the proposed entry deliberately. For startup failure check the absolute Node/package/project paths, then `agentlink doctor` (local) or `agentlink network doctor --state-root /absolute/private/node-state` (network). Inspect the agent's native MCP status and trust policy. Transport receipt, MCP startup, native processing and automatic wake are distinct checks. Connection consumers can be started by the agent through a compatible native Monitor/background tool; no universal idle-wake claim is implied.

Formats checked against [Copilot CLI docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers), [Codex MCP docs](https://developers.openai.com/codex/mcp/), [Gemini MCP docs](https://geminicli.com/docs/tools/mcp-server/), and [OpenCode MCP docs](https://opencode.ai/docs/mcp-servers/). Generated configuration and handshake tests cover these definitions. Actual native-client acceptance is recorded separately and must not be inferred for every listed harness.

User-scope references: [Claude scopes](https://code.claude.com/docs/en/mcp#user-scope), [Copilot configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference), [Gemini user configuration](https://geminicli.com/docs/reference/configuration/) and [OpenCode global configuration](https://opencode.ai/docs/config/).
