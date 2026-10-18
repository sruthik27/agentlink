# Network setup diagnostics and finite permissions

Run these commands in the project that owns the selected actor, with its private network state outside the repo. Existing identities, conversations and history should be preserved when diagnosing a failed pilot.

```sh
agentlink network --help
agentlink network doctor --state-root /absolute/private/node
agentlink version --format json
```

`network doctor` reads local metadata only. It reports the selected actor, public node identity, pinned routes, exposure from this exact workspace, incoming grants and authority-owned conversation expiry, project `agentlink-network` MCP configuration, and this workspace/actor's wake queue counts and turn budgets. It does not initialize a missing workspace, send messages, execute a harness, renew access, dump agreement bodies/policies/MCP environment secrets, or claim a daemon/model is running. Remote-authority cached conversation state is not included. It is a diagnostic snapshot, not a transactional authorization decision. CLI output is JSON; inspect each `checks` entry for actionable guidance.

Pairing, exposure, incoming grants, invitations, wake enrollment and repository execution permits are distinct. A live grant does not revive an expired invitation. A wake acknowledgement proves an exact event was read through its bound MCP connection; it is not a task-processing result or proof that a native harness used its built-in MCP client. `network discover --peer <name>` explicitly checks authenticated peer reachability; transport receipt still does not prove model processing.

## Easier expiry input

Owner CLI commands `network grant add`, `network collaboration create`, `network collaboration authorize` and `network wake enroll` accept exactly one of:

- `--ttl 30m`, `--ttl 12h`, or another positive whole duration with unit `s`, `m`, `h` or `d`.
- `--expires-at 2026-10-18T10:15:18Z`, optionally including one to three fractional second digits. UTC `Z` and `+00:00` are accepted; invalid calendar dates, local time, other offsets and precision beyond milliseconds are rejected.

Both forms are normalized to canonical millisecond UTC timestamps before the existing authorization APIs are called. Stored state and wire parsing remain strict. Maximum grant/invitation lifetime remains 30 days; wake/execution permission remains at most 24 hours. No automatic renewal is introduced. This input improvement does not extend any existing pilot permissions.

```sh
agentlink network collaboration create --state-root /absolute/private/node \
  --id orders --peer frontend --agent frontend --topic 'Orders API' --ttl 12h
```

## Native MCP acknowledgement recovery

Keep one MCP connection alive for the entire sequence:

1. Claim via `agentlink_wake_next`.
2. Retrieve that exact event with a non-cached collaboration `get` or the matching inbox `receive`; await the response.
3. Handle it, then call `agentlink_wake_ack` on the same connection/event ID.

Errors now distinguish a missing connection binding, a mismatched event, a missing completed exact read, and malformed acknowledgement fields. Do not batch an acknowledgement ahead of the read response. If a process exits after an uncertain effect, inspect the durable audit/effects before an explicit `network wake retry`; a dead process alone does not prove the operation was unsent. Helpers launched from a model may be useful diagnostics, but do not substitute for native project-MCP acceptance evidence.

## Identifying private builds

Plain `agentlink version` remains compatible. `agentlink version --format json` adds a deterministic `buildId`, `algorithm` and `runtimeFiles` count. The `sha256-runtime-js-v1` fingerprint covers sorted, length-delimited relative names and bytes of installed runtime `.js` files; test files and source maps are excluded. This distinguishes different runtime builds sharing package version 0.2.0 without reading git/user state or changing the public version. It is not the archive checksum, a signature, or an attestation of trust: compare the separately supplied SHA-256 of a transferred `.tgz` as well.

## Trust and next improvements

The current threat model and acceptance limits are documented in [network-foundation.md](network-foundation.md), [network-collaboration.md](network-collaboration.md) and [network-wake.md](network-wake.md). A malicious paired peer remains untrusted content; peer identity is not owner shell/execution authorization. Future join invites should display the pinned identity and exact requested scopes before owner consent. LAN discovery may suggest a route but must never establish trust. History-preserving renewal needs explicit owner action, finite limits and audit semantics; grant revocation, cancelled collaborations and execution permits must not be silently revived. Managed daemon installation is a separate lifecycle feature, not implied by doctor output.

The compressed wording in the pilot agreement (such as `returns403`) came from the authored fixture text, not an agreement serializer that removes spaces. Agreement/proposal bytes are intentionally preserved exactly for digest approval; existing approved bytes must not be silently reformatted.
