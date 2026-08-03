import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'copilot' | 'gemini' | 'kimi' | 'unknown';

export interface TmuxPane {
  paneId: string;
  sessionName: string;
  windowIndex: string;
  windowName: string;
  paneIndex: string;
  currentCommand: string;
  startCommand: string;
  currentPath: string;
  title: string;
  agentKind: AgentKind;
}

export function inferAgentKind(...signals: Array<string | undefined>): AgentKind {
  const text = signals.filter(Boolean).join(' ').toLowerCase();
  if (text.includes('claude')) return 'claude';
  if (text.includes('codex')) return 'codex';
  if (text.includes('opencode')) return 'opencode';
  if (text.includes('copilot')) return 'copilot';
  if (text.includes('gemini')) return 'gemini';
  if (text.includes('kimi')) return 'kimi';
  return 'unknown';
}

export function parseTmuxListPanes(output: string): TmuxPane[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      const [paneId, sessionName, windowIndex, fourth, fifth, sixth, seventh, eighth, ninth] = fields;
      const hasWindowName = fields.length >= 9;
      const windowName = hasWindowName ? fourth : '';
      const paneIndex = hasWindowName ? fifth : fourth;
      const currentCommand = hasWindowName ? sixth : fifth;
      const startCommand = hasWindowName ? seventh : '';
      const currentPath = hasWindowName ? eighth : sixth;
      const title = hasWindowName ? ninth : seventh;
      return {
        paneId,
        sessionName,
        windowIndex,
        windowName: windowName ?? '',
        paneIndex,
        currentCommand,
        startCommand: startCommand ?? '',
        currentPath,
        title: title ?? '',
        agentKind: inferAgentKind(currentCommand, title, startCommand, sessionName, windowName),
      };
    });
}

export async function listTmuxPanes(): Promise<TmuxPane[]> {
  const format = '#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_current_command}\t#{pane_start_command}\t#{pane_current_path}\t#{pane_title}';
  try {
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', format], { timeout: 5000 });
    return parseTmuxListPanes(stdout);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') throw new Error('tmux is not installed or not on PATH');
    if ((err.stderr ?? '').includes('no server running') || (err.stderr ?? '').includes('error connecting')) return [];
    throw error;
  }
}

export function filterAgentPanes(panes: TmuxPane[]): TmuxPane[] {
  return panes.filter((pane) => pane.agentKind !== 'unknown');
}
