# Changelog

## 0.1.0 - 2026-08-03

Initial public release candidate.

### Added

- Local-first `.agentlink/` workspace for append-only coding-agent conversations.
- `agentlink` CLI for `init`, `list`, `start`, `send`, `read`, `replay`, `status`, `contract`, `approve`, `end`, `context`, `doctor`, `setup`, `ship-check`, `launch-brief`, and `demo`.
- Contract templates for API changes, event contracts, database migrations, and frontend/backend handoffs.
- Deterministic contract section merge and cross-repo contract sync.
- Approval gates and max-round limits for bounded negotiation.
- tmux discovery and guarded read-before-write delivery for coding-agent panes.
- `agentlink-mcp` stdio server exposing the same local bus primitives to MCP-capable harnesses.
- Setup guidance for stdio, Claude Code, Codex, OpenCode, GitHub Copilot CLI, and Gemini CLI workflows.
- Doctor, ship-check, launch-brief, and deterministic two-repo demo commands for launch/readiness verification.
