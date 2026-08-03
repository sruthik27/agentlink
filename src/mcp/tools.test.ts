import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callAgentLinkTool, AGENTLINK_MCP_TOOLS } from './tools.js';
import { contractPath } from '../contract.js';

test('MCP tool registry exposes the initial AgentLink coordination surface', () => {
  assert.deepEqual(
    AGENTLINK_MCP_TOOLS.map((tool) => tool.name),
    [
      'agentlink_list_agents',
      'agentlink_start_conversation',
      'agentlink_send_message',
      'agentlink_read_inbox',
      'agentlink_update_contract',
      'agentlink_accept_contract',
      'agentlink_close_conversation',
    ],
  );
});

test('MCP tools drive a local conversation and contract lifecycle', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-mcp-tools-'));
  const peer = await mkdtemp(join(tmpdir(), 'agentlink-mcp-peer-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  });

  const started = await callAgentLinkTool('agentlink_start_conversation', {
    topic: 'Producer API shape',
    target: 'consumer-repo',
    requiredApprovals: 2,
  }, cwd);
  const startText = started.content[0].text;
  const id = startText.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(id);
  assert.match(startText, new RegExp(`Contract: ${contractPath(cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const sent = await callAgentLinkTool('agentlink_send_message', {
    conversationId: id,
    role: 'assistant',
    from: 'producer-agent',
    body: 'Please accept the response field rename.',
  }, cwd);
  assert.match(sent.content[0].text, new RegExp(`Message appended to ${id}`));

  const inbox = await callAgentLinkTool('agentlink_read_inbox', { conversationId: id, limit: 5 }, cwd);
  assert.match(inbox.content[0].text, new RegExp(`Conversation ${id} \\[open\\]: Producer API shape`));
  assert.match(inbox.content[0].text, /assistant\/producer-agent: Please accept the response field rename\./);

  const updatedContract = await callAgentLinkTool('agentlink_update_contract', {
    status: 'Proposed',
    section: 'Agreed Changes',
    content: '- Provider adds `expiresAt`.\n- Consumer treats it as required.',
  }, cwd);
  assert.match(updatedContract.content[0].text, /Contract: Proposed/);

  const contractContent = await readFile(contractPath(cwd), 'utf8');
  assert.match(contractContent, /## Agreed Changes\s+- Provider adds `expiresAt`\.\s+- Consumer treats it as required\./);
  assert.match(contractContent, /## Status\s+Proposed/);

  await assert.rejects(
    callAgentLinkTool('agentlink_accept_contract', { syncTo: peer }, cwd),
    /Cannot mark Accepted: conversation .* has 0\/2 required approvals/,
  );
  assert.match((await callAgentLinkTool('agentlink_update_contract', { approvedBy: 'producer-agent' }, cwd)).content[0].text, /Contract: Proposed/);
  assert.match((await callAgentLinkTool('agentlink_update_contract', { approvedBy: 'consumer-agent' }, cwd)).content[0].text, /Contract: Proposed/);

  const accepted = await callAgentLinkTool('agentlink_accept_contract', { syncTo: peer }, cwd);
  assert.match(accepted.content[0].text, /Contract: Accepted/);
  assert.match(accepted.content[0].text, new RegExp(`Conversation: ${id}`));

  const peerContract = await readFile(join(peer, '.agentlink', 'CONTRACT.md'), 'utf8');
  assert.match(peerContract, /## Status\s+Accepted/);
  assert.match(peerContract, new RegExp(`agentlink-conversation: ${id}`));

  const closed = await callAgentLinkTool('agentlink_close_conversation', { conversationId: id }, cwd);
  assert.match(closed.content[0].text, new RegExp(`Closed conversation ${id}`));
});
