# Experimental cross-owner collaboration

This extends the authenticated network foundation with authority-owned agreements and a separate task lifecycle. Included in version 0.3.0+. For ordinary onboarding use [connect by code](connect.md); the low-level commands below support custom deployments. Physical-host acceptance remains a separate gate.

## Ownership and authority

Each collaboration has exactly two principals on distinct nodes: an authority actor and one invited remote actor. The local owner creates the invitation with a finite expiry (maximum 30 days). The remote actor accepts it. Pairing does not create a grant; a finite incoming grant to the authority actor is also required. The locally bound MCP actor must be exposed from its selected repository to the paired peer.

Only the authority sequences changes. A proposal specifies `expectedRevision`; a successful proposal increments the revision and invalidates all approvals. Each distinct principal approves the exact revision and SHA-256 digest of the UTF-8 agreement bytes. Repeated approvals by one principal do not constitute joint agreement. The authority being offline cannot create a second authority: requests remain queued, and explicitly requested cached reads are marked stale.

The authority is trusted to sequence the collaboration. This is not Byzantine consensus or a signed distributed ledger. A participant may misrepresent its work; processing evidence is authenticated recipient attestation, and acceptance verifiers independently rerun tests and check hashes.

## Owner setup

First follow [network-foundation.md](network-foundation.md) for private identities, explicit fingerprint verification, pairing, selected actor exposure and incoming grants. Use a fresh isolated pilot repository on each side.

From the authority's selected repository:

```sh
agentlink network collaboration create --state-root /absolute/private/node-a \
  --id orders --peer frontend --agent frontend --topic 'Orders API' \
  --expires-at <strict-ISO-timestamp-within-30-days>
```

The other owner must learn the collaboration ID and authority actor through the agreed pairing channel. There is no public directory of invitations.

## Locally bound MCP operation

The stdio MCP server adds `agentlink_collaboration` alongside the original local tools and M2 remote messaging tools. Configure `AGENTLINK_NETWORK_STATE_ROOT` in the locally installed MCP server environment. Each call selects its peer, remote actor, conversation and authority explicitly:

```json
{
  "peer": "backend",
  "agent": "backend",
  "conversationId": "orders",
  "authority": "peer",
  "operation": { "type": "accept", "requestId": "accept-orders-1" }
}
```

Use `authority: "local"` only in the authority's selected repository. Tool arguments cannot rebind the local actor, choose another workspace, grant access, or create an execution permit.

Supported operations:

| Operation | Required operation fields | Effect |
|---|---|---|
| `get` | `requestId` | Read current authoritative state |
| `accept` | `requestId` | Accept the owner-created invitation |
| `discuss` | `requestId`, `content` | Append bounded discussion to durable audit |
| `propose` | `requestId`, `expectedRevision`, `content` | Replace agreement bytes and invalidate approvals |
| `approve` | `requestId`, `expectedRevision`, `digest` | Approve exact bytes as the bound agent |
| `task` | `requestId`, `expectedRevision`, `digest`, `taskId`, `content` | Assign a bounded task to the other participant after joint approval |
| `read` | `requestId`, `taskId` | Recipient acknowledges reading a task under an owner execution permit |
| `processed` | `requestId`, `taskId`, `evidence` | Recipient attests processing with artifact/test hashes |
| `fail` | `requestId`, `taskId`, `content` | Recipient reports failure after read |
| `cancel-task` | `requestId`, `taskId` | Sender requests cancellation |
| `cancelled-task` | `requestId`, `taskId` | Recipient confirms requested cancellation |
| `cancel` | `requestId` | Stop collaboration mutations and request cancellation of unfinished tasks |

An evidence object contains `summary`, `artifactDigest`, and `testDigest`. Digests use `sha256:` followed by 64 lowercase hexadecimal characters. Hash actual file/test-output bytes, not an invented success summary. Evidence and discussion are explicit exports; never include credentials or private paths.

The CLI exposes the same actor-bound operation using `network collaboration call --peer ... --agent ... --conversation ... --authority local|peer --operation '<JSON>' --state-root ...`.

## Explicit execution permission

Joint agent approval authorizes agreement, not repository execution. After inspecting the exact accepted agreement, each owner separately permits its selected local actor to implement and test that agreement in the selected repository:

```sh
agentlink network collaboration authorize --state-root /absolute/private/node-a \
  --peer frontend --agent frontend --authority local \
  --conversation orders --revision 2 --digest sha256:<exact-agreement-hash> \
  --expires-at <strict-ISO-timestamp-within-24-hours>
```

