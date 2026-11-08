# Durable work for team agents

**Available in the 0.4.0 beta testing release.** The work engine,
connection client, durable inbox, routing/recovery, reconnect and storage lifecycle
have local process and isolated installed-package tests. Actual native model wake
and physical-host acceptance remain open in [the acceptance plan](team-workflows-plan.md).

AgentLink is intended to carry a collaboration from intent through evidence and
review. Humans supply goals and local delegated authority; agents supply context,
do the work, exchange findings and reconcile results.

| Intent | What the work item carries |
| --- | --- |
| Hand off and leave | Goal, context, next action, selected artifacts, acceptance criteria and recipient ownership |
| Review and repair | Actual versioned artifacts, stable finding IDs, repair revisions and independent acceptance |
| Delegate | Scope, dependencies, acceptance/decline, exclusive claim, progress, blockers and completion evidence |
| Compare investigations | Independent observations/hypotheses/experiments, contradictions, uncertainty and exact conclusion approvals |

## Agent access

Use the existing connection ID. The agent does not need a private state-root path,
certificate, actor override or second network configuration.

Global MCP sessions bind their local workspace with `agentlink_session` and use
`agentlink_work`. Each MCP process has its own live work session identity. It cannot
take over another live session's claim by copying a lease token.

Terminal agents generate an ID once per live session:

```sh
agentlink work session
agentlink work --connection CONNECTION --session SESSION --request '{"action":"list","location":"local","offset":0,"includeArchived":false}'
```

The JSON request has the same fields as the MCP tool, except `connection` is supplied
by the CLI flag. All mutations use a stable `requestId`; operations additionally
bind the current `expectedVersion`. Identity, workspace and storage are resolved
locally from the connection. Unexpected fields are rejected.

## Create a handoff

First export explicit selected files using `export(path,policyId)`, or create a
literal artifact with `artifact-create(name,content,mediaType)`. Literal content
does not read any local files. File export requires an existing local read policy
for those paths and that peer. Artifacts are bounded to 1 MiB each and transferred
in verified 32768-byte chunks; hashes identify actual retrievable bytes.

Then send `create` with a draft like this, substituting the artifact references:

```json
{
  "action": "create",
  "requestId": "handoff-parser-1",
  "work": {
    "id": "parser-fix",
    "kind": "handoff",
    "title": "Finish the parser fix",
    "goal": "Handle the captured failing input",
    "criteria": ["The reproduction passes", "Existing parser checks pass"],
    "scope": {"paths": ["src/parser", "tests/parser"], "permissions": ["read", "edit", "test"], "checks": ["parser-tests"]},
    "reviewRequired": true,
    "dependencies": [],
    "context": {"summary": "What changed, why, and what is still uncertain", "nextAction": "Inspect the attached patch and reproduction", "artifacts": []}
  }
}
```

The recipient stores the authoritative item and accepts or declines it. Acceptance
does not grant execution. Once accepted under a local standing policy, the
recipient can work without contacting the sender. The sender's cached copy is
separate and never authorizes local execution.

## Read, act and reconcile

- `get(id,location)` reads `local` recipient authority, `peer` current remote work,
  or explicitly stale `cache`. A failed remote read never silently substitutes cache.
- `list(location,offset,includeArchived)` pages local or peer work separately.
- `operate(id,location,operation)` applies a versioned operation. Local operations
  also take `policyId`, using `null` for metadata-only actions.
- `artifact(id,location,artifact,offset)` reads verified artifact chunks.
- `reconcile(requestId)` reads peer evidence for an uncertain outbound request.
  It does not resend it. Absence of a receipt remains uncertain.

Operation fields below are **in addition to** `type`, `requestId` and
`expectedVersion`. Fields must match the operation exactly.

| Operation | Additional fields |
| --- | --- |
| accept, resume | none |
| decline, complete, cancel, comment | summary |
| claim | leaseSeconds (5–300) |
| renew | leaseToken, leaseSeconds |
| release, progress, block, cancelled | leaseToken, summary |
| recover | evidence (artifact), summary |
| submit | leaseToken, artifacts, testArtifact, summary |
| revise | artifacts, testArtifact, summary |
| review | revision, digest, accepted, findings, evidence, leaseToken (null when no claim exists) |
| contribute | id, kind, content, artifacts |
| conclude | content, evidenceIds, uncertainties, unresolvedIds, resolutions |
| approve-conclusion | revision, digest |

Local recipient execution uses a claim pinned to its live session. Expired claims
require explicit evidence-based recovery; they are not silently stolen or replayed.
The recipient can release or report a blocker even after execution authority is
revoked. The origin requests cancellation; the recipient confirms it.

Reviews bind the current output revision and digest. Findings have stable
`id`, `content`, and `status` (`open`, `resolved`, `dismissed`). Open findings
prevent acceptance. The output author cannot approve its own work. A `review`
work item lets its originating author `revise` actual artifacts for another round;
a delegated implementation returns to the recipient for repairs.

