# AgentLink 0.4.0 — team collaboration beta

Install once, connect by sharing one code, and let your existing coding agents
carry work through handoff, review/repair, delegation and joint investigation.

```sh
npm install -g @sruthik/agentlink@latest --prefer-online
agentlink version --format json
agentlink setup --harness claude-code --scope user --write --check
```

Choose your actual harness: claude-code, codex, copilot, gemini or opencode.
Existing MCP sessions may need one reconnect. See the [agent installation prompt](README.md#let-your-agent-set-it-up).

New in this release:

- Recipient-owned work, durable inboxes, session claims and restart reconciliation.
- Automatic authorized context packages with actual matching check evidence.
- Isolated result integration using locally registered executable checks, conflict
  detection, exact-byte evidence and preservation of the original dirty checkout.
- Finite review/repetition/time budgets and one durable owner escalation.
- Locally pinned peer names, project/capability routing and a readable activity view.
- Same-identity reconnect within existing access, retention and storage limits.

Beta users should try install/pair, handoff with the sender offline, review and
repair, session restart, and receiving/verifying a result. Report the version/build,
harness, OS, expected behavior and sanitized error. Never share connection codes,
private state, tokens or keys in a public issue.

## Verification before release

Local regression, real MCP/CLI and isolated installed-package workflows are
verified. The full suite passes 211 tests; installed CLI/MCP fixtures cover the four workflows and five team experience additions.

## Known limitations

Actual native idle model wake and two-physical-host acceptance remain
open. Idle wake requires a compatible native Monitor or explicitly configured
channel host; other harnesses use active polling. Direct reachable IP/LAN/VPN is
required. Pairing grants communication; repository execution requires standing
local owner policy. Registered checks are delegated code execution, not an OS sandbox.

See [team workflows](docs/team-workflows.md) for operation and authority details.
