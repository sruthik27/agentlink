# Changelog

## 0.2.0 - 2026-10-04

Durable cross-repo reliability and an opt-in supervised/headless Codex wake path. Distribution availability is recorded separately by npm and GitHub Releases.

### Added

- Stable workspace and participant identities, explicit bus association, expiring registrations, actor pinning, revocation, durable cursors/acknowledgements, safe explicit targeting, message caps, trusted notifications, and crash-recoverable multi-file transactions.
- Conversation-scoped contracts with revision-bound eligible approvals, generated compatibility views, deterministic section updates, and the full Draft-to-Verified lifecycle.
- Opt-in supervised/headless Codex enrollment with durable queues, ordered recovery, exact-message completion evidence, bounded retries, thread resume, and process-group shutdown.
- A packed-artifact, two-repository MCP reliability harness covering 14 mandatory rows independently of native model execution.

### Changed

- Migrates 0.1.1 workspace data non-destructively and records completed imports so later authoritative writes do not retrigger legacy migration.
- Ambiguous operations fail with candidate IDs; close and other consequential operations require explicit conversation targets.
- Core coordination no longer depends on tmux. tmux remains an optional notification/bridge capability.

### Fixed

- Closed cross-process initialization, registry/association, target-registration/bus-switch, actor-rebinding, out-of-order acknowledgement, notification timeout, and supervisor shutdown races identified during reliability review.
- Replaced publication-before-owner lock directories with complete PID/token owner records published atomically by hard link. Reclamation now serializes through a fully published claim and re-evaluates the current incarnation, preventing stale dead-owner decisions from removing a replacement lock.
- Made reclaim claims incarnation-specific and append-only during recovery. Crashed claimants are superseded through immutable successor identities, so orphan cleanup and release no longer perform ownership-blind read-then-remove operations on a reusable claim pathname.
- Distinguished a clean stale generated contract projection from a genuine local edit by recording the exact generated-byte digest, with conservative fallback for older digest-less metadata.
- Journaled selected-conversation metadata and generated compatibility bytes together so an interrupted selection recovers a matching projection.

### Support boundary

- Automatic idle wake is supported only for an explicitly enrolled supervised/headless Codex runner. Arbitrary GUI or IDE sessions, interactive Codex sessions, Claude Code idle wake, and generic tmux panes are unsupported.
- Actual-client verification covers supervised/headless Codex wake/restart/durable acknowledgement and OpenCode MCP negotiation, revision-bound approval, contract sync, explicit session resume and durable acknowledgement. It does not verify automatic idle wake in OpenCode, Claude or arbitrary GUI/IDE sessions.
- Local suite: 111/111. Lock contention: 50/50 eight-process trials. Installed MCP reliability: 14/14 mandatory rows. GitHub Actions tests are account-billing blocked and are not claimed as passing.

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
