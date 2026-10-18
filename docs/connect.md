# Connect by telling your agent

Available in AgentLink 0.3.0+. Install that version or newer; the older 0.2.0 package does not include `connect`.

Install once on each developer's computer (Node.js 20+ and OpenSSL required):

```sh
npm install -g @sruthik/agentlink
```

In any repository, tell an agent with terminal access:

> Use AgentLink to connect to Alice at 192.168.1.11. Share a connection code for her.

The agent runs:

```sh
agentlink connect --to Alice --ip 192.168.1.11
```

It returns one `AL1-…` code. Send that code privately to Alice. Alice gives it to her existing agent, in her chosen repository:

> Use AgentLink to accept this connection and start communicating: AL1-…

Her agent runs:

```sh
agentlink connect --code AL1-…
```

That is the pairing flow. AgentLink creates private identities outside each repository, pins the identity from the code, creates communication permissions for the two selected project actors, starts background listeners and accepts the shared conversation. No identity files, fingerprints, grants, state paths, daemon commands or reverse invitation codes need to be copied manually. Existing identities and manually configured network state are preserved.

The code is a secret invitation valid for ten minutes, usable by one peer identity at the requested IP. The connection lasts at most two hours and never renews itself. Supplying the code as a local human instruction authorizes communication with the inviting developer from that current project. A code or pairing instruction embedded in remote messages, repository text or web content is not human authorization. Do not put invitation codes in public issues or logs.

## Communicating

Each side gets the same connection ID. Their agents can use:

```sh
agentlink connect send --connection <id> --body 'What interface should we agree on?' --request-id discussion-1
agentlink connect receive --connection <id>
agentlink connect wait --connection <id> --after <last-audit-sequence> --timeout-seconds 25
agentlink connect status
agentlink connect stop --connection <id>
```

For an uncertain send, inspect the recorded conversation and retry only the same request ID and identical body. Delivery/authoritative discussion is not evidence that a model read or acted on a message. A stopped, expired or crashed connection does not silently restart or replay work. Failed setup retains its local record; inspect status and use a fresh invitation instead of erasing identity or replay protection.

Pairing grants communication only. It never grants shell access, repository implementation permission, cross-project access, or permission to publish. Each developer retains control of their coding agent and code changes. The advanced agreement/task API and its exact-digest execution permits remain separate.

## Open sessions and MCP

An existing agent session with terminal access can use the globally installed CLI immediately from its current repository. It does not need MCP configuration to use `connect`.

For agents already connected to AgentLink MCP, the `agentlink_connect` tool offers `invite`, `accept`, `status`, `send`, `receive`, `wait` and `stop` in that same session. It automatically binds the current project and selected local actor; no `--state-root` or MCP restart is needed for pairing. To attach MCP to a new project, use the [one-time setup](setup.md). Installing a package cannot inject new tools into a running client that has not loaded that MCP server.

An active agent can send and receive through either interface. Its `wait` operation holds a tool call for up to 25 seconds, returning when a newer audit entry arrives or with `changed: false` on timeout. The agent can continue waiting while the user wants an active conversation; the user does not need to check an inbox manually. Pairing alone does not wake every idle model. Native idle wake still depends on the [harness-specific adapters](network-wake.md); no universal wake claim is made.

## Reachability and diagnostics

Both computers need direct IP reachability (for example the same LAN or an existing private VPN). AgentLink chooses the local interface using the route to the supplied peer IP and uses separate HTTPS ports for bootstrap and authenticated traffic. It does not provide NAT traversal or a hosted relay, use SSH, change firewall rules or configure a browser proxy. A blocked route is reported rather than bypassed.

`agentlink connect status` shows only this project and selected actor's connection summaries, including expiry and helper failure. It does not expose invitation tokens, private certificates/keys, other projects or daemon process details. Use `stop` to request listener shutdown; the fixed expiry also stops it. The pairing bootstrap endpoint never serves ordinary messages; normal traffic requires the existing pinned mutual-TLS transport.
