import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runCli } from './cli.js';
import { createConversation, readConversation } from './store.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
  return stdout;
}

test('CLI start renders a selected contract template', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-template-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await run(cwd, [
    'start',
    '--topic',
    'Add account summary endpoint',
    '--template',
    'api-change',
  ]);

  const content = await readFile(join(cwd, '.agentlink', 'CONTRACT.md'), 'utf8');
  assert.match(content, /## API Surface/);
  assert.match(content, /- \[ \] Request schema:/);
  assert.match(content, /- \[ \] Provider repo changes:/);
  assert.match(content, /- \[ \] Cross-repo integration test:/);
});



test('CLI deterministically merges a contract section and preserves status updates', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-section-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const started = await run(cwd, [
    'start',
    '--topic',
    'Add account summary endpoint',
    '--template',
    'api-change',
  ]);
  const id = started.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(id);

  const updated = await run(cwd, [
    'contract',
    '--status',
    'Proposed',
    '--set-section',
    'API Surface',
    '--content',
    '- [x] Endpoint: `GET /accounts/:id/summary`\n- [x] Response: `{ id, balance, expiresAt }`',
  ]);

  assert.match(updated, /Contract: Proposed/);
  assert.match(updated, new RegExp(`Conversation: ${id}`));
  const content = await readFile(join(cwd, '.agentlink', 'CONTRACT.md'), 'utf8');
  assert.match(content, /## API Surface\s+- \[x\] Endpoint: `GET \/accounts\/:id\/summary`/);
  assert.doesNotMatch(content, /- \[ \] Request schema:/);
  assert.match(content, /## Status\s+Proposed/);
});

test('CLI rejects invalid contract templates and lists valid names', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-invalid-template-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cliPath, 'start', '--topic', 'Unknown workflow', '--template', 'service-change'],
      { cwd },
    ),
    (error: unknown) => {
      const result = error as Error & { code: number; stderr: string };
      assert.equal(result.code, 2);
      assert.match(
        result.stderr,
        /Invalid contract template: service-change\. Expected one of: api-change, event-contract, db-migration, frontend-backend/,
      );
      assert.match(result.stderr, /Run `agentlink help` for usage\./);
      return true;
    },
  );
});

test('CLI prints compact repo context in markdown and JSON formats', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-context-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'context-service',
    scripts: { test: 'node --test', build: 'tsc' },
  }), 'utf8');

  const markdown = await run(cwd, ['context']);
  assert.match(markdown, /# AgentLink Repo Context/);
  assert.match(markdown, /- Git: not a repository/);
  assert.match(markdown, /- Package: context-service/);
  assert.match(markdown, /- Scripts: build, test/);

  const json = JSON.parse(await run(cwd, ['context', '--format', 'json'])) as {
    workspaceName: string;
    git: { isRepo: boolean; dirtyFiles: number };
    package: { name: string; scripts: string[] };
  };
  assert.match(json.workspaceName, /^agentlink-cli-context-/);
  assert.deepEqual(json.git, { isRepo: false, dirtyFiles: 0 });
  assert.deepEqual(json.package, { name: 'context-service', scripts: ['build', 'test'] });
});

test('CLI doctor reports local readiness checks in text and JSON', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-doctor-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'doctor-service',
    scripts: { agentlink: 'node dist/cli.js', build: 'tsc', test: 'node --test' },
  }), 'utf8');

  const doctor = await run(cwd, ['doctor']);
  assert.match(doctor, /AgentLink Doctor/);
  assert.match(doctor, /\[ok\] Node\.js:/);
  assert.match(doctor, /\[ok\] npm scripts: agentlink, build, test/);
  assert.match(doctor, /\[warn\] workspace: not initialized; run `agentlink init`/);
  assert.match(doctor, /Result: ready with no hard failures\./);

  const json = JSON.parse(await run(cwd, ['doctor', '--format', 'json'])) as {
    checks: Array<{ status: string; label: string; detail: string }>;
    hasFailures: boolean;
  };
  assert.equal(json.hasFailures, false);
  assert.equal(json.checks.find((check) => check.label === 'package.json')?.detail, 'doctor-service');
  assert.equal(json.checks.find((check) => check.label === 'workspace')?.status, 'ok');
});

