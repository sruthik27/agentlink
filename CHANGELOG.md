# Changelog

## 0.1.1 - 2026-09-21

Patch release correcting the npm package identity to `@sruthik/agentlink`.

### Changed

- Renamed the npm package from `agentlink` to `@sruthik/agentlink` while preserving the `agentlink` and `agentlink-mcp` executable names.
- Updated setup guidance, README install commands, ship checks, fixtures, and release metadata for the scoped package.

### Fixed

- Aligned version-derived release notes and packed-package checks with version 0.1.1.
- Ensured `doctor` recognizes the scoped AgentLink package when validating required npm scripts.

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
- README demo GIF/cast packaging gates plus npm tarball dry-run, executable bin, installed CLI, and installed MCP stdio smoke checks in `ship-check`.
