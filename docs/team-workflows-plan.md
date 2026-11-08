# Team agent workflows: implementation and acceptance

AgentLink should let coding agents hand off work, review and repair changes, delegate related tasks, and synthesize independent investigations. Humans supply goals and local delegated authority; they should not relay intermediate messages or repeatedly restart consumers.

This plan tracks the complete upgrade. Passing a component test is not completion of the product goal.

The current development branch implements the four work kinds, connection CLI/MCP,
durable inbox/routes and session recovery, native Monitor/channel protocol adapters,
same-peer reconnect with explicit finite owner authorization, and bounded retention.
Isolated installed-package fixtures exercise all four workflows. Native model wake,
physical-host acceptance and publication remain separate gates; no protocol receipt
or test subprocess is counted as a model turn.

| Requirement | Required implementation | Acceptance evidence |
| --- | --- | --- |
| One simple workflow surface | Connection-scoped work-item CLI and MCP, no private state-root arguments | Actual installed one-code workflow for all four intents |
| Durable work | Recipient-owned work items, lifecycle, idempotent operations, restart/resume | Sender offline after accepted handoff; recipient completes and sender reconciles |
| Delegated authority | Local standing policy, separate read vs edit/test, revocation and expiry | In-policy work proceeds without repeated approvals; out-of-policy actions block |
| Actual shared work | Selected versioned files/diffs, content-addressed artifacts and retrieval | Dirty changes and evidence transferred, independently verified, reviewed by exact version |
| Review and repair | Stable findings, current artifact revisions, changes-requested and independent verification | At least two repair/review rounds with no human relaying |
| Delegation | Accept/decline, progress/blockers, dependencies, completion evidence | Related task delegated, dependency handled and result integrated |
| Investigation | Independent evidence, hypotheses, experiments and exact conclusion approvals | Contradiction resolved by experiment; remaining uncertainty retained |
| Consumption | Durable cursors, consumer/session identity, exclusive claims, leases and uncertain recovery | Busy/closed/restarted sessions; duplicate delivery does not silently duplicate work |
| Team routing and continuity | Stable peer relationship separate from session; availability and reconnect | Concurrent sessions in one repo; correct recipient routing and resumption |
| Bounded storage | Archive completed work, retain replay protection; no manual state-root replacement | Limits exercised without losing active work or deduplication |
| Positioning and setup | Installation prompt, README and website teach agent workflows | User sees install → connect → collaborate; capability limits remain explicit |
| Native acceptance | Real supported harnesses and physical hosts | Actual correlated agent/tool turns, artifacts, test reruns and owner-policy compliance |

Existing finite grants and pilot permissions remain unchanged. No old worker or enrollment is restarted by this implementation. Distribution and physical-host acceptance must be recorded separately.
