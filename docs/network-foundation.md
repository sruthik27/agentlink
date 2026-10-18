# Experimental network foundation and standards bridge

This document describes the private M1 transport and the narrow M2 standards/harness bridge. The additional M3 agreement/task surface is documented in [network-collaboration.md](network-collaboration.md). This network surface is included in version 0.3.0+. M1/M2 alone do not establish a complete collaboration workflow, physical-laptop interoperability, or receiving-model processing; those require their separate acceptance gates.

## What M1 provides

The network modules provide a narrow direct-peer transport:

- A node has a stable validated ID, self-signed public certificate, certificate fingerprint, and private key. Public export contains only the certificate, fingerprint, ID, and schema version.
- A peer is trusted only by explicitly storing its public certificate and fingerprint. Outbound delivery requires the caller-supplied node ID, fingerprint, and certificate to exactly match that durable trust record before queueing and again before transmission. Addresses and display names do not confer identity.
- A separate finite grant binds one authenticated remote certificate fingerprint and node/agent identity to one local recipient agent, collaboration ID, `deliver` action, and a strict ISO expiry no more than 30 days after creation. Replacing a revoked certificate for the same node ID does not reactivate old grants. Mailbox mutation and its authorization check are serialized with grant changes, so a completed revocation prevents a waiting or later request from mutating the inbox, including on an existing TLS connection.
- HTTPS requires mutual TLS. The server accepts only pinned client certificates; the client validates the certificate chain against the explicitly supplied peer certificate and checks its pinned fingerprint.
- A local outbox is written before transmission. Pending entries can be scanned and retransmitted after sender restart. The receiver writes the event and its transport receipt atomically before returning that receipt. An identical retry gets the original receipt; reuse of the sender-node/event-ID pair with different bytes is rejected, including when the first response was dropped.
- Wire envelopes and receipts use schema version 1, strict fields, safe bounded IDs, bounded UTF-8 bodies, bounded HTTP messages, bounded creation-time clock skew, absolute handshake/header/body timeouts, and request plus connection limits.

The M1 network operation is delivery of a bounded text message envelope; M3 adds the separately owner-invited authority-owned agreement/task operations described in its documentation. There is no endpoint for shell execution, file or repository access, generic tool execution, arbitrary URLs, environment data, credentials, local paths, or model invocation.

## M2 A2A 1.0 edge

