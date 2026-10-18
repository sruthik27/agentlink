# Install and connect your coding agent

For agent-operated installation, paste the [README installation prompt](../README.md#let-your-agent-set-it-up) into your current coding session. It installs the official package, configures that harness and verifies readiness; [scope and follow-up](agent-install.md).

Project configuration flags `--write`, `--config` and `--check` are available in version 0.3.0+.

Requires Node.js 20+ and an MCP-capable coding agent. In each project:

```sh
npm install -g @sruthik/agentlink
agentlink setup --harness copilot --write --check
copilot
```

Choose your agent instead of `copilot`:

| Harness | Project configuration | Next step |
| --- | --- | --- |
| `copilot` | `.mcp.json` | Start Copilot in the trusted repo; inspect `/mcp` |
| `claude-code` | `.mcp.json` | Start Claude in the repo; approve project MCP loading |
| `codex` | `.codex/config.toml` | Start Codex in the trusted repo; inspect MCP tools |
| `gemini` | `.gemini/settings.json` | Start Gemini in the repo; inspect `/mcp` |
| `opencode` | `opencode.json` | Start OpenCode in the repo; inspect MCP status |
| `stdio` | Definition printed only | Copy the definition into your MCP client |

Preview without writing: `agentlink setup --harness copilot --config`. Any client supporting local stdio MCP can use `--harness stdio --config`; clients use different configuration schemas, so wrap the server definition as your client requires. Agents without MCP can use the standalone CLI.

Setup uses absolute paths to the installed Node runtime and AgentLink launcher, bound to this exact project. It does not rely on an IDE's PATH or startup directory. Re-run preview after moving the repo or changing/removing the Node/package installation. Prefer a persistent installation over an evictable `npx` cache for saved configuration.

The writer merges only the AgentLink entry, preserves other configuration, backs up original bytes before a merge, refuses symlinks/malformed or oversized files, and never replaces a different existing AgentLink entry. Existing Codex TOML, OpenCode JSONC and bare Copilot maps require an explicit merge of the printed entry to preserve unrelated settings/comments. Running setup again with the same config is a no-op.

`--check` performs a real MCP initialize/tools-list exchange without a coding-agent account or model call. Starting MCP creates local workspace/actor metadata. It proves the installed server starts and advertises tools; verify native tool loading in your actual agent next. It does not bypass folder trust, tool approvals, enterprise allowlists or login. MCP support alone does not provide idle wake.

## Two machines

For the ordinary flow, tell your agent to connect to the developer at their IP. It uses `agentlink connect --to Alice --ip <ip>` and returns one short-lived code; the other developer gives that code to their agent, which runs `agentlink connect --code <code>`. Identities, scoped communication grants and listeners are managed automatically for those current projects. This works through the CLI in an existing terminal-capable agent or `agentlink_connect` in an already attached MCP session. See [connect by code](connect.md) for the complete flow and reachability limits.

The low-level commands remain available for custom deployments: each owner initializes a node, exchanges and verifies public identities, pairs routes, exposes a local actor and grants finite scoped access. See [network foundation](network-foundation.md). The `setup` command itself only configures MCP; it does not create network trust/grants, renew permissions, change identities or launch a daemon.

After that, connect an agent to existing network state without copying a script:

```sh
agentlink setup --harness copilot --state-root /absolute/private/node-state --write --check
```

For an already authorized native wake enrollment, add `--wake-config /absolute/private/node-state/wake/enrollment.json`. Its project/actor/state binding and expiry must match; setup does not enroll or extend it. See [network wake](network-wake.md) for supported adapters. Copilot/Gemini MCP setup does not claim automatic idle-wake adapters for those agents.

## Troubleshooting

If configuration conflicts, run `--config` and merge the proposed entry deliberately. For startup failure check the absolute Node/package/project paths, then `agentlink doctor` (local) or `agentlink network doctor --state-root /absolute/private/node-state` (network). Inspect the agent's native MCP status and trust policy. Transport receipt, MCP startup, native processing and automatic wake are distinct checks.

Formats checked against [Copilot CLI docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers), [Codex MCP docs](https://developers.openai.com/codex/mcp/), [Gemini MCP docs](https://geminicli.com/docs/tools/mcp-server/), and [OpenCode MCP docs](https://opencode.ai/docs/mcp-servers/). Generated configuration and handshake tests cover these definitions. Actual native-client acceptance is recorded separately and must not be inferred for every listed harness.
