## AgentLink 0.1.0

Initial public release.

AgentLink is a local-first coordination bus for coding-agent harnesses working across related repositories. The core wedge is cross-repo contract negotiation: agents exchange compact structured messages, update durable `.agentlink/CONTRACT.md` artifacts, and keep repo-specific context isolated.

### Highlights

- `agentlink` CLI for local conversation, contract, approval, setup, doctor, ship-check, and demo workflows.
- `agentlink-mcp` stdio MCP server exposing the same bus primitives to MCP-capable coding harnesses, including Codex newline-delimited JSON-RPC framing.
- Durable append-only `.agentlink/conversations/*.jsonl` message store.
- Deterministic contract templates for API changes, events, DB migrations, and frontend/backend handoffs.
- Contract section merge, cross-repo contract sync, approval gates, and max-round limits.
- tmux discovery and guarded read-before-write pane delivery for live coding-agent sessions.
- Harness setup guidance for stdio, Claude Code, Codex, OpenCode, GitHub Copilot CLI, and Gemini CLI.
- `doctor`, `ship-check`, `launch-brief`, and deterministic two-repo demo commands for local readiness verification.

### Install

```bash
npm install -g agentlink
npx agentlink doctor
codex mcp add agentlink -- agentlink-mcp
agentlink setup --harness all
```

### Verification before release

- `npm test` passed locally: 52/52 tests.
- `node dist/cli.js ship-check --format json` passed locally as parseable JSON with 18/18 readiness checks OK.
- Packed tarball smoke verifies `npm pack --ignore-scripts` contents, installed `agentlink version`, and `agentlink-mcp` stdio initialize/version from the installed package.
- Real Codex MCP workflow was exercised against the installed `agentlink-mcp`: Codex started an AgentLink conversation, sent a proposal, updated the API contract, recorded approvals, accepted, and synced the contract through MCP tools.

### Known limitation

GitHub Actions did not run because the GitHub account is currently locked for Actions due to a billing issue. Local verification passed.
