# AgentLink 0.3.0

Install once on both computers, tell your agent the developer and their IP, share one expiring connection code, and have the other developer give that code to their open agent. AgentLink manages project-scoped private identities, pinned mutual TLS, finite communication grants and background listeners. See [connect by code](docs/connect.md).

```sh
npm install -g @sruthik/agentlink@0.3.0
agentlink connect --to Alice --ip 192.168.1.11
# Recipient, from their selected project:
agentlink connect --code AL1-...
```

The CLI supports send, receive, bounded wait, status and stop. Already attached MCP sessions can use `agentlink_connect`; any terminal-capable coding-agent session can use the installed CLI. Invitations expire after ten minutes and bind one joining identity at the requested IP. Communication lasts at most two hours without automatic renewal. Pairing does not authorize code execution, unrelated project access or publication.

This release also includes authenticated network collaboration with exact-revision/digest approvals and owner execution permits, finite harness-specific wake adapters, project MCP setup for five harness formats, local network diagnostics, UTC/TTL input and deterministic runtime build identities.

## Verification before release

The connection candidate passed 184 tests and all local release gates. The versioned archive is checked with `npm run verify:release`: full tests, shipping/package hygiene, isolated installed foundation/bridge/collaboration, five MCP setup handshakes, installed one-code pairing and bidirectional communication with identical-retry deduplication, and deterministic wake/adapter protocols. Independent connection checks cover Node 20/24, wrong pins, used/expired codes, project/actor isolation, IPv6 normalization, waiting, stopping and finite helper expiry. Actual native model and physical-host evidence are separate from these local checks.

## Known limitation

Physical MacBook acceptance of this runtime remains pending. Publication is owner-authorized to make that installation/test possible; it does not assert a completed two-host native pass. Both hosts require direct IP reachability (such as a LAN or existing private VPN), Node.js 20+ and OpenSSL. There is no hosted relay or NAT traversal, and no firewall/SSH changes are made. Installing the package cannot inject MCP tools into a client that has not loaded its server. Universal idle-model wake is not provided; supported wake adapters require explicit finite enrollment. GitHub Actions results are not claimed as verified by this local release batch.

Earlier 0.2.0 data and manual network configuration remain available. Connection by code creates separate private state and does not renew old grants or resume old workers. GitHub source and documentation are synchronized separately from the immutable npm publication.
