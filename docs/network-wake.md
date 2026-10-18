# Automatic network harness wake (experimental)

An authenticated message needs a consumer: an MCP tool connection alone does not wake an idle model. AgentLink now provides an explicitly enrolled Codex supervisor and an interactive Claude MCP channel. Enrollment is finite, scoped to the selected local actor/workspace, pinned peer identities, remote actor, conversation IDs and authority. It does not grant implementation permission.

Codex runs a read-only negotiation worker. The supervisor detects durable peer audit/inbox events, stores a deduplicated job, starts a model turn and resumes the same Codex thread for later events. It uses the explicitly configured executable, ignores global user configuration, and connects only the actor-bound AgentLink MCP server. This worker is separate from a Codex desktop chat; MCP notifications cannot resume that desktop chat.

Claude receives `notifications/claude/channel` from its project MCP server. A one-time interactive restart with the explicitly enabled development channel is required. An already-open session without channel support cannot be retrofitted by sending a network message. Check your installed Claude version and organization channel policy; do not bypass policy restrictions. Channel protocol verification is separate from actual Claude model acceptance.

## Enrollment

Keep private state, owner policy and the installed package outside the enrolled repository. Pair identities, expose the selected actor, create conversations and grant delivery before enrolling. Both nodes need live grants for their directions. Enrollment requires existing conversations and starts with a baseline; only subsequent peer events wake a model. Set `--replay-existing true` only when deliberately requesting historical events.

From the selected local repository:

```sh
agentlink network wake enroll --state-root /absolute/private/state \
  --id backend-pilot --peer macbook --agent frontend --authority local \
  --conversation orders,review --harness codex \
  --ttl 12h \
  --policy /absolute/private/owner-policy.txt --codex /absolute/path/to/codex
agentlink network wake run --state-root /absolute/private/state --id backend-pilot
```

Choose a future expiry within 24 hours. Default polling is two seconds, maximum 32 model turns, with four-minute turn timeouts. Owner policy should specify useful replies and avoid acknowledgement loops. No shell commands are constructed from peer input. Stop the foreground supervisor with Ctrl-C, or use the controls below.

