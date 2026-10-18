# Two-host acceptance guide

This guide is for an owner-operated test of the published connection flow on two physical computers, including a MacBook. Ordinary users should start with [connect by code](connect.md). This is an acceptance checklist, not evidence that the checks have passed.

## Prepare and pair

1. Obtain explicit authorization from both owners for a finite communication test. Use isolated, non-sensitive repositories. Repository implementation and advanced agreement execution require separate local permission.
2. On both computers, install `@sruthik/agentlink@0.3.0` from npm and record `agentlink version --format json`, OS, Node and harness versions. Confirm both runtime identities match the [published baseline](network-acceptance.md).
3. Start each actual coding agent in its chosen repository. Use the [installation prompt](../README.md#let-your-agent-set-it-up) to configure MCP if desired. Record whether the session uses native MCP or the CLI; a server handshake is not native tool-use evidence.
4. Verify direct IP reachability through the shared LAN or an existing private VPN. Do not bypass firewalls, use SSH, or introduce a TLS-terminating browser proxy.
5. Tell one agent to connect to the other developer's actual IP. Share its `AL1-...` code privately; the other owner gives it to their agent to accept. Record connection IDs and expiries without saving the invitation bearer or private keys in public logs.
6. Have each actual agent send and process a substantive message. Correlate exact audit entries with its model/tool transcript. Use stable request IDs; inspect history before retrying uncertain effects.

## Record acceptance evidence

- Exact package/runtime identity on both physical hosts and actual agent/tool turns.
- Initial and resumed-idle communication in the same selected projects; distinguish active bounded waits from any separately enrolled native wake adapter.
- Controlled listener/session restart evidence. Respect the connection's failure/replay rules: do not delete state or revive a crashed connection to force a pass. If recovery is unavailable, record that limitation and use a fresh authorized code for further testing.
- Identical retry without duplicate effects, stopped/expired connection behavior and unrelated-project isolation.
- For the advanced collaboration API: disagreement/reconciliation, identical revision/digest approvals, separately owner-authorized local repository effects and test evidence, second task after restart, explicit route update preserving identity, authority-offline behavior without split-brain approvals, and revocation while connected.

Keep delivered, model-read, processed, approved and human-authorized states distinct. Keep secrets and private source out of public evidence. Stop the test with `agentlink connect stop --connection <id>`; do not automatically extend access. A failure or missing evidence leaves the relevant gate open.