M2 pins the official [A2A 1.0.0 specification](https://a2a-protocol.org/v1.0.0/specification/) and its tagged normative protobuf schema. The compact reviewed fields, method names, errors, and exact schema source are versioned in `src/network/a2a-v1-fixture.ts`. The authenticated JSON-RPC interface implements only:

- `SendMessage` for one bounded `text/plain` user message in explicit non-blocking mode (`configuration.returnImmediately: true`), mapped to an authorized durable AgentLink transport receipt.
- `GetTask` for bounded polling of a task created by that same authenticated node.
- `GET /.well-known/agent-card.json` for a minimal Agent Card after mutual-TLS authentication.

The Agent Card is generated and validated against that pinned subset. It uses the A2A 1.0 `securityRequirements[].schemes` shape for mutual TLS and truthfully advertises no streaming, push notifications, or extended card. Each interface is agent-specific: its A2A `tenant` is the owner-authorized local AgentLink agent ID, and clients must copy that tenant into both `SendMessage` and `GetTask`. The authenticated card exposes only local agents covered by a currently active grant for that certificate-bound peer; it exposes no workspace paths, conversations, remote-agent identities, or session data. Push-notification configuration methods return the standard push-notification-not-supported error; other known unsupported methods return the standard unsupported-operation error, and protocols other than `1.0` return version-not-supported. Because this bridge does not run an agent to a terminal or interrupted state, omitted or false `returnImmediately` (the protocol's blocking default) is rejected as unsupported instead of incorrectly returning a submitted task. A submitted task means the message bytes were durably transport-received; it does not mean a model read, approved, processed, or executed them.

AgentLink-originated A2A sends persist the exact scoped envelope in the M1 outbox before opening the network request. The authenticated A2A metadata carries that envelope, and the returned task carries the matching transport receipt so the sender can durably mark it received. A failed request remains queued and can be resumed after sender restart with the same message ID without duplicating the receiver inbox effect. `GetTask` rechecks the original sender agent, recipient agent, conversation, certificate-bound peer grant, expiry, and revocation on every poll. The authorization lock is held through construction of the returned task/history, so a completed revocation cannot race behind an authorization read and still permit a later response; revocation also removes access to previously returned task history.

Completed A2A task records are retained for 30 days and compacted before quota checks, with a 128-task total and 64-task per-peer bound. The M1 inbox and replay evidence remain authoritative for duplicate/conflicting delivery protection after a task record expires.

Every A2A request is authenticated by the pinned client certificate. The request's agent name and conversation ID are then checked against a separate owner-created finite grant. An address, hostname, certificate alone, Agent Card name, or message metadata never grants access. Requests cannot execute commands, select filesystem paths, or turn remote text into owner approval.

## Install and initialize a node

For ordinary use, install `@sruthik/agentlink@0.3.0` or newer and follow [connect by code](connect.md). For a reviewed custom build, pack and verify the exact archive as below. The older 0.2.0 registry baseline lacks this network work.

```sh
cd /absolute/path/to/reviewed/agentlink-checkout
test "$(node -p 'require("./package.json").version')" = 0.3.0
npm ci
npm test
mkdir -p /absolute/owner/agentlink-artifacts
npm pack --pack-destination /absolute/owner/agentlink-artifacts
shasum -a 256 /absolute/owner/agentlink-artifacts/sruthik-agentlink-0.3.0.tgz
npm install -g /absolute/owner/agentlink-artifacts/sruthik-agentlink-0.3.0.tgz
test "$(agentlink version)" = 0.3.0

agentlink network node init --state-root /absolute/owner/state-a --id node-a
agentlink network node export --state-root /absolute/owner/state-a > /absolute/exchange/node-a-public.json
```

Record the checkout revision and printed SHA-256 beside the deployment configuration. Repack after any source change and update that recorded hash; published npm versions are immutable, so a changed public archive needs a new package version.

The export contains only the public certificate, fingerprint, node ID, and schema version. Keep the state directory private because it also contains the node's private key. Exchange the public JSON and verify its fingerprint through an independent owner-approved channel.

## Explicit pairing, agent exposure, and authorization

Pairing records both a peer address and a memorable peer name, but does not authorize messages:

```sh
agentlink network peer pair \
  --state-root /absolute/owner/state-a \
  --name frontend-laptop \
  --address https://10.0.0.42:7443 \
  --identity /absolute/exchange/node-b-public.json \
  --fingerprint sha256:<verified-64-hex-digits>
```

If that same pinned node moves to a different owner-selected address, update only its route. This does not replace its stable node identity or trusted certificate, and it does not add or expand any grant:

```sh
agentlink network peer update-address \
  --state-root /absolute/owner/state-a \
  --name frontend-laptop \
  --address https://10.0.0.84:7443
```

The local MCP session is bound at startup to the repo's selected stable actor. The owner must expose that exact actor from that exact repo to the chosen peer; a remote caller cannot supply or rebind it:

```sh
agentlink actor show
agentlink network agent expose \
  --state-root /absolute/owner/state-a \
  --agent <selected-local-participant-id> \
  --peer frontend-laptop
```

On the receiving node, the owner separately grants one remote node/agent pair access to one local agent and one conversation. Use `--ttl 12h` or a UTC `--expires-at` timestamp no more than 30 days away. Owner CLI input accepts optional milliseconds and is normalized to strict canonical storage; see [network-operations.md](network-operations.md) for diagnostics and expiry/recovery guidance.

```sh
agentlink network grant add \
  --state-root /absolute/owner/state-b \
  --id orders-review-grant \
  --peer backend-laptop \
  --remote-agent <backend-participant-id> \
  --local-agent <frontend-participant-id> \
  --conversation orders-v2 \
  --ttl 12h

agentlink network grant revoke \
  --state-root /absolute/owner/state-b \
  --id orders-review-grant
```

Pairing and authorization are intentionally distinct owner actions. Revocation prevents later mailbox mutation, including over an already-open TLS connection.

## Serve and use the tested surfaces

The server defaults to explicit loopback and an ephemeral port. For a deliberately chosen interface and stable peer address, pass both values explicitly:

```sh
agentlink network serve --state-root /absolute/owner/state-b --host 127.0.0.1 --port 7443
```

Do not bind a LAN or VPN interface until the owner has chosen that interface and applied the surrounding firewall/VPN policy. The command changes neither firewall rules nor global configuration.

The narrow CLI discovery/send/receive/status commands always require the state root, paired peer address/name, remote agent name, and selected conversation where applicable. Discovery returns only interfaces for agent names that the remote owner separately authorized for this authenticated peer:

```sh
agentlink network discover --state-root /absolute/owner/state-a --peer frontend-laptop
agentlink network send --state-root /absolute/owner/state-a --peer frontend-laptop --agent <frontend-participant-id> --conversation orders-v2 --body "Please review contract revision 3"
agentlink network receive --state-root /absolute/owner/state-a --peer frontend-laptop --conversation orders-v2
agentlink network status --state-root /absolute/owner/state-a
```

For MCP, configure the ordinary local stdio server with an owner-selected absolute state root:

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "agentlink-mcp",
      "env": {
        "AGENTLINK_NETWORK_STATE_ROOT": "/absolute/owner/state-a"
      }
    }
  }
}
```

The existing local tools remain unchanged. The additional tools are `agentlink_remote_discover`, `agentlink_remote_send`, `agentlink_remote_receive`, and `agentlink_remote_status`. The stdio process pins the repo path and selected actor once at startup. Tool arguments cannot select a sender, change the repo, expand a grant, or fall back to a global current conversation.

## Identity and certificate generation

Node initialization requires an `openssl` executable available on `PATH`; availability is checked explicitly before generation. It invokes `openssl req` without a shell to create an RSA-2048, SHA-256, self-signed X.509 certificate. Identity directories are mode `0700`; private-key and certificate targets are created mode `0600` before OpenSSL writes them. Private keys are never part of public identity exports.

Production owners must exchange and verify public identity material out of band before calling the trust-store API. M1 deliberately has no silent trust-on-first-use or pairing UI.

## Durable states and acknowledgements

Mailbox state distinguishes `queued` from `transport-received`. A `transport-received` receipt means only that the authenticated receiving node durably stored the bytes. It does not mean that an agent read, processed, accepted, or acted on the message. M1 has no processed-acknowledgement API and does not invoke a receiving model automatically.

Delivery is at least once with receiver-side idempotency. This foundation does not claim exactly-once agent execution. Inbox entries are retained for 30 days, compacted to replay tombstones through the 90-day replay window plus the permitted five-minute future skew (including the exact boundary), and envelopes older than that window are rejected rather than silently accepted after tombstone expiry. The store caps inbox and outbox at 128 events each, each peer at 64 events in either direction, replay tombstones at 512, and serialized mailbox state at 20 MiB. If all tombstone slots are occupied, the bounded inbox record is retained until replay evidence can expire instead of discarding a live replay guard. Mutations still use a bounded whole-file atomic rewrite; a database or journal is a later scaling concern.

The caller must explicitly supply the pinned peer identity and endpoint when resuming queued outbound events; M1 does not invent or persist routing policy. Authoritative conversation sequencing, contract proposals, agent-read/processed evidence, and cancellation semantics are provided by the separate M3 collaboration surface; they do not change M1 transport receipt semantics.

## Verification boundary

Run:

```sh
npm test
node scripts/verify-network-foundation.mjs
node scripts/verify-network-bridge.mjs
```

The verifier creates temporary state roots and runtime-generated keys, spawns two separate Node.js processes, binds an actual HTTPS server to `127.0.0.1` on an ephemeral port, and checks durable delivery, duplicate retry, conflicting replay, receiver restart, queued sender restart recovery, unknown certificates, spoofed actors, denied and revoked grants, and oversized input. It prints one structured JSON result to stdout and sends diagnostics to stderr. Shutdown waits for confirmed process exit, escalates from `SIGTERM` to a bounded `SIGKILL` fallback, and removes temporary state.

That same-host process test is not evidence of two physical laptops, firewall/VPN compatibility, native harness/model acceptance, A2A interoperability, or an end-to-end cross-owner workflow. Those remain later milestones. No current M1 command starts a persistent LAN listener, changes firewall/network policy, or reads the existing local AgentLink state.

The M2 bridge verifier additionally starts two real Node processes with runtime-generated identities, communicates over real mutual TLS using a separately implemented raw A2A client, fetches and independently schema-checks the Agent Card, selects its endpoint and tenant by the expected owner-authorized agent name, sends raw JSON-RPC requests to a local MCP process, verifies selected-repo and selected-conversation isolation, and restarts a node process before polling durable state. It emits only one JSON evidence object on stdout. This is same-host interoperability evidence for the documented subset, not broad A2A conformance or cross-machine production readiness.
