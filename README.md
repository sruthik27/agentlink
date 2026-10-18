# AgentLink — connect your coding agents

[Installation prompt](#let-your-agent-set-it-up) · [npm](https://www.npmjs.com/package/@sruthik/agentlink) · [Website](https://sruthik27.github.io/agentlink/) · [0.3.1 release notes](release-notes-v0.3.1.md)

Let coding agents in separate repositories and on different computers communicate, negotiate interfaces, and keep durable agreements. Use your existing coding agent through the CLI or MCP.

**Install → ask your agent to connect → share one code.**

Version **0.3.1** adds user-wide MCP setup, session workspace binding, resilient waits and a connection monitor. Direct connections require a shared LAN or existing private VPN, Node.js 20+ and OpenSSL. Physical-host acceptance of the new connection flow remains pending; see [verification status](docs/network-acceptance.md).

## Install

### Let your agent set it up

Copy this prompt into your coding agent. It installs AgentLink once for your user and configures the current harness across repositories. Requires terminal and configuration-file access; restricted clients may need an owner/admin step.

```text
Install AgentLink globally for my user, and configure user-wide MCP for this
coding harness so I can use it in sessions from any repository. Complete the
setup yourself while preserving my code, other MCP servers and existing settings.

1. Check Node.js (20+) and npm. Install the official package:
   npm install -g @sruthik/agentlink@latest --prefer-online
   If global installation is not writable, use a persistent user-owned npm prefix
   and resolve executable paths. Do not use sudo or save an ephemeral npx path.
2. Verify `agentlink version --format json` and `agentlink connect help`.
   User-wide setup below needs version 0.3.1+. Avoid a different package named
   agentlink or a stale executable earlier on PATH.
3. Detect THIS harness. Preview `agentlink setup --harness <harness> --scope user
   --config`, then apply with --write --check. Profiles: claude-code, codex,
   copilot, gemini, opencode. If config requires an explicit merge, back it up
   and merge only the proposed AgentLink entry, preserving other keys/comments.
   Respect custom config locations; use the harness's current official docs and
   native user-scope registration when needed. Reuse or deliberately migrate an
   existing entry instead of creating a duplicate. Do not pin the global entry
   to this repo or install repo-level MCP files. For another local stdio client,
   use the stdio profile with --scope user and its documented user config format.
4. Verify MCP startup with --check. If tools are loaded in this session, use
   agentlink_session to bind this session's actual absolute working directory,
   then make a read-only status/list call. Each future session selects its own
   workspace through that tool automatically; there is no per-repo installation.
   If MCP isn't loaded yet, give the one required reconnect/restart/trust step and
   use the CLI now. Do not claim a handshake proves native tool loading. Never
   end my session or bypass harness/organization policy.
5. Briefly report the version, user config path, checks and remaining action.
   Stop when installation is ready. Do not connect to a peer yet.

Later I can say "Use AgentLink to connect to Alice at 192.168.1.11 and give me
one connection code", or "Accept this AgentLink code: AL1-...". Pair only on my
local instruction and share codes privately. After pairing, keep communication
active without manual inbox checks. Read pending messages and retain the audit
cursor. Where supported, automatically run the returned connection monitor in
this harness's native Monitor/background tool that wakes the SAME session on
stdout. Re-arm it only within the unchanged connection expiry. A detached shell
watcher alone cannot wake a model. Otherwise use active bounded waits and report
that idle wake isn't supported here. Do not launch a competing model worker,
renew permissions, or treat communication as permission to execute peer code.
```

The [installation guide](docs/agent-install.md) explains global scope, verification and the connection flow. MCP registration is per harness/user, rather than per repository. Existing sessions may need one reconnect to load newly configured tools.

### Manual installation

```sh
npm install -g @sruthik/agentlink@latest --prefer-online
agentlink version --format json
# Optional local diagnostics:
npx @sruthik/agentlink doctor
```

An agent with terminal access can use the CLI immediately in any repository. For MCP, register once for your user with your harness profile:

```sh
agentlink setup --harness claude-code --scope user --write --check
# Profiles: claude-code, codex, copilot, gemini, opencode
```

Existing settings are preserved. Conflicting entries and existing TOML/JSONC may need an explicit merge; see [setup](docs/setup.md). Each session binds its own workspace at first use. MCP may require reconnecting once and approving the normal trust prompt. Project-only setup remains available with `--scope project`. Installing npm alone does not register MCP with every app.

## Connect two agents

1. Both developers install AgentLink in their chosen agent environment.
2. In your repository, tell your agent:

   > Use AgentLink to connect to Alice at 192.168.1.11 and give me the connection code.

3. Send the generated `AL1-...` code privately to Alice. In her repository, she tells her agent:

   > Use AgentLink to accept this connection and start communicating: AL1-...

Use Alice's actual reachable IP. AgentLink manages private identities, scoped communication permissions and background listeners. Codes expire after ten minutes; connections last at most two hours without automatic renewal.

The agents can exchange messages and use bounded waits while actively communicating. Pairing grants communication only: repository changes, command execution, commits and publication still need each owner's authorization. Native Monitor/background consumers can wake a supported existing agent session; pairing cannot add missing harness capabilities. See [connection commands and troubleshooting](docs/connect.md).

## What you can do

- Coordinate backend/frontend API changes across repositories through cross-repo contract negotiation.
- Exchange proposals and review findings with durable history.
- Record revision-bound approvals and agreed interface contracts.
- Keep each owner's repository, credentials and execution permissions separate.

## Documentation

| Topic | Guide |
| --- | --- |
| Agent-operated installation | [Installation prompt and scope](docs/agent-install.md) |
| MCP configuration and compatibility | [Setup](docs/setup.md) |
| Ordinary two-computer pairing | [Connect by code](docs/connect.md) |
| Advanced agreements and tasks | [Network collaboration](docs/network-collaboration.md) |
| Diagnostics and finite access | [Operations](docs/network-operations.md) |
| Harness-specific wake support | [Wake adapters](docs/network-wake.md) |
| Local checks and open physical-host gate | [Verification status](docs/network-acceptance.md) |

## Demo

![AgentLink terminal demo](demos/agentlink-demo.gif)

This deterministic **local two-workspace** demo shows contract negotiation and approvals. It is separate from physical-host verification of the new connection flow. Recording: [agentlink-demo.cast](demos/agentlink-demo.cast).

## Development and advanced reference

```sh
npm ci
npm test
npm run verify:release
```

The release verifier builds and tests the source and isolated installed packages. It does not publish or invoke models. Local evidence and remaining limits are described in [release readiness](docs/release-readiness.md).

<details>
<summary>Local bus, full CLI reference, optional wake, and migration</summary>

The following reference covers the local shared-bus workflow and advanced commands. For ordinary connections between computers, start with [connect by code](docs/connect.md).

## Configure two peer repositories

Run the following in the repository that will own the authoritative local bus:

```bash
agentlink init
agentlink actor show
agentlink start --topic "Shared API change" --required-approvals 2
agentlink contract --conversation <id> --status Proposed --sync-to ../peer-repo
agentlink register --label api-codex --client codex --ttl 300
```

Then run this with the peer repository as the current directory:

```bash
agentlink init
agentlink actor show
agentlink join --conversation <id>
agentlink register --label web-agent --client other-ide --ttl 300
agentlink heartbeat --registration <registration-id> --ttl 300
agentlink list
```

`contract --sync-to` is explicit pairing: it associates the peer with the owner's bus and selected conversation. AgentLink never crawls parent directories or arbitrary workspaces to discover peers. `bus.json` records the authority workspace deterministically. A workspace already containing conversations on another bus is not silently reassigned.

The actor printed by `actor show` is a stable participant identity. The workspace and participant IDs are different; multiple actors may belong to one workspace. Set `AGENTLINK_PARTICIPANT_ID` in an MCP process to bind that process to a particular registered actor, or use `agentlink actor use --id <participant-id>` as the checkout default. Display-name changes do not create another approver.

IDE/harness registrations are presence leases, not identities. They expire unless renewed, and listing cleans expired entries. A participant remains stable across registration expiry, process restart, and relabeling.

## Current product surface

- Discover explicitly registered coding-agent sessions across MCP/IDE harnesses without depending on tmux.
- Let a user select a target repo/session.
- Start a structured coordination conversation.
- Persist all messages to one explicitly shared authoritative bus under `.agentlink/bus/conversations/*.jsonl`.
- Generate conversation-scoped authoritative contracts plus an explicitly selected `.agentlink/CONTRACT.md` compatibility view.

## Commands

```bash
npm install
npm run agentlink -- init
npm run agentlink -- register --label api-codex --client codex --ttl 300
npm run agentlink -- heartbeat --registration <registration-id> --ttl 300
npm run agentlink -- list
npm run agentlink -- list --tmux # optional capability only
npm run agentlink -- start --topic "OAuth contract change" --target api-agent
npm run agentlink -- start --topic "Add account summary endpoint" --target api-agent --template api-change
npm run agentlink -- start --topic "Bounded API negotiation" --max-messages 20 --required-approvals 2
npm run agentlink -- actor show
npm run agentlink -- send --conversation <id> --role assistant --kind proposal --refs commit:abcdef1,pr:#42 --body "Please add expiresAt."
npm run agentlink -- send --conversation <id> --to <participant-id> --body "Implement this durable task."
npm run agentlink -- send --body "Please review the stored message." --deliver-to %2
npm run agentlink -- read --conversation <id> --limit 20
npm run agentlink -- read --conversation <id> --after <next-cursor>
npm run agentlink -- wait --conversation <id> --after <next-cursor> --timeout-ms 10000
npm run agentlink -- ack --conversation <id> --message-id <message-id>
npm run agentlink -- cap --conversation <id> --set 40
npm run agentlink -- cap --conversation <id> --remove
npm run agentlink -- notify list
npm run agentlink -- notify retry --event <event-id>
npm run agentlink -- wake enroll --recipient peer-codex --conversation <id> --codex "$(command -v codex)" --model gpt-5.6-sol
npm run agentlink -- wake run --config "$HOME/.config/agentlink/wake/peer-codex.json"
npm run agentlink -- wake status --config "$HOME/.config/agentlink/wake/peer-codex.json"
npm run agentlink -- wake stop --config "$HOME/.config/agentlink/wake/peer-codex.json"
npm run agentlink -- replay --conversation <id>
npm run agentlink -- replay --format json
npm run agentlink -- context
npm run agentlink -- context --format json
npm run agentlink -- doctor
node dist/cli.js doctor --format json
npm run agentlink -- setup
npm run agentlink -- setup --harness claude-code
npm run agentlink -- setup --harness copilot
npm run agentlink -- setup --harness gemini
npm run agentlink -- setup --harness stdio --format json
npm run agentlink -- version
npm run agentlink -- ship-check
npm run agentlink -- ship-check --format json
npm run agentlink -- launch-brief
npm run agentlink -- launch-brief --format json
npm run agentlink -- demo --peer ../peer-repo
npm run agentlink -- demo --peer ../peer-repo --format json
npm run agentlink -- approve --conversation <id>
npm run agentlink -- contract --conversation <id> --status Accepted
npm run agentlink -- contract --conversation <id> --status Proposed --set-section "API Surface" --content "- [x] Endpoint: GET /accounts/:id/summary"
npm run agentlink -- contract --conversation <id> --status Proposed --sync-to ../peer-repo
npm run agentlink -- join --conversation <id> # run with the peer repo as cwd
npm run agentlink -- status
npm run agentlink -- end --conversation <id>
node dist/mcp/server.js
```

`agentlink-mcp` is a stdio MCP server exposing the same local bus primitives to MCP-capable coding harnesses: list agents and conversations, start conversations, send/page/ack messages, adjust owner-controlled caps, update/accept contracts, and explicitly close conversations. Tool schemas document message kinds, references, cursors, and required target ids.

`agentlink_list_agents` reports active explicit bus registrations and cleans expired leases. `agentlink_register_agent`, `agentlink_heartbeat_agent`, and `agentlink_unregister_agent` manage the current stable actor's lease. `agentlink_list_tmux_agents` is separate and optional; missing tmux is reported gracefully and does not affect the durable workflow.

Conversation history is append-only JSONL on the associated authoritative bus. A peer association points both repos at that same log; it does not copy or fork a conversation.
`read` pages messages in durable sequence order; `replay`
prints the full append-only timeline, including conversation start metadata,
messages, approvals, and close events. Use `replay --format json` when another
harness needs structured timeline state. If more than one conversation could match,
read/send/join/approve operations fail with candidate ids instead of choosing a
thread silently. Closing always requires an explicit id.

New messages have durable `messageId` and `sequence` fields. Legacy messages receive
stable derived ids when read without rewriting the legacy record. `read` and MCP
`agentlink_read_inbox` accept either an opaque versioned `after` cursor or a `since`
message id and return `nextCursor` plus `hasMore`. Cursors are bound to their bus and
conversation. Reading never marks work processed. `ack`/`agentlink_ack_inbox` stores
a durable, monotonic acknowledgement per stable participant, and unread counts are
calculated from that state. Message bodies are preserved; optional kinds are
`proposal`, `decision`, `status`, `question`, and `blocker`, with validated `commit`,
`pr`, and `msg_id` references. Workspace provenance comes from the configured actor,
not from caller-supplied sender labels. A successful send reports persistence
separately from notification and processing acknowledgement. If an eligible recipient
has explicitly enrolled a trusted adapter, the ordinary send automatically invokes
that short callback; unconfigured recipients remain persistence-only. Use `--to` or
MCP `recipientParticipantId` to select a stable participant when several are eligible.
`wait`/`agentlink_wait_for_messages` requires a cursor or message id from a prior
read and has a hard 30-second maximum. A timeout is a normal empty result. MCP
request cancellation aborts the wait without acknowledging; after cancellation or
server restart, retry with the same durable cursor. The stdio server dispatches
requests concurrently, so a send on the same MCP connection can satisfy a pending
wait instead of being queued behind it.

```bash
agentlink wait --conversation <id> --after <next-cursor> --timeout-ms 10000
```

`context` prints a compact repo fingerprint for handoffs — workspace path,
git branch/commit/dirty-file count, and package scripts — without including source
content or full file lists. Use `--format json` when another tool needs structured
metadata. `doctor` checks Node/npm scripts, `.agentlink` workspace state, current
contract/store health, tmux agent visibility, and the MCP build artifact so local
setup issues are visible before dogfood/demo work; use `node dist/cli.js doctor --format json`
after building when a harness or CI gate needs machine-readable readiness checks without
npm script banners contaminating JSON. `setup` prints deterministic
local install, stdio MCP server, harness setup, and agent-prompt instructions;
use `--harness <stdio|claude-code|codex|copilot|opencode|gemini|all>` and `--format json` for
machine-readable setup data. `ship-check` is a read-only launch-readiness gate
for final QA; it verifies package metadata, bins, npm package file allowlist,
actual `npm pack --dry-run --json` contents, npm tarball bin executability,
an installed packed-tarball CLI smoke, README command/positioning coverage, and build artifacts, while explicitly
preserving the boundary that publishing or public launch requires human approval.
`launch-brief` prints the
final human approval artifact: product thesis, verification commands, demo commands,
launch artifacts, CEO decisions needed, and the no-publish/no-launch-without-approval boundary.
Version 0.3.0 notes are kept in [`release-notes-v0.3.0.md`](release-notes-v0.3.0.md) and included in the distribution tarball. Earlier 0.2.0 notes remain at [`release-notes-v0.2.0.md`](release-notes-v0.2.0.md). They record actual-client verification, support boundaries and separate npm/GitHub availability. Historical 0.1.0 and 0.1.1 notes remain unchanged.

The package also includes the private experimental authenticated network setup and verification guide at [`docs/network-foundation.md`](docs/network-foundation.md). Pairing a certificate and address does not authorize an agent: owners must separately expose the local agent/workspace and create a finite conversation-scoped grant before remote delivery.
`version` prints the installed package version so harness configs and smoke tests
can confirm the expected AgentLink build is on PATH.
Repository acceptance can be rerun with
`node scripts/verify-reliability.mjs --evidence-dir /absolute/output/path`. The
bounded harness packs and installs the npm artifact into a temporary prefix, drives
two actual cwd-specific MCP processes through four interleaved conversations and a
nine-decision Verified lifecycle, checks restart/concurrency/caps/notification
recovery against durable files, emits `reliability-summary.json`, and removes its
temporary repositories and subprocesses. It does not require or simulate an LLM;
the supervised Codex native-wake acceptance is a separate host-side run. A prior
packed-artifact host run passed the supported Codex workflow; it is not evidence
for arbitrary GUI/IDE/Claude wake, and physical/native acceptance for the current runtime remains a separate gate.
`demo --peer <repo-path>` runs a deterministic local two-repo API-contract
negotiation smoke: it creates an append-only conversation, records producer and
consumer messages, records two approvals, marks the contract Accepted, closes the
conversation, and syncs the same `.agentlink/CONTRACT.md` to the peer workspace.
Use `--format json` for machine-readable demo checks.
Starting a conversation creates an authoritative per-conversation contract and selects its `.agentlink/CONTRACT.md` compatibility view; selection metadata records the exact generated-byte digest so a peer's later authoritative edit is distinguishable from a genuine local edit. Older digest-less selections are upgraded only when their bytes still match authority; otherwise refresh is explicit and fail-closed. `init`
leaves an existing contract untouched. `start --template <template>` creates a
focused, deterministic negotiation checklist. Available templates are
`api-change`, `event-contract`, `db-migration`, and `frontend-backend`; omitting
the option preserves the generic contract. Conversations are unlimited by default.
`start --max-messages <count>` adds a message-count cap and warns near the limit;
the owner can raise or remove it with `cap`. `--max-rounds` remains a compatibility
alias but also counts messages, not back-and-forth rounds. `start --required-approvals
<count>` makes `contract --status Accepted` fail until enough participants have
joined and run `approve` as their configured stable actor. `contract --status <status>` advances the
local contract state through Draft, Proposed, Accepted, Blocked, Implemented,
or Verified. `contract --sync-to <repo-path>` explicitly associates the peer with
the source bus and materializes its compatibility view, so both cwd-specific MCP
processes resolve the same conversation log and contract. `contract --set-section <heading> --content <markdown>`
deterministically replaces an existing section or inserts a new one before `Status`,
so agents can merge concise contract updates without regenerating the whole file.
`send` only appends by default. With
`--deliver-to`, AgentLink appends first, then types the structured JSON message
into the selected pane, verifies it is visible, and only then presses Enter.
A tmux delivery failure does not remove the stored message.

## Trusted local notifications

Notifications are opt-in at recipient registration/enrollment and run only after the message is durably appended. Once an eligible registration names an adapter, ordinary CLI and MCP sends attempt it automatically; `send --notify` and MCP `notify: true` remain accepted compatibility flags but are no longer required for enrolled recipients. A missing, untrusted, timed-out, or non-zero receiver never rolls back persistence. The send result reports persistence, whether notification was attempted, receiver failures, and processing acknowledgement separately. Failed events stay on the bus and can be retried explicitly with `notify retry`; delivered event IDs are deduplicated.

Bus/repository data may name an adapter ID, but it cannot provide executable code. Fixed argv is loaded only from a user trust file outside the repository (default `~/.config/agentlink/notifications.json`, overrideable with `AGENTLINK_TRUST_CONFIG` for isolated environments). The executable must be an absolute path, AgentLink calls it directly with `shell: false`, and each call has a bounded timeout. Repository-controlled message bodies are never interpolated into argv; the adapter receives only event, bus, conversation, message, and registration IDs.

The built-in local receiver is a concrete reference workflow. Configure it with the absolute paths for your installation and a user-owned inbox outside the repo:

```bash
agentlink notify trust --id local-receiver --argv-json '["/absolute/path/to/node","/absolute/path/to/agentlink/dist/cli.js","receiver","--inbox","/absolute/user/path/agentlink-events.jsonl"]' --timeout-ms 2000
agentlink register --label peer-agent --client codex --ttl 300 --adapter local-receiver
agentlink send --conversation <id> --body "Review the persisted change" --notify
```

The receiver appends reference-only JSONL and deduplicates by event ID. It is a notification inbox, not proof that an agent processed the message.

## Supervised headless Codex auto-wake

AgentLink can concretely wake and run an explicitly enrolled **supervised/headless Codex** recipient. This does not wake someone else's open GUI, arbitrary interactive Codex/Claude session, tmux pane, or IDE. MCP alone still cannot wake an idle model; the recipient supervisor is the process that owns that capability.

In the peer/recipient repo, enroll its selected stable participant and start the supervisor:

```bash
CODEX_BIN="$(command -v codex)"
agentlink actor show
agentlink wake enroll \
  --recipient peer-codex \
  --conversation <conversation-id> \
  --codex "$CODEX_BIN" \
  --model gpt-5.6-sol

agentlink wake run \
  --config "$HOME/.config/agentlink/wake/peer-codex.json"
```

Enrollment is the explicit user-side trust action. It canonicalizes and binds the executable, recipient cwd, workspace ID, bus, stable participant, registration, and allowed conversation IDs. Config, queue, transcripts, and thread mapping live outside the repository in user-owned paths. The trusted callback receives only validated IDs and returns after enqueueing; the long model turn runs later, outside the sender's timeout and notification lock. If `AGENTLINK_TRUST_CONFIG` or custom `--config`/`--state` paths are used, use the same user-owned trust path for sender commands that share this local account.

Leave that supervisor idle, then send normally from the peer repo. Targeting is recommended when several participants are eligible:

```bash
agentlink send \
  --conversation <conversation-id> \
  --to <recipient-participant-id> \
  --body "Implement the requested repository change and report the result."
```

The callback durably queues the exact message reference and returns before the Codex turn finishes. The supervisor reconciles messages persisted while it was offline, heartbeats the registration, runs one job at a time, starts with `codex exec --json --sandbox workspace-write`, and resumes only the saved thread for that conversation. The workflow prompt goes over stdin and instructs Codex to fetch the exact durable message in its own cwd, honor contract gates, act, and report a status message. AgentLink records the transcript, actual thread ID, exit state, and before/after Git status, then acknowledges the original message only after a schema-validated successful checkpoint and a new recipient-authored `status` message that references the exact input message ID.

Operate and recover the recipient without deleting durable conversations or contracts:

```bash
agentlink wake status --config "$HOME/.config/agentlink/wake/peer-codex.json"
agentlink wake pause  --config "$HOME/.config/agentlink/wake/peer-codex.json"
agentlink wake resume --config "$HOME/.config/agentlink/wake/peer-codex.json"
agentlink wake stop   --config "$HOME/.config/agentlink/wake/peer-codex.json"
agentlink wake retry  --config "$HOME/.config/agentlink/wake/peer-codex.json" --job <job-id>
```

Provider quota/rate-limit failures use bounded exponential backoff and a finite retry budget. Timeout, crash, malformed completion, or a stale `running` job is suspended and remains unacknowledged for explicit inspection/retry. This avoids blind repeats but cannot guarantee arbitrary external side effects exactly once if a process dies after performing them; tasks should be idempotent. Stop/shutdown terminates only the supervised child process group. Revoking or stopping the supervisor never deletes messages, contracts, or approvals.

The local security boundary is cooperative filesystem access, not adversarial authentication. Anyone who can edit the user's external wake/trust files or the shared bus can affect this local workflow. Repository-controlled config and message bodies cannot select an executable, add shell syntax, change cwd/sandbox, or become process argv; unsafe relative/symlinked paths and binding mismatches are rejected.

## What to commit and what to ignore

The repository `.gitignore` keeps runtime bus state, workspace/participant IDs, registrations, cursors/acknowledgements, notification attempts, locks, and JSONL logs out of Git while allowing the selected handoff contract to be tracked:

```gitignore
.agentlink/*
!.agentlink/CONTRACT.md
```

Commit `.agentlink/CONTRACT.md` only when the team wants a reviewed contract handoff in source control. It is a selected compatibility view; the authoritative live contract remains conversation-scoped under the associated bus. Never commit user trust configuration or credentials. If the project prefers not to track contracts, ignore `.agentlink/` entirely.

## Migration from 0.1.1 workspace data

Migration is automatic, non-destructive, and idempotent on first workspace access:

1. Legacy `.agentlink/conversations/*.jsonl` files are copied byte-for-byte into the new local authoritative bus; old logs and approval audit records remain in place.
2. A marked legacy `CONTRACT.md` is assigned only when its conversation ID exists. An unmarked contract is preserved at `.agentlink/legacy/CONTRACT.unassigned.md` and is never attached to an arbitrary recent conversation.
3. Completed imports and source digests are recorded in `.agentlink/migration-v1.json`. Conflicts or later edits to preserved legacy input stop with an actionable error rather than discarding data.
4. Legacy free-label approvals remain readable audit evidence but cannot satisfy stable-participant, revision-bound approval gates.
5. Copied checkouts whose workspace identity points at another canonical path must be repaired explicitly with `agentlink init --new-workspace`; peers are never silently conflated.

Back up `.agentlink/` before changing ignore rules or moving the authority checkout. There is no destructive migration command and no automatic deletion of legacy data.

## Design stance

- Local-first.
- Structured bus is source of truth.
- Explicit expiring registration is core discovery; no tmux dependency for the core workflow.
- tmux pane messaging is notification/bridge, not durable storage.
- Repo contexts stay isolated; agents exchange summaries/contracts only.
- Human is founder/approver, not message router.

The experimental network worktree also includes revision-bound collaboration, scoped local execution permits, explicit task processing evidence, and restart-safe native harness verification. See [collaboration documentation](docs/network-collaboration.md) and the [owner-operated MacBook pilot](docs/network-macbook-pilot.md). Version 0.3.0 includes this network surface; physical-host acceptance remains a separate, pending gate.

Automatic network harness wake: see [enrollment, Codex supervisor and Claude channels](docs/network-wake.md).

For network diagnostics, easier finite expiry input (`--ttl 12h`), MCP recovery and private runtime build fingerprints, see [network operations](docs/network-operations.md). Run `agentlink network doctor --state-root <absolute-private-state>` from the owning project; this local inspection does not initialize files or prove native model processing.

For development release validation, run `npm ci` and `npm run verify:release`. This saves the tested private archive, checksum and local gate logs under `.hermes/release/`. See [release readiness and remaining physical-host acceptance](docs/release-readiness.md). The command never publishes or renews pilot permissions.

</details>
