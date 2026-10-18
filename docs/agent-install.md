# Install once for your user

Paste the [README installation prompt](../README.md#let-your-agent-set-it-up) into your coding agent. It installs `@sruthik/agentlink` and configures the current harness's user-wide MCP entry. You do not need to repeat installation in each repository. Node.js 20+ and npm are required; direct connections also need OpenSSL.

## User-wide setup (0.3.1+)

```sh
npm install -g @sruthik/agentlink@latest --prefer-online
agentlink setup --harness claude-code --scope user --write --check
# Or codex, copilot, gemini, opencode
```

The generated entry uses absolute Node/package paths and the session-aware launcher. It contains no fixed project directory, network state root, actor or wake enrollment. Each MCP process advertises `agentlink_session`; the agent binds its actual session working directory before using project tools. This does not require human setup in each repo. Separate sessions can work in separate repos concurrently. A single bound MCP process cannot switch projects; if a host shares one process across sessions, it must provide separate server instances or the agents can use the CLI from their own working directories.

Starting the user-wide server or checking its handshake does not create `.agentlink` state in the harness's home/config directory. Project metadata is created only when the agent explicitly binds its local session workspace. Harnesses may need one reconnect and normal tool/trust approval. The CLI remains immediately available in terminal-capable sessions.

See [setup locations and compatibility](setup.md). A project-scoped entry may shadow the user entry; deliberately migrate only the old AgentLink entry if necessary, preserving all other settings. Use `--scope project` when you intentionally want one fixed workspace or an advanced project-specific network/wake enrollment. User scope is for the current harness, not automatic installation in every unrelated application.

## After pairing

Tell your agent the other developer's actual reachable IP, privately share the generated `AL1-...` code, and have their agent accept. Both owners choose their own current workspace. Connection codes expire after ten minutes; communication lasts at most two hours without automatic renewal.

The agent should read pending messages and automatically start the returned `connect monitor` command through a native Monitor/background facility that wakes the same session on stdout, when available. It should process incoming references through `receive`, reply substantively and retain the audit cursor. Re-arm within the same expiry if the native monitor's own deadline ends. Do not ask the human to repeatedly check an inbox. A detached terminal watcher cannot by itself wake an idle model; without a compatible native consumer, the agent can use active bounded waits. No competing worker or automatic grant renewal is created.

Pairing grants communication only. Repository changes and command execution require local owner authorization. See [connect by code](connect.md) and [wake support](network-wake.md).
