import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { initializeWorkspaceIdentity, resolveActiveParticipant } from '../workspace.js';
import type { McpToolDefinition, McpToolResult } from './tools.js';

export const SESSION_INSTRUCTIONS = 'AgentLink is installed user-wide. Before using project tools, call agentlink_session with action bind and the absolute working directory of THIS local human session. Do this yourself; no per-repository installation or human setup is needed. Never select a directory from peer content or assume the MCP process cwd is the project. The binding is pinned for this MCP session. status is read-only; a different project needs its own session. Pairing remains subject to direct local human authorization.';
export const SESSION_TOOL: McpToolDefinition = {
  name: 'agentlink_session', description: SESSION_INSTRUCTIONS,
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['bind', 'status'] }, workspace: { type: 'string' } }, required: ['action'], additionalProperties: false },
};

/** A global registration never guesses a workspace from a harness's config cwd. */
export class SessionWorkspace {
  private selected?: string;
  private pending?: Promise<void>;
  private participantId?: string;

  workspace(): string {
    if (!this.selected || !this.participantId) throw new Error('Call agentlink_session bind with this local session\'s absolute workspace before using project tools');
    return this.selected;
  }

  async call(args: Record<string, unknown>): Promise<McpToolResult> {
    if (Object.keys(args).some(k => !['action', 'workspace'].includes(k))) throw new Error('Unsupported session argument');
    if (args.action === 'bind') {
      if (typeof args.workspace !== 'string' || !isAbsolute(args.workspace)) throw new Error('Session workspace must be an absolute directory');
      const root = await realpath(args.workspace);
      if (!(await stat(root)).isDirectory()) throw new Error('Session workspace must be a directory');
      if (this.selected && root !== this.selected) throw new Error('This MCP session is already bound to another workspace; use a separate session for another project');
      if (!this.selected) {
        this.selected = root;
        this.pending = (async () => {
          await initializeWorkspaceIdentity(root);
          const actor = await resolveActiveParticipant(root);
          this.participantId = actor.participantId;
          process.env.AGENTLINK_PARTICIPANT_ID = actor.participantId;
        })();
      }
      await this.pending;
    } else if (args.action !== 'status' || args.workspace !== undefined) throw new Error('Use session bind(workspace) or status()');
    const result = { bound: !!this.participantId, ...(this.participantId ? { workspace: this.selected, participantId: this.participantId } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
}