test('CLI setup prints MCP/harness setup guide in markdown and JSON', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-setup-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'setup-service',
    version: '1.2.3',
  }), 'utf8');

  const markdown = await run(cwd, ['setup', '--harness', 'codex']);
  assert.match(markdown, /# AgentLink Setup Guide/);
  assert.match(markdown, /- Package: setup-service 1\.2\.3/);
  assert.match(markdown, /### Codex CLI/);
  assert.match(markdown, /npm run agentlink -- start --topic/);
  assert.doesNotMatch(markdown, /### Claude Code/);

  const json = JSON.parse(await run(cwd, ['setup', '--harness', 'stdio', '--format', 'json'])) as {
    packageName: string;
    version: string;
    mcpCommand: string;
    mcpArgs: string[];
    harnesses: string[];
  };
  assert.equal(json.packageName, 'setup-service');
  assert.equal(json.version, '1.2.3');
  assert.equal(json.mcpCommand, 'node');
  assert.equal(json.mcpArgs.length, 1);
  assert.match(json.mcpArgs[0], /agentlink-cli-setup-.*\/dist\/mcp\/server\.js$/);
  assert.deepEqual(json.harnesses, ['stdio']);
});

test('CLI setup rejects unsupported harness names', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-setup-invalid-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'setup', '--harness', 'cursor'], { cwd }),
    (error: unknown) => {
      const result = error as Error & { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Invalid setup harness: cursor\. Expected one of: stdio, claude-code, codex, copilot, opencode, gemini/);
      return true;
    },
  );
});

test('CLI version prints the package version for installed harness checks', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-version-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '9.8.7',
  }), 'utf8');

  assert.equal(await run(cwd, ['version']), '9.8.7\n');
  assert.equal(await run(cwd, ['--version']), '9.8.7\n');
});

test('CLI ship-check prints launch readiness in text and JSON', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-ship-check-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.1.0',
    license: 'MIT',
    bin: { agentlink: './dist/cli.js', 'agentlink-mcp': './dist/mcp/server.js' },
    files: ['README.md', 'dist/**/*.js', 'dist/**/*.d.ts', '!dist/**/*.test.js', '!dist/**/*.test.d.ts'],
    scripts: { agentlink: 'node dist/cli.js', build: 'tsc', test: 'node --test' },
    keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), [
    'cross-repo contract negotiation',
    'Structured bus is source of truth',
    'tmux pane messaging is notification/bridge',
    'npm run agentlink -- setup',
    'npm run agentlink -- doctor',
    'npm run agentlink -- demo --peer ../peer-repo',
    'npm run agentlink -- replay',
    'npm run agentlink -- version',
    'npm run agentlink -- launch-brief',
    'node dist/mcp/server.js',
  ].join('\n'), 'utf8');

  const text = await run(cwd, ['ship-check']);
  assert.match(text, /AgentLink Ship Check/);
  assert.match(text, /\[warn\] CLI build artifact: missing/);
  assert.match(text, /Launch boundary: Do not npm publish/);
  assert.match(text, /Result: ready for final verified demo and human launch approval/);

  const json = JSON.parse(await run(cwd, ['ship-check', '--format', 'json'])) as {
    packageName: string;
    launchBoundary: string;
    hasFailures: boolean;
  };
  assert.equal(json.packageName, 'agentlink');
  assert.equal(json.hasFailures, false);
  assert.match(json.launchBoundary, /explicit Sruthik approval/);
});

test('CLI launch-brief prints final approval brief in markdown and JSON', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-launch-brief-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.1.0',
  }), 'utf8');

  const markdown = await run(cwd, ['launch-brief']);
  assert.match(markdown, /# AgentLink Launch Approval Brief/);
  assert.match(markdown, /Approval required: yes/);
  assert.match(markdown, /`npm test`/);
  assert.match(markdown, /without explicit Sruthik approval/);

  const json = JSON.parse(await run(cwd, ['launch-brief', '--format', 'json'])) as {
    approvalRequired: boolean;
    ceoDecisionsNeeded: string[];
  };
  assert.equal(json.approvalRequired, true);
  assert.ok(json.ceoDecisionsNeeded.length >= 3);
});