For the invited peer, use its paired authority peer/agent and `--authority peer`. The command inspects authoritative state and rejects a mismatched revision/digest. This permit binds both node and actor identities, certificate fingerprints, canonical local workspace, conversation, revision and digest; it is local and never exported. A later edit invalidates it because it binds a revision and digest. Revoke it locally:

```sh
agentlink network collaboration revoke-execution --state-root /absolute/private/node-a --conversation orders
```

The bridge requires that permit before `read` and `processed`. It never executes commands or invokes models. The receiving harness's local owner controls its repository tools and permissions. A malicious peer cannot submit a remote shell command to this service. The node cannot prevent a locally privileged process from editing its own private state, or retract data a peer already received.

Task phases are `transport-received`, `agent-read`, `processed`, `failed`, `cancel-requested`, and `cancelled`; outbound operations are separately `queued`, `transport-received`, or `failed`. A cancellation request does not prove work stopped. The recipient must confirm cancellation. Editing an agreement is blocked while a task is read or cancellation is unresolved; an unread task under an older agreement cannot begin work.

Retry a disconnected operation with the **same requestId and identical fields**. The client queues before sending and the authority records its operation hash atomically with the resulting state. A conflicting retry is rejected. Responses carry a request hash and must match authority, participants, conversation, and audit acknowledgement before the client records delivery. An old or divergent authority snapshot is rejected. Cached reads require `cached: true` with `operation.type: "get"` and are explicitly non-authoritative.

## Bounds and persistence

A node stores at most 32 collaborations, each with at most 256 audit operations, 16 tasks, and 60,000 serialized bytes, with capacity reserved for completion and cancellation. Agreement text is at most 12,000 UTF-8 bytes; discussion/task text is at most 2,000 bytes; evidence summaries and failure text are at most 256 UTF-8 bytes and 258 JSON-encoded bytes including quotes. The authority reserves the worst remaining read/completion/cancellation bytes and rounds for each active task using its actual principal and task IDs; new discussion and tasks must leave that reserve intact. Client requests are bounded at 256 per explicit scope (192 ordinary operations plus read/terminal reserve), 32 scopes, and 8,192 total entries. Client caches are bounded at 32. Ordinary queued work is limited to 2 MiB to preserve terminal space within the 8 MiB client store. Exhausted quotas reject new work without deleting live replay/audit evidence. Use a new owner-controlled state root for a new bounded pilot when the current root reaches its limits; do not erase an active collaboration's replay records.

State uses locked atomic file replacement. Revocation of the authority's incoming peer grant prevents remote reads, retries, and mutations under that grant, including existing TLS connections. Local owner execution revocation prevents later read/processed calls; it does not interrupt shell work already running in the harness. Peer address updates preserve pinned identity and queued request scope.

## Verification

```sh
npm test
node scripts/verify-network-foundation.mjs
node scripts/verify-network-bridge.mjs
node scripts/verify-network-collaboration.mjs
node scripts/verify-network-installed.mjs
node scripts/verify-network-native.mjs
```

The collaboration process verifier uses actual daemons, raw stdio MCP clients, separate temporary repositories, independent local tests, disagreement/reconciliation, stale proposals, invalidated approvals, matching bytes, correlated evidence, restart/second task, author/reviewer resolution, cancellation, and revocation. Its actors are deterministic fixtures.

The installed verifier packs and installs in a temporary prefix, checks package hygiene, and runs all three process workflows from the installed archive. Its reported archive checksum identifies exactly those bytes.

The native verifier invokes actual Codex and OpenCode model sessions through a recording stdio MCP bridge. It checks real tool calls, generated implementations, independently rerun tests, reported hashes, matching agreement bytes, same-session continuation after daemon restart, and a second processed task. Provider errors fail the gate; deterministic substitutes cannot pass it. Override models per invocation using `AGENTLINK_CODEX_MODEL`, `AGENTLINK_OPENCODE_MODEL`, and `AGENTLINK_OPENCODE_API_MODEL`. OpenCode 1.2.27's OAuth plugin has a fixed model registry: the default test aliases its registered `openai/gpt-5.3-codex` entry to the actually available `gpt-5.6-sol` API model using a per-run config, without changing global settings. The evidence records both names. Set `AGENTLINK_NATIVE_EVIDENCE_ROOT` to a private absolute evidence directory.

Native same-host evidence does not establish physical-laptop readiness. Follow [network-macbook-pilot.md](network-macbook-pilot.md) for the separately owner-operated second-host pilot.