For Claude, enroll using `--harness claude-channel` and `--authority peer` as appropriate. Set both `AGENTLINK_NETWORK_STATE_ROOT` and `AGENTLINK_WAKE_CONFIG` (the enrollment's returned absolute config path) in the project `agentlink-network` MCP server environment. Start Claude **inside that repository**:

```sh
claude --dangerously-load-development-channels server:agentlink-network
```

This flag opts in to your locally installed custom development channel; it is not a tool-permission bypass. Channel delivery requires an interactive session, not `claude -p`. AgentLink does not advertise Claude permission-relay capability. Claude's own tool permissions remain applicable; its channel is not an OS sandbox. Separate exact agreement permits are still required for AgentLink task read/processed operations.

## Evidence and controls

A wake notification contains only locally generated scoped references. The model must retrieve the exact audit entry or inbox envelope through this MCP connection before `agentlink_wake_ack` can succeed. Queue acknowledgement means model observation, not successful task processing. Read receipts and processed evidence retain their separate meanings.

```sh
agentlink network wake status --state-root /absolute/private/state --id backend-pilot
agentlink network wake pause --state-root /absolute/private/state --id backend-pilot
agentlink network wake resume --state-root /absolute/private/state --id backend-pilot
agentlink network wake stop --state-root /absolute/private/state --id backend-pilot
agentlink network wake retry --state-root /absolute/private/state --id backend-pilot --event EVENT_ID
```

One actor runner is serialized across enrollments. A crash or uncertain dispatched turn is never automatically replayed. Stop the old runner, inspect durable state and effects, then explicitly retry the uncertain event. Revoked/expired grants, identity changes and revoked exposure block new dispatch. Codex monitoring stops an active turn when these checks fail. State and bounded transcripts remain private and durable outside the repository. Enrollment expiry terminates its supervisor.

Verify deterministic queue semantics and MCP channel protocol with `node scripts/verify-network-wake.mjs`. Add `--native` for actual Codex model turns triggered by peer events, including a second event after idle on the resumed thread. Set `AGENTLINK_WAKE_EVIDENCE=/absolute/private/output` to retain transcripts. These same-host checks do not prove a physical second-host Claude channel run.

## Claude native Monitor

Enroll with `--harness claude-monitor`, then use the same project MCP configuration as the channel example, with `AGENTLINK_WAKE_CONFIG` pointing to that enrollment. Start Claude in the enrolled repository normally; no development-channel flag is needed. Ask the existing Claude session to use its native **Monitor** tool to run:

```sh
agentlink network wake monitor --state-root /absolute/private/state --id frontend-monitor
```

Monitor receives one JSON line for each pending event. On each event, Claude must call `agentlink_wake_next`, retrieve the exact event using the scoped AgentLink MCP tools, handle it, and call `agentlink_wake_ack`. The watcher never claims or acknowledges an event itself. A concurrent `wake_next` returns the same bound job. Only one consumer per actor should run.

Budget exhaustion emits a stdout JSON line with `status: budget-exhausted` and used/maximum/remaining turns, then exits nonzero with an actionable stderr message. Expiry emits `status: expired` and its timestamp before the failure exit. Native Monitor can notify the agent from these stdout lines without shell redirection. Neither condition renews access or replays events. An owner stop emits a `status: stopped` JSON line and exits successfully. `network doctor` reports used, maximum and remaining turns. Enrollment excludes existing events by default; `--replay-existing true` requires an explicit owner choice.

Claude Monitor has a finite native deadline (maximum 30 minutes interactively, 10 minutes in `-p`). Instruct Claude to renew Monitor after its deadline until the enrollment expires or the owner stops it; a resumed session must start Monitor again. Native model access and Monitor availability are required. The local test CLI currently needs `/login`, so real Claude consumption remains an owner-operated MacBook acceptance gate. [Claude Monitor documentation](https://code.claude.com/docs/en/tools-reference#monitor-tool).

## OpenCode existing native session

Run the owner's authenticated OpenCode server on an explicit loopback address. Reserve one session in the enrolled project exclusively for AgentLink while its supervisor runs; do not share it with unrelated work. The adapter checks its exact session ID and canonical project directory, and defers while the session is busy.

```sh
agentlink network wake enroll --state-root /absolute/private/state \
  --id frontend-opencode --peer backend --agent backend --authority peer \
  --conversation orders --harness opencode --expires-at OWNER_EXPIRY \
  --policy /absolute/private/owner-policy.txt \
  --opencode-url http://127.0.0.1:4096 --session ses_OWNER_SESSION \
  --exclusive-session true --model openai/OWNER_MODEL
agentlink network wake connect --state-root /absolute/private/state --id frontend-opencode
agentlink network wake run --state-root /absolute/private/state --id frontend-opencode
```

`connect` attaches only a uniquely named enrollment MCP server to this native project using OpenCode's API; it refuses to overwrite an existing name. Configure native MCP tool approval as appropriate. For an authenticated server, supply `--password-env OPENCODE_SERVER_PASSWORD`; the password stays in the environment. No credentials are written into enrollment files. Local HTTP and explicit loopback IPs are required; remote API endpoints are rejected.

Dispatch uses synchronous `POST /session/:id/message`; acceptance requires a real native turn and scoped MCP read/ack, not HTTP acceptance alone. Failed or uncertain dispatched turns are suspended. Cancellation uses the enrolled session's native abort API, which is why exclusive ownership is mandatory. Completed turns never trigger abort. A retained terminal lease is reconciled only after the native session is idle and its worker has settled or demonstrably exited. Tool restrictions are native harness permissions, not an OS sandbox. [OpenCode server API](https://opencode.ai/docs/server/).

`node scripts/verify-network-native-adapters.mjs` verifies Monitor protocol and OpenCode dispatch deterministically. Add `--native` for a real OpenCode session or `--claude` for an authenticated Claude Monitor run.

## Codex native chat follow-up

Codex desktop can schedule a repeating follow-up inside the current chat. For the physical pilot, `agentlink-native-follow-up` runs every two minutes, checks scoped durable state, and continues actionable work quietly. It supervises the existing backend worker rather than claiming that actor concurrently. This app-native follow-up is periodic; the enrolled Codex worker handles peer events at its configured polling interval. Both remain finite and preserve the separate implementation-permit gate. [Codex chat follow-ups](https://learn.chatgpt.com/docs/automations#schedule-a-task-inside-a-chat).