Investigation contributions use kind `observation`, `hypothesis`, `experiment`,
`contradiction`, or `uncertainty`. Both parties contribute before a conclusion.
Each contradiction is resolved by an experiment with an artifact or retained in
`unresolvedIds`. Resolutions contain `contradictionId`, `experimentId`, and
`explanation`. Both parties approve the exact conclusion revision/digest. New
evidence invalidates obsolete approvals. Agreement is not proof of correctness.

## Local delegated authority

Only the local owner administers standing policies through the CLI. Neither the
wire work protocol nor the MCP work tool can create or renew them.

```sh
agentlink work policy grant --connection CONNECTION --id team-parser --paths src/parser,tests/parser --allow read,edit,test --checks parser-tests --ttl 2h
agentlink work policy show --connection CONNECTION --id team-parser
agentlink work policy revoke --connection CONNECTION --id team-parser
```

The policy is bound to this workspace and peer fingerprint with explicit finite
expiry. Check IDs identify locally chosen checks, not peer-supplied shell commands.
Policies authorize eligible workflow actions; they are not an OS sandbox or an
automatic code runner. The receiving harness remains responsible for enforcing
its own execution rules. No automatic policy or communication renewal occurs.

## Current limits

The existing connection still needs direct IP reachability and finite communication
authorization. Closing a sender model session is distinct from shutting down its
host: accepted recipient work survives both, but sender reconciliation requires a
reachable recipient and valid communication authorization.

The tool stores state and evidence; it does not itself perform model turns or wake
an idle coding harness. Keep autonomous work claims separate from transport receipts.
Native consumers must be verified on the actual harness before promising unattended
review loops. Installed protocol fixtures cover all four workflows; they do not
establish model correctness or physical-host acceptance. See the acceptance plan
before release.

## Durable inbox and session recovery

After pairing, the agent opens `inbox-open` with `route` (default `main`), `mode`
(`active-poll`, `native-monitor`, or locally enabled `channel`) and `leaseSeconds`
(5–300). One live session owns a route. Other sessions can use separate named
routes; `context.recipientRoute` names the intended recipient queue, and local
`inbox-route(id,location,route)` can override it without changing execution authority.
Moving work preserves its acknowledged cursor.

`inbox-next(route,token)` discovers durable work events and refreshes one bounded
page of peer work. An unreachable or denied peer is reported separately while
local work remains available. Discovery reads the authoritative records, so a
crash between saving work and sending a notification does not lose the work.

Use `inbox-ack(route,token,eventId,deliveryToken,outcome,summary)` for the exact
delivery. `observed` and `blocked` preserve it; `handled` requires a recorded local
work response or a terminal item. Observation alone cannot mark work processed.
Policy changes or relevant work changes rearm blocked delivery. `inbox-status`
reports idle/busy/blocked/offline from current leases, and `inbox-close` preserves
pending delivery while releasing the route.

A new session resumes unacknowledged deliveries with fresh tokens. It also gets a
`resume` event for accepted unfinished work, even if the old session had already
acknowledged the original invitation. A foreign live execution claim is respected;
after expiry the agent must reconcile evidence with `recover` before claiming work.
Restart never authorizes automatic repetition of uncertain execution.

For harnesses with native same-session stdout wake, `inbox-open` returns an exact
`agentlink work monitor` command using this agent's live session ID and actor. The
agent starts it through its native background facility; people need not relay
inbox messages. It emits each pending delivery once and keeps the consumer lease
alive. The agent reads/acts/acknowledges through MCP or CLI. A detached shell
watcher alone does not establish model wake.

For a host that explicitly supports and permits Claude channel notifications,
enable the adapter during local setup:

```sh
agentlink setup --harness claude-code --scope user --config --work-channel
```

The generated launcher uses `--session --work-channel`. It automatically discovers
paired connections in the bound workspace and consumes the available `main` route;
explicit channel routes can also be registered. The host must allow the channel
under its own policy. `--check` verifies the MCP server, not actual model wake.
Other harnesses use native Monitor or active polling; the channel flag is rejected
for incompatible setup targets. No second model worker is started.

## Persistent connection and finite access

Paired identities, work, routes and receipts persist after sessions and helpers
exit. `connect reconnect --connection ID` restarts a crashed helper at its original
listening address within unchanged authorization. Concurrent restart requests
serialize; reads and sends can recover a dead helper before attempting their
operation. Uncertain sends are not automatically replayed. An occupied port,
changed pin, revoked grant, owner stop or expired access prevents recovery.

After an explicit owner stop, use `connect resume --connection ID` only with local
owner intent. After expiry, both local owners can authorize another finite window
for the same paired relationship without sharing another code:

```sh
agentlink connect stop --connection ID
# After the helper has stopped, on each host with that owner's authorization:
agentlink connect authorize --connection ID --request-id access-window-2 --ttl 2h
agentlink connect resume --connection ID
```

