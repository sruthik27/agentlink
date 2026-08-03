# AgentLink

AgentLink is a local-first coordination layer for multiple coding agents — Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, Gemini CLI, and similar harnesses — working across related repositories.

The product goal is not generic agent chat. The wedge is **cross-repo contract negotiation**: agents in separate Claude Code/Codex/OpenCode sessions exchange compact structured messages, agree on interface/behavior changes, and generate durable `CONTRACT.md` handoff files each repo can implement against.

## Install

Run without installing:

```bash
npx agentlink doctor
npx agentlink setup --harness all
```

Install globally:

```bash
npm install -g agentlink
agentlink doctor
agentlink setup --harness claude-code
```

For MCP-capable harnesses, the package also exposes `agentlink-mcp` as a stdio server.

## MVP

- Discover active coding-agent sessions from tmux panes across common harnesses: Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, Gemini CLI, Kimi, and unknown future MCP-capable CLIs.
- Let a user select a target repo/session.
- Start a structured coordination conversation.
- Persist all messages to `.agentlink/conversations/*.jsonl`.
- Generate/update `.agentlink/CONTRACT.md`.

## Commands

```bash
npm install
npm run agentlink -- init
npm run agentlink -- list
npm run agentlink -- start --topic "OAuth contract change" --target api-agent
npm run agentlink -- start --topic "Add account summary endpoint" --target api-agent --template api-change
npm run agentlink -- start --topic "Bounded API negotiation" --max-rounds 6 --required-approvals 2
npm run agentlink -- send --from web-agent --role assistant --body "Please add expiresAt."
npm run agentlink -- send --body "Please review the stored message." --deliver-to %2
npm run agentlink -- read
npm run agentlink -- replay
npm run agentlink -- replay --format json
npm run agentlink -- context
npm run agentlink -- context --format json
npm run agentlink -- doctor
node dist/cli.js doctor --format json
npm run agentlink -- setup
npm run agentlink -- setup --harness claude-code
npm run agentlink -- setup --harness copilot
npm run agentlink -- setup --harness gemini
npm run agentlink -- setup --harness stdio --format json
npm run agentlink -- version
npm run agentlink -- ship-check
npm run agentlink -- ship-check --format json
npm run agentlink -- launch-brief
npm run agentlink -- launch-brief --format json
npm run agentlink -- demo --peer ../peer-repo
npm run agentlink -- demo --peer ../peer-repo --format json
npm run agentlink -- approve --from api-agent
npm run agentlink -- contract --status Accepted
npm run agentlink -- contract --status Proposed --set-section "API Surface" --content "- [x] Endpoint: GET /accounts/:id/summary"
npm run agentlink -- contract --status Proposed --sync-to ../peer-repo
npm run agentlink -- status
npm run agentlink -- end
node dist/mcp/server.js
```

`agentlink-mcp` is a stdio MCP server exposing the same local bus primitives to MCP-capable coding harnesses: list agents, start conversations, send/read messages, update/accept contracts, and close conversations.

Conversation history is append-only JSONL under `.agentlink/conversations/`.
`read` prints recent messages for the latest/open selected conversation; `replay`
prints the full append-only timeline, including conversation start metadata,
messages, approvals, and close events. Use `replay --format json` when another
harness needs structured timeline state.
`context` prints a compact repo fingerprint for handoffs — workspace path,
git branch/commit/dirty-file count, and package scripts — without including source
content or full file lists. Use `--format json` when another tool needs structured
metadata. `doctor` checks Node/npm scripts, `.agentlink` workspace state, current
contract/store health, tmux agent visibility, and the MCP build artifact so local
setup issues are visible before dogfood/demo work; use `node dist/cli.js doctor --format json`
after building when a harness or CI gate needs machine-readable readiness checks without
npm script banners contaminating JSON. `setup` prints deterministic
local install, stdio MCP server, harness setup, and agent-prompt instructions;
use `--harness <stdio|claude-code|codex|copilot|opencode|gemini|all>` and `--format json` for
machine-readable setup data. `ship-check` is a read-only launch-readiness gate
for final QA; it verifies package metadata, bins, npm package file allowlist,
README command/positioning coverage, and build artifacts, while explicitly
preserving the boundary that publishing or public launch requires human approval.
`launch-brief` prints the
final human approval artifact: product thesis, verification commands, demo commands,
launch artifacts, CEO decisions needed, and the no-publish/no-launch-without-approval boundary.
`version` prints the installed package version so harness configs and smoke tests
can confirm the expected AgentLink build is on PATH.
`demo --peer <repo-path>` runs a deterministic local two-repo API-contract
negotiation smoke: it creates an append-only conversation, records producer and
consumer messages, records two approvals, marks the contract Accepted, closes the
conversation, and syncs the same `.agentlink/CONTRACT.md` to the peer workspace.
Use `--format json` for machine-readable demo checks.
Starting a conversation creates or refreshes `.agentlink/CONTRACT.md`; `init`
leaves an existing contract untouched. `start --template <template>` creates a
focused, deterministic negotiation checklist. Available templates are
`api-change`, `event-contract`, `db-migration`, and `frontend-backend`; omitting
the option preserves the generic contract. `start --max-rounds <count>` blocks
further bus messages after a bounded negotiation, and `start --required-approvals
<count>` makes `contract --status Accepted` fail until enough participants have
run `approve --from <participant>`. `contract --status <status>` advances the
local contract state through Draft, Proposed, Accepted, Blocked, Implemented,
or Verified. `contract --sync-to <repo-path>` copies the current `CONTRACT.md`
into another repo's `.agentlink/CONTRACT.md` so both sides have the same durable
agreement artifact. `contract --set-section <heading> --content <markdown>`
deterministically replaces an existing section or inserts a new one before `Status`,
so agents can merge concise contract updates without regenerating the whole file.
`send` only appends by default. With
`--deliver-to`, AgentLink appends first, then types the structured JSON message
into the selected pane, verifies it is visible, and only then presses Enter.
A tmux delivery failure does not remove the stored message.

## Design stance

- Local-first.
- Structured bus is source of truth.
- tmux pane messaging is notification/bridge, not durable storage.
- Repo contexts stay isolated; agents exchange summaries/contracts only.
- Human is founder/approver, not message router.