test('CLI demo runs a deterministic two-repo contract negotiation smoke', async (t) => {
  const local = await mkdtemp(join(tmpdir(), 'agentlink-cli-demo-local-'));
  const peer = await mkdtemp(join(tmpdir(), 'agentlink-cli-demo-peer-'));
  t.after(async () => {
    await rm(local, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  });

  const demo = await run(local, ['demo', '--peer', peer, '--format', 'json']);
  const result = JSON.parse(demo) as {
    conversationId: string;
    status: string;
    messages: number;
    approvals: number;
    localContractPath: string;
    peerContractPath: string;
  };

  assert.equal(result.status, 'Accepted');
  assert.equal(result.messages, 2);
  assert.equal(result.approvals, 2);
  assert.match(result.localContractPath, /\.agentlink\/CONTRACT\.md$/);
  assert.match(result.peerContractPath, /\.agentlink\/CONTRACT\.md$/);

  const localContract = await readFile(join(local, '.agentlink', 'CONTRACT.md'), 'utf8');
  const peerContract = await readFile(join(peer, '.agentlink', 'CONTRACT.md'), 'utf8');
  assert.equal(peerContract, localContract);
  assert.match(localContract, /## API Surface/);
  assert.match(localContract, /GET \/accounts\/:id\/summary/);
  assert.match(localContract, /## Status\s+Accepted/);

  const replay = await run(local, ['replay', '--conversation', result.conversationId]);
  assert.match(replay, /message assistant\/producer-agent: Proposal:/);
  assert.match(replay, /message assistant\/consumer-agent: Accepted if expiresAt/);
  assert.match(replay, /approval from producer-agent/);
  assert.match(replay, /approval from consumer-agent/);
  assert.match(replay, /status: closed/);
});

test('CLI runs the init/start/send/read/status/end lifecycle', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  assert.match(await run(cwd, ['init']), /AgentLink workspace ready:/);
  const started = await run(cwd, [
    'start',
    '--topic',
    'OAuth contract change',
    '--target',
    'api-agent',
  ]);
  const id = started.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(id);

  assert.match(
    await run(cwd, [
      'send',
      '--role',
      'assistant',
      '--from',
      'web-agent',
      '--body',
      'Please add expiresAt.',
    ]),
    new RegExp(`Message appended to ${id}`),
  );

  const read = await run(cwd, ['read', '--conversation', id]);
  assert.match(read, new RegExp(`Conversation ${id} \\[open\\]`));
  assert.match(read, /assistant\/web-agent: Please add expiresAt\./);

  const status = await run(cwd, ['status']);
  assert.match(status, new RegExp(`${id} \\[open\\] OAuth contract change -> api-agent \\(1 messages\\)`));
  assert.match(status, /Contract: Draft/);

  const updatedContract = await run(cwd, ['contract', '--status', 'Accepted']);
  assert.match(updatedContract, /Contract: Accepted/);
  assert.match(updatedContract, new RegExp(`Conversation: ${id}`));

  assert.match(await run(cwd, ['approve', '--from', 'web-agent']), new RegExp(`Approval recorded for ${id} from web-agent`));
  assert.match(await run(cwd, ['end']), new RegExp(`Closed conversation ${id}`));
  assert.match(await run(cwd, ['read', id]), new RegExp(`Conversation ${id} \\[closed\\]`));

  const replay = await run(cwd, ['replay', id]);
  assert.match(replay, new RegExp(`Conversation ${id} \\[closed\\]: OAuth contract change`));
  assert.match(replay, /conversation started: OAuth contract change -> api-agent/);
  assert.match(replay, /message assistant\/web-agent: Please add expiresAt\./);
  assert.match(replay, /approval from web-agent/);
  assert.match(replay, /status: closed/);

  const replayJson = JSON.parse(await run(cwd, ['replay', '--conversation', id, '--format', 'json'])) as {
    conversation: { id: string; status: string; messages: unknown[]; approvals: unknown[] };
    records: Array<{ type: string }>;
  };
  assert.equal(replayJson.conversation.id, id);
  assert.equal(replayJson.conversation.status, 'closed');
  assert.equal(replayJson.conversation.messages.length, 1);
  assert.equal(replayJson.conversation.approvals.length, 1);
  assert.deepEqual(replayJson.records.map((record) => record.type), ['conversation', 'message', 'approval', 'status']);

  const records = (await readFile(join(cwd, '.agentlink', 'conversations', `${id}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), ['conversation', 'message', 'approval', 'status']);
});

test('CLI can sync the current contract to a peer repo workspace', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'agentlink-cli-source-'));
  const peer = await mkdtemp(join(tmpdir(), 'agentlink-cli-peer-'));
  t.after(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  });

  const started = await run(source, [
    'start',
    '--topic',
    'Producer API shape',
    '--target',
    'consumer-repo',
  ]);
  const id = started.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(id);

  const synced = await run(source, ['contract', '--status', 'Proposed', '--sync-to', peer]);
  const peerContractPath = join(peer, '.agentlink', 'CONTRACT.md');

  assert.match(synced, /Contract: Proposed/);
  assert.match(synced, new RegExp(`Conversation: ${id}`));
  assert.match(synced, new RegExp(`Synced contract: ${peerContractPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const content = await readFile(peerContractPath, 'utf8');
  assert.match(content, new RegExp(`agentlink-conversation: ${id}`));
  assert.match(content, /## Topic\s+Producer API shape/);
  assert.match(content, /## Participants\s+- Local workspace\s+- consumer-repo/);
  assert.match(content, /## Status\s+Proposed/);
});



test('CLI enforces max rounds and approval gates before Accepted', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-gates-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const started = await run(cwd, [
    'start',
    '--topic',
    'Bounded API negotiation',
    '--max-rounds',
    '1',
    '--required-approvals',
    '2',
  ]);
  const id = started.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(id);
  assert.match(started, /Max rounds: 1/);
  assert.match(started, /Required approvals: 2/);

  assert.match(await run(cwd, ['send', '--body', 'Proposal v1']), new RegExp(`Message appended to ${id}`));
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'send', '--body', 'Proposal v2'], { cwd }),
    (error: unknown) => {
      const result = error as Error & { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /reached its max round limit \(1\)/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'contract', '--status', 'Accepted'], { cwd }),
    (error: unknown) => {
      const result = error as Error & { code: number; stderr: string };
      assert.equal(result.code, 2);
      assert.match(result.stderr, /Cannot mark Accepted: conversation .* has 0\/2 required approvals/);
      return true;
    },
  );

  assert.match(await run(cwd, ['approve', '--from', 'producer-agent']), /1\/2/);
  assert.match(await run(cwd, ['approve', '--from', 'consumer-agent']), /2\/2/);
  assert.match(await run(cwd, ['contract', '--status', 'Accepted']), /Contract: Accepted/);

  const status = await run(cwd, ['status']);
  assert.match(status, /1 messages, max 1 rounds, approvals 2\/2/);
});


test('CLI appends before delivery and preserves the message when tmux delivery fails', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-cli-delivery-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await createConversation(cwd, {
    id: 'conversation-1',
    topic: 'OAuth contract change',
    createdAt: '2026-07-25T08:00:00.000Z',
  });

  const logs: string[] = [];
  let messageWasStoredBeforeDelivery = false;
  await assert.rejects(
    runCli(
      ['send', '--body', 'Please add expiresAt.', '--deliver-to', '%9'],
      cwd,
      {
        log: (message) => logs.push(message),
        error: () => {},
      },
      async (input) => {
        assert.equal(input.paneId, '%9');
        const delivered = JSON.parse(input.text) as Record<string, unknown>;
        assert.equal(typeof delivered.timestamp, 'string');
        assert.deepEqual({ ...delivered, timestamp: '<timestamp>' }, {
          conversationId: 'conversation-1',
          type: 'message',
          role: 'user',
          from: 'human',
          body: 'Please add expiresAt.',
          timestamp: '<timestamp>',
        });
        const conversation = await readConversation(cwd, 'conversation-1');
        messageWasStoredBeforeDelivery = conversation.messages.length === 1;
        throw new Error('target pane is unavailable');
      },
    ),
    /target pane is unavailable/,
  );

  const conversation = await readConversation(cwd, 'conversation-1');
  assert.equal(messageWasStoredBeforeDelivery, true);
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].body, 'Please add expiresAt.');
  assert.match(logs[0], /Message appended to conversation-1/);
  assert.equal(logs.some((line) => line.includes('Message delivered')), false);
});
