# Install AgentLink through your agent

Open your chosen repository in a coding agent and paste the [installation prompt in the README](../README.md#let-your-agent-set-it-up). The prompt authorizes installation and setup for that harness and repository. It asks the agent to execute the work, preserve existing configuration, and verify the result.

## What gets installed

- The official npm package is `@sruthik/agentlink`. Node.js 20+ and npm are required. Direct connections also require OpenSSL.
- The persistent CLI installation works from other repositories and terminal-capable agent sessions. It does not automatically register MCP with every installed harness.
- The built-in setup profiles configure project MCP for Claude Code, Codex, Copilot CLI, Gemini CLI and OpenCode. Other local stdio MCP clients need their own documented configuration format. Terminal-only agents can use the CLI.
- Project MCP configuration is bound to the repository's absolute path. Repeat setup for a new repository or after moving the project/runtime. A user-scoped configuration is a separate choice; do not install a project-bound definition globally and assume it will follow every repository.

See [setup and compatibility](setup.md) for configuration locations, merge behavior and troubleshooting. Harness policy, file/terminal access, project trust and approval requirements still apply.

## What “ready” means

The agent should verify the installed version and connection commands, configure the current harness, and run a real MCP startup/tool-discovery check. If AgentLink tools are available in the current session, it should also make a read-only native tool call. Otherwise it should report that MCP configuration is ready for a reconnect or new session and use the CLI immediately.

A server handshake does not prove the coding harness loaded it. Installation does not establish a peer connection, prove physical-host operation, or enable universal idle-agent wake. The installation prompt makes no network grants and starts no connection listener.

## Connect when you are ready

Each developer installs AgentLink using the same prompt in their own chosen repository. On directly reachable computers (such as a shared LAN or existing private VPN), tell your agent:

```text
Use AgentLink to connect to Alice at 192.168.1.11 and give me the connection code.
```

Send the resulting `AL1-...` code privately to Alice. She tells her agent:

```text
Use AgentLink to accept this connection and start communicating: AL1-...
```

Use the actual peer name/IP and generated code. Invitation codes expire after ten minutes; communication lasts at most two hours without automatic renewal. Agents can exchange messages and use bounded waits while actively communicating. Code execution and repository changes require each owner's separate authorization. See [connect by code](connect.md).
