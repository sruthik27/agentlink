# Team collaboration experience upgrade

Scope authorized: all five improvements from the product review. Implementation
and tests must establish the complete behavior before this upgrade is complete.

| Feature | Required behavior | Acceptance |
| --- | --- | --- |
| Context packaging | Gather authorized selected changes, repository/base identity, decisions, next action and actual local check evidence into verified retrievable artifacts | Dirty tracked/untracked/deleted and binary files; out-of-scope exclusion; no hooks/filters; digest-bound manifest; installed CLI/MCP |
| Verified integration | Apply the selected package into an isolated receiving worktree, detect base conflicts, run locally registered checks, return exact output/evidence | Dirty original preserved; conflict has no partial integration; check success/failure/timeout and uncertain execution recorded; no automatic commit/merge |
| Collaboration budgets | Bound rounds, repeated disagreement and elapsed collaboration; preserve cancellation/recovery and present one concise escalation | Limits enforced on authoritative transitions, restart survives, exact owner-authorized budget update, no repeated escalation noise |
| Team directory and capability routing | Resolve human-readable peer/project/route aliases using pinned relationships and advertised capabilities/availability | Local-only alias administration, no remote trust creation, ambiguous/offline/expired routing explicit; named create through CLI/MCP |
| Compact activity view | Show owner, findings, blockers, delivery/observation/processing and next action across connections | Readable terminal view and structured agent data; stale/offline sources explicit; no transport-as-completion inference |

The existing reliability implementation and dirty canonical worktree are preserved.
All new automatic local reads/edits/checks must stay within standing owner policy.
No old pilot grants, workers, global installations or publication are changed.
Native/physical acceptance and release remain separate from protocol fixtures.

## Verification evidence

The full suite covers 211 tests. Focused routing/budget tests additionally exercise
ambiguous routes, capability mismatch, corrupt directory metadata, changed pins,
total round limits, repeated findings, elapsed limits and stable owner notices.
Package/integration tests cover real patches and checks, binary/add/delete changes,
dirty checkout preservation, timeouts, Git metadata changes, selected input
mutation, conflicts, idempotent receipts and refusal to discard extra local files.
Storage tests verify integration pinning and the post-release evidence window.

`node scripts/verify-team-experience-installed.mjs` packs and installs an isolated
archive, then uses two real global MCP sessions and the installed CLI. It checks
all five features together, a recipient check, returned result verification by
the sender, matching check packaging, budget escalation and local owner CLI
authorization, activity phases, and evidence-bound worktree release.
`node scripts/verify-team-workflows-installed.mjs` rechecks the original four
workflows, sender-offline completion, inbox, reconnect and retention. Both archive
hashes must agree with the candidate in the release gate.

Development evidence is retained in `.hermes/team-workflows/`; it is excluded from
the distributable. Native model wake, physical-host acceptance, publication and
the broader release gates are not established by these local fixtures.
