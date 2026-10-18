# Network and setup release candidate

Version 0.3.0 extends the 0.2.0 baseline with connection by code and project MCP setup. The owner authorized npm publication for installation and physical-host testing. Distribution does not establish physical-host acceptance.

The current candidate also includes [agent-driven connection by code](connect.md): invite a developer at an IP, share one expiring code, and accept it from the other current project. Managed identities, communication grants and listeners replace the manual pilot setup for ordinary users. Existing terminal-capable sessions can use the global CLI; attached MCP sessions can use `agentlink_connect`. Physical acceptance must exercise these new runtime bytes; an older pilot archive cannot establish acceptance for this flow.

Run `npm ci`, then `npm run verify:release` from a development checkout. The latter builds current sources, runs the full test suite, checks shipping metadata and package hygiene, installs the exact candidate archive in isolation, exercises authenticated two-process foundation/bridge/collaboration flows, checks five MCP setup formats, exercises one-code pairing and bidirectional messages from the installed package, and runs deterministic wake/adapter protocols. Logs, the candidate archive, checksum and result JSON are written to `.hermes/release/<timestamp>/`. Failure stops the batch with a nonzero exit code. It does not publish or call a model.

The result establishes local engineering/package verification. It does not establish universal coding-agent compatibility, native model consumption, or two-physical-host acceptance. Normal project trust, enterprise policy and MCP approval remain necessary. See [setup](setup.md), [network operations](network-operations.md), and [wake support](network-wake.md).

## Remaining acceptance

The new connection flow still requires the [two-host acceptance checklist](network-macbook-pilot.md). Earlier pilot transcripts do not establish acceptance of this runtime. See [verification status](network-acceptance.md) for the published identity and current evidence limits.

GitHub source and documentation are being synchronized with the published 0.3.0 runtime. Source synchronization does not republish the immutable npm version, renew historical grants or assert a completed physical-host pass. Run the release gates after source changes; keep generated logs, private state, invitation codes and internal handoff notes out of Git.
