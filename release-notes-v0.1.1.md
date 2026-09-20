## AgentLink 0.1.1

AgentLink is a local-first coordination bus for coding agents working across related repositories. This patch completes the scoped npm package identity and installation workflow.

### Highlights

- npm package: `@sruthik/agentlink`.
- Executable names remain `agentlink` and `agentlink-mcp`.
- Setup guidance, package discovery, doctor, release checks, documentation, and tests consistently use the scoped package.
- Packaging checks use an isolated temporary npm cache and exclude source tests, source maps, and private workspace state.
- Existing v0.1.0 tags and release artifacts are preserved.

### Install

Requires Node.js 20 or newer.

```bash
npm install -g @sruthik/agentlink
agentlink version
agentlink doctor
codex mcp add agentlink -- agentlink-mcp
agentlink setup --harness all
```

Without a global install, inspect setup with:

```bash
npx @sruthik/agentlink setup --harness all
```

### Verification before release

- Full build and test suite: **53/53 tests passed**.
- Clean consumer installation: installed CLI version, setup, and doctor verified from the packed package.
- Actual Codex CLI integration: six MCP tool calls exercised conversation creation, message persistence, contract updates, approval gating, acceptance, peer sync, inbox reading, and closure.
- The integration smoke simulated two participant labels within one Codex session; it does not claim independent multi-agent testing.
- Both workspace contract files matched byte-for-byte; the real development workspace state was unchanged.
- Tarball checks verify published file allowlists, executable CLI/MCP binaries, and MCP initialization/version.

### Known limitation

GitHub Actions could not start because of an account billing restriction. This release was verified locally; it does not claim a green GitHub CI run. Live-agent workflows were exercised with Codex CLI; setup guides for other harnesses are provided but were not all independently retested for this patch.
