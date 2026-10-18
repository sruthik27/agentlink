# AgentLink 0.3.1

Install once for your user, use it across repositories, and keep connected agents communicating with fewer manual steps.

## Changes

- User-wide MCP setup with `agentlink setup --harness <profile> --scope user --write --check` for Claude Code, Codex, Copilot CLI, Gemini CLI and OpenCode. Existing project mode is preserved; conflicting config still requires an explicit merge.
- A session-aware global launcher that does not create project state in the harness's startup/config directory. Each agent selects its working directory through `agentlink_session`, with a pinned actor/workspace per MCP process.
- Acceptor-side long waits retry transient authenticated network checks within the original deadline. Cancellation interrupts requests. Trust, authorization, malformed-response and scope failures still fail immediately; sends are never automatically retried.
- Code pairing returns native consumer instructions and a structured `connect monitor` command. Agents with a native stdout-waking Monitor/background facility can start it automatically in the same session. It emits incoming references, filters own messages, reports unavailable/recovered checks and stops at existing expiry. It never launches a competing model worker or renews access.

## Verification before release

Run `npm run verify:release` for the full suite, shipping hygiene, isolated installed foundation/bridge/collaboration, project and user MCP setup handshakes, installed connection pairing and deterministic wake/adapter protocols. Regression coverage includes simultaneous global sessions in different workspaces and a real delayed authenticated acceptor-side request followed by recovery, bounded timeout, cancellation, authorization/malformed errors, no send retry and native monitor output/stop.

## Known limitation

Native model wake depends on the harness exposing a background consumer capable of resuming the same session. Starting a detached shell watcher is not proof of automatic model processing. Actual physical-host/native acceptance of this runtime remains open. No relay/NAT traversal or permission bypass is provided. New MCP registration usually needs one reconnect; project settings can shadow a user-level entry. A shared MCP process across unrelated sessions needs separate per-session server instances or CLI use.
