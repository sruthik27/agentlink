## AgentLink 0.2.0

**Distribution:** npm and GitHub availability are verified separately. Check [npm](https://www.npmjs.com/package/@sruthik/agentlink) for the registry version and [GitHub Releases](https://github.com/sruthik27/agentlink/releases/tag/v0.2.0) for the release tarball. Do not infer npm availability from a GitHub release.

AgentLink 0.2.0 turns the local cross-repo coordination prototype into a durability-focused release. It adds stable participant identity, explicit shared-bus association, revision-bound contract approval, durable inbox cursors and acknowledgements, safe target selection, trusted notifications, crash recovery, and an opt-in supervised Codex runner.

### Highlights

- Coordinate two or more repositories through one explicit authoritative local bus without filesystem crawling.
- Keep contracts conversation-scoped and advance them through Draft, Proposed, Accepted, Implemented, and Verified with current-revision, eligible-participant approval gates.
- Page and acknowledge durable messages independently, preserve body/kind/reference fidelity, and fail ambiguous targeting with actionable candidate IDs.
- Recover contract/timeline/compatibility writes after interruption, keep generated projection metadata consistent with its exact bytes, and serialize concurrent initialization, association, registration, contract updates, and message appends.
- Enroll a supervised/headless Codex recipient explicitly, queue exact message references, resume its saved conversation thread, and acknowledge work only after correlated recipient status evidence.

### Migration from 0.1.1

Migration runs automatically on first access and is non-destructive. Legacy conversation logs are copied into the authoritative bus, marked legacy contracts are associated only with their named conversation, unmarked contracts are preserved unassigned, and completed import digests prevent later writes from rerunning the import. Back up `.agentlink/` before changing ignore rules or moving the authority checkout. Copied workspaces with a stale canonical identity require `agentlink init --new-workspace`.

### Safe targeting

Pass explicit conversation IDs whenever more than one candidate exists. Ambiguous read, send, join, or approve requests fail with candidate IDs; closing always requires an explicit conversation ID. Stable participant IDs, not caller-supplied labels, determine sender and approval authority.

### Opt-in wake and support boundary

Automatic wake is opt-in and supported only for an explicitly enrolled **supervised/headless Codex** runner whose executable, workspace, bus, participant, registration, and allowed conversations are bound in user-owned configuration. It does not wake arbitrary GUI or IDE sessions, interactive Codex sessions, Claude Code, or generic tmux panes. Those paths are unsupported, not implicitly verified.

### Verification before release

The current candidate source passes the 111-test TypeScript suite, focused shutdown/registry/crash-reopen/actor/ack/timeout regressions, five repeated paired shutdown runs, and the installed packed-artifact MCP reliability harness (14/14 mandatory rows). The exact lock stress passed 50/50 trials with eight independent processes and zero overlapping critical sections. Deterministic RED/GREEN regressions prove both that a delayed reclaimer cannot carry a dead-owner decision onto a fresh lock incarnation and that orphan cleanup cannot delete a replacement reclaim-claim incarnation. Focused dead-owner, multi-generation orphan, live-claim, symlink, and competing-reclaimer coverage remains intact.

Real installed-artifact native Codex acceptance passed two tasks, saved-thread resume, restart/deduplication, correlated result messages and durable acknowledgement. Real OpenCode MCP acceptance passed owner proposal, distinct peer review/approval, resumed-owner acceptance, equal synced contract bytes, resumed peer execution and durable acknowledgements from both actors. Final distribution archives are gated on fresh installed/native checks after documentation changes.

### Known limitation

The packed MCP reliability harness uses real installed CLI/MCP processes but no LLM. Separate actual-client tests cover supervised/headless Codex and OpenCode MCP coordination. No all-harness claim is made for Claude Code, GUI/IDE idle wake, arbitrary interactive sessions, or every setup target documented by AgentLink.

### Install from an available distribution channel

```bash
npm install -g @sruthik/agentlink@0.2.0
agentlink version
agentlink doctor
```

The npm command requires 0.2.0 to be listed in the registry. If npm publication is pending, install the verified GitHub release tarball instead:

```bash
npm install -g https://github.com/sruthik27/agentlink/releases/download/v0.2.0/sruthik-agentlink-0.2.0.tgz
agentlink version
```

Use this URL only after the GitHub release is available. GitHub Actions tests are account-billing blocked; no CI PASS is claimed.
