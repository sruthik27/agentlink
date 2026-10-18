# Verification status — AgentLink 0.3.0

Version 0.3.0 is published on npm. This record separates local engineering checks from native-agent and physical-host acceptance.

| Check | Status |
| --- | --- |
| Full versioned release test suite | 184/184 passing in the publication batch |
| Package hygiene and isolated installed CLI/MCP checks | PASS |
| Installed foundation, bridge and collaboration flows | PASS |
| Five generated MCP setup profiles and server handshakes | PASS; not universal native-client acceptance |
| Installed one-code pairing, bidirectional messages and identical-retry deduplication | PASS on local processes |
| Connection pinning, project/actor isolation, finite expiry, stop and bounded wait | Covered by local tests |
| Deterministic wake/adapter protocols | PASS; separate from model consumption |
| New connection flow on two physical hosts with actual agent sessions | **OPEN** |

The published package's runtime identity is `sha256:cd03a74cc4eb31a7c6a31dff69e27a5872cae22aedb3b9632af4865f3e2af94c` (41 runtime JavaScript files). The original npm archive SHA-256 is `93092f444bbad54ede1515096d4ffb4a62e1a71c469bbfcef5e2386adb3ee04d`. Documentation changes in this repository do not replace that immutable npm archive.

Earlier native Codex/OpenCode checks and reduced two-host transcripts cover historical builds. They cannot establish acceptance of the new runtime or substitute for complete session/restart evidence. Historical access windows have expired; no permission renewal is implied by publishing source or documentation.

## Remaining physical-host evidence

Use the [two-host acceptance guide](network-macbook-pilot.md) with explicitly authorized isolated fixtures. Record the same package/runtime identity on both hosts, actual model/tool turns and exact correlated messages, restart/session continuity, retry behavior, route identity preservation, authority-offline behavior, revocation, and unrelated-project isolation. Advanced agreement execution requires separate local owner permission.

Transport acceptance does not prove a model read or processed a message. A startup handshake does not prove a harness loaded MCP. Any missing required evidence leaves physical-host acceptance open.

Reproduce local gates with `npm ci` and `npm run verify:release`. The verifier writes local logs and an archive under ignored `.hermes/release/`; it does not publish, invoke models or renew access. See [release readiness](release-readiness.md).
