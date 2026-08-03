import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAgentPanes, inferAgentKind, parseTmuxListPanes } from './tmux.js';

test('inferAgentKind detects common coding agents from multiple tmux signals', () => {
  assert.equal(inferAgentKind('claude'), 'claude');
  assert.equal(inferAgentKind('node', 'Codex CLI'), 'codex');
  assert.equal(inferAgentKind('node', undefined, 'codex exec run'), 'codex');
  assert.equal(inferAgentKind('sleep', undefined, undefined, 'agentlink-codex-a'), 'codex');
  assert.equal(inferAgentKind('opencode'), 'opencode');
  assert.equal(inferAgentKind('copilot'), 'copilot');
  assert.equal(inferAgentKind('node', 'GitHub Copilot CLI'), 'copilot');
  assert.equal(inferAgentKind('gemini'), 'gemini');
  assert.equal(inferAgentKind('zsh'), 'unknown');
});

test('parseTmuxListPanes parses current tmux output including labels and start commands', () => {
  const panes = parseTmuxListPanes('%1\tmain\t0\tagents\t0\tnode\tcodex exec task\t/Users/sruthiki/work/api\tzsh\n%2\tmain\t0\tshell\t1\tzsh\t-zsh\t/Users/sruthiki/work/web\tzsh\n');
  assert.equal(panes.length, 2);
  assert.deepEqual(panes[0], {
    paneId: '%1',
    sessionName: 'main',
    windowIndex: '0',
    windowName: 'agents',
    paneIndex: '0',
    currentCommand: 'node',
    startCommand: 'codex exec task',
    currentPath: '/Users/sruthiki/work/api',
    title: 'zsh',
    agentKind: 'codex',
  });
  assert.equal(filterAgentPanes(panes).length, 1);
});

test('parseTmuxListPanes keeps compatibility with legacy seven-field fixtures', () => {
  const panes = parseTmuxListPanes('%1\tmain\t0\t0\tclaude\t/Users/sruthiki/work/api\tclaude\n');
  assert.deepEqual(panes[0], {
    paneId: '%1',
    sessionName: 'main',
    windowIndex: '0',
    windowName: '',
    paneIndex: '0',
    currentCommand: 'claude',
    startCommand: '',
    currentPath: '/Users/sruthiki/work/api',
    title: 'claude',
    agentKind: 'claude',
  });
});