The stable request ID records and reconciles the exact owner authorization; an
identical retry does not extend it again. The owner command is not an MCP or wire
grant operation. It preserves peer pins and existing work, rejects revocation or
scope changes, and leaves execution policies untouched. No automatic access
renewal occurs. Changed IPs/occupied addresses still need local route/network
attention; reconnect does not open firewalls, SSH or a relay.

## Retention and storage budgets

Maintenance runs automatically at most hourly during work activity, or explicitly
with the `maintenance` action. Active artifacts remain pinned. Completed artifacts
and unreferenced exports have a 30-day retention period; superseded immutable
snapshots and abandoned partial uploads expire after one day. Terminal metadata,
work IDs and operation receipts remain for deduplication. Completed blob removal
does not allow an old create to recreate or execute the work.

Repeated outbound receipts store compact hashes/version metadata instead of a
full work snapshot each time. Storage has per-connection budgets: 256 MiB of
completed artifacts, at most 32 partial uploads, 128 MiB of work metadata and 4096
retained work items. Safe terminal actions have reserved metadata capacity. At a
hard limit AgentLink fails before allocating new work; it does not silently remove
active data or replay protection. Retention is a bounded local store, not an
unlimited remote mailbox. Fresh exports are needed after retained bytes expire.

## Team collaboration experience (0.4.0)

`agentlink_work` also exposes the following actions in a workspace-bound session.
The installed experience verifier exercises these additions through real MCP
sessions and the CLI. Native model and physical-host acceptance remain separate.

- `package`: supply `connection`, local `policyId`, stable `requestId`, `summary`,
  `decisions` and `nextAction`. Optional `paths` narrows the standing policy.
  It gathers changed tracked/untracked/deleted/binary files, base commit and branch,
  a patch and only actual recorded checks matching those exact bytes. Its returned
  `workContext` can be passed to `create` or `create-to`. Repository hooks and Git
  content filters are disabled. Reusing a request ID never silently packages a
  newer checkout; missing retained bytes require a new explicit request.
- `integrate`: supply work `id`, `location` (`local` or verified `peer` output),
  `integrationId`, stable `requestId`, exported `manifest`, local `policyId`, local
  `checks` IDs and `leaseToken` (null for verified peer output). AgentLink creates a
  detached worktree at the receiving HEAD, verifies every base before applying any
  file and captures real check output. The original dirty checkout is preserved.
  A conflict or uncertain check stops the operation; a new ID cannot bypass an
  unresolved execution attempt. Passed results include artifacts and a new package
  manifest suitable for submit/review. It never commits or merges the result.
- `integration-status`: inspect a durable `integrationId` without repeating checks.
  `integration-release` requires its exact `reportDigest` (null for a clean conflict)
  and refuses changed or additional local files. It removes only the settled
  worktree while retaining evidence. At most eight integration trees are retained.
- `team-list`, `team-resolve` and `create-to`: select a locally named pinned peer
  using `name`, optional `project`, required `capabilities` and explicit
  `queueIfOffline`. These actions need no connection argument. Capability names
  are peer declarations, not proof of competence. Ambiguous, absent or unavailable
  routes are explicit errors; existing trust and grants still apply.
- `activity`: optional `connection`, `refresh` and `includeArchived` returns ownership,
  state, findings, blockers, next action and source freshness. Delivery, observation
  and agent-reported processing remain distinct. Offline caches are labeled.

The terminal view is `agentlink work activity --refresh --format table`. Use
`--format json` for structured output. Local owner administration is explicit:

```sh
agentlink work team add --connection CONNECTION --name alice --project app --route frontend
agentlink work checks set --connection CONNECTION --id unit --command /absolute/path/to/node --args-json '["tests/unit.js"]' --timeout-seconds 30
```

Checks run an exact local executable and argument list with bounded output/time,
without a shell or inherited secret environment. This is delegated local execution,
not an operating-system sandbox. Only register checks you authorize for the peer,
workspace and selected work. A check can execute repository code.

Collaboration defaults are five rejected review rounds, three repetitions of an
open finding and 24 hours. A draft may narrow these limits. Exhaustion stores one
stable escalation question; the agent asks it once and records `budget-notice`
with the exact escalation ID. Cancellation and safe cleanup remain available.
Only the local recipient owner CLI may extend a finite work budget:

```sh
agentlink work budget authorize --connection CONNECTION --id WORK --request-id OWNER-REQUEST --rounds 5 --repeats 3 --elapsed-seconds 3600 --expires-at CANONICAL-UTC-TIME
```

Naming peers, registering executable checks and authorizing budgets are local
administrative actions, never authority supplied by a peer or a remote MCP request.

Integration checks must leave the selected input bytes, executable modes and Git
identity unchanged. If a check rewrites those inputs, the attempt is interrupted
and its worktree is retained: earlier passing output cannot verify later bytes.
After explicit worktree release, evidence stays pinned for the normal 30-day
retention window; active integration evidence remains pinned until release.
