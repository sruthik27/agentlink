import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callAgentLinkTool, AGENTLINK_MCP_TOOLS } from './tools.js';
import { contractPath } from '../contract.js';

test('MCP tool registry exposes the initial AgentLink coordination surface', () => {
  assert.deepEqual(
    AGENTLINK_MCP_TOOLS.map((tool) => tool.name),
    [
      'agentlink_list_agents',
      'agentlink_register_agent',
      'agentlink_heartbeat_agent',
      'agentlink_unregister_agent',
      'agentlink_list_tmux_agents',
      'agentlink_list_conversations',
      'agentlink_start_conversation',
      'agentlink_send_message',
      'agentlink_join_conversation',
      'agentlink_revoke_participant',
      'agentlink_approve_contract',
      'agentlink_read_inbox',
      'agentlink_wait_for_messages',
      'agentlink_ack_inbox',
      'agentlink_set_message_cap',
      'agentlink_retry_notification',
      'agentlink_update_contract',
      'agentlink_accept_contract',
      'agentlink_close_conversation',
    ],
  );
  const close = AGENTLINK_MCP_TOOLS.find((tool) => tool.name === 'agentlink_close_conversation');
  assert.deepEqual((close?.inputSchema as { required?: string[] }).required, ['conversationId']);
  const wait = AGENTLINK_MCP_TOOLS.find((tool) => tool.name === 'agentlink_wait_for_messages');
  assert.equal(((wait?.inputSchema.properties as Record<string, { maximum?: number }>).timeoutMs).maximum, 30_000);
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
    requiredApprovals: 1,
  }, cwd);
  const startText = started.content[0].text;
  const id = startText.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(id);
  assert.match(startText, /Contract: .*\.agentlink\/bus\/contracts\/.*\/CONTRACT\.md/);

  const sent = await callAgentLinkTool('agentlink_send_message', {
    conversationId: id,
    role: 'assistant',
    body: 'Please accept the response field rename.',
  }, cwd);
  assert.match(sent.content[0].text, new RegExp(`Message appended to ${id}`));

  const inbox = await callAgentLinkTool('agentlink_read_inbox', { conversationId: id, limit: 5 }, cwd);
  assert.match(inbox.content[0].text, new RegExp(`Conversation ${id} \\[open\\]: Producer API shape`));
  assert.match(inbox.content[0].text, /assistant\/.*: Please accept the response field rename\./);
  assert.equal(inbox.structuredContent?.unreadCount, 1);
  assert.equal(inbox.structuredContent?.hasMore, false);
  assert.equal(typeof inbox.structuredContent?.nextCursor, 'string');

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
    /Cannot mark Accepted: conversation .* has 0\/1 approvals for revision/,
  );
  assert.match((await callAgentLinkTool('agentlink_approve_contract', { conversationId: id }, cwd)).content[0].text, /Approval recorded/);

  const accepted = await callAgentLinkTool('agentlink_accept_contract', { syncTo: peer }, cwd);
  assert.match(accepted.content[0].text, /Contract: Accepted/);
  assert.match(accepted.content[0].text, new RegExp(`Conversation: ${id}`));

  const peerContract = await readFile(join(peer, '.agentlink', 'CONTRACT.md'), 'utf8');
  assert.match(peerContract, /## Status\s+Accepted/);
  assert.match(peerContract, new RegExp(`agentlink-conversation: ${id}`));

  const closed = await callAgentLinkTool('agentlink_close_conversation', { conversationId: id }, cwd);
  assert.match(closed.content[0].text, new RegExp(`Closed conversation ${id}`));
});

test('a clean stale compatibility view does not block an owner after a peer contract edit', async (t) => {
  const owner = await mkdtemp(join(tmpdir(), 'agentlink-mcp-stale-owner-'));
  const peer = await mkdtemp(join(tmpdir(), 'agentlink-mcp-stale-peer-'));
  t.after(async () => {
    await rm(owner, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  });

  const started = await callAgentLinkTool('agentlink_start_conversation', {
    topic: 'Peer edit followed by owner acceptance',
    requiredApprovals: 2,
  }, owner);
  const conversationId = started.content[0].text.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(conversationId);

  await callAgentLinkTool('agentlink_update_contract', {
    conversationId,
    status: 'Proposed',
    syncTo: peer,
  }, owner);
  await callAgentLinkTool('agentlink_join_conversation', { conversationId }, peer);
  const ownerProjectionBeforePeerEdit = await readFile(contractPath(owner), 'utf8');

  await callAgentLinkTool('agentlink_update_contract', {
    conversationId,
    section: 'Peer Review',
    content: 'Peer-confirmed requirement.',
  }, peer);
  assert.equal(await readFile(contractPath(owner), 'utf8'), ownerProjectionBeforePeerEdit);

  await callAgentLinkTool('agentlink_approve_contract', { conversationId }, peer);
  await callAgentLinkTool('agentlink_approve_contract', { conversationId }, owner);
  const accepted = await callAgentLinkTool('agentlink_accept_contract', {
    conversationId,
    syncTo: peer,
  }, owner);

  assert.match(accepted.content[0].text, /Contract: Accepted/);
  assert.match(await readFile(contractPath(owner), 'utf8'), /## Peer Review\s+Peer-confirmed requirement\./);
  assert.equal(await readFile(contractPath(owner), 'utf8'), await readFile(contractPath(peer), 'utf8'));
});

test('a locally edited compatibility view remains protected from contract mutation', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-mcp-edited-view-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));

  const started = await callAgentLinkTool('agentlink_start_conversation', {
    topic: 'Protect local compatibility edits',
  }, cwd);
  const conversationId = started.content[0].text.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(conversationId);
  await callAgentLinkTool('agentlink_update_contract', { conversationId, status: 'Proposed' }, cwd);

  const compatibilityPath = contractPath(cwd);
  const generated = await readFile(compatibilityPath, 'utf8');
  await writeFile(compatibilityPath, `${generated}\nlocal note that must not be overwritten\n`, 'utf8');

  await assert.rejects(
    callAgentLinkTool('agentlink_update_contract', {
      conversationId,
      section: 'Peer Review',
      content: 'Must not be committed.',
    }, cwd),
    /generated compatibility view was modified/,
  );
  assert.equal(await readFile(compatibilityPath, 'utf8'), `${generated}\nlocal note that must not be overwritten\n`);
});

test('compatibility metadata without a digest upgrades only when the projection still matches authority', async (t) => {
  const owner = await mkdtemp(join(tmpdir(), 'agentlink-mcp-selection-upgrade-owner-'));
  const peer = await mkdtemp(join(tmpdir(), 'agentlink-mcp-selection-upgrade-peer-'));
  t.after(async () => {
    await rm(owner, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  });

  const started = await callAgentLinkTool('agentlink_start_conversation', { topic: 'Selection metadata upgrade' }, owner);
  const conversationId = started.content[0].text.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(conversationId);
  await callAgentLinkTool('agentlink_update_contract', { conversationId, status: 'Proposed', syncTo: peer }, owner);

  const selectedPath = join(owner, '.agentlink', 'selected.json');
  const withoutDigest = JSON.parse(await readFile(selectedPath, 'utf8')) as Record<string, unknown>;
  delete withoutDigest.compatibilityDigest;
  await writeFile(selectedPath, `${JSON.stringify(withoutDigest, null, 2)}\n`, 'utf8');
  await callAgentLinkTool('agentlink_update_contract', {
    conversationId,
    section: 'Owner Review',
    content: 'Matching projection safely upgrades metadata.',
  }, owner);
  assert.match((JSON.parse(await readFile(selectedPath, 'utf8')) as { compatibilityDigest?: string }).compatibilityDigest ?? '', /^[a-f0-9]{64}$/);

  const legacyAgain = JSON.parse(await readFile(selectedPath, 'utf8')) as Record<string, unknown>;
  delete legacyAgain.compatibilityDigest;
  await writeFile(selectedPath, `${JSON.stringify(legacyAgain, null, 2)}\n`, 'utf8');
  await callAgentLinkTool('agentlink_update_contract', {
    conversationId,
    section: 'Peer Review',
    content: 'Authority now differs from the digest-less owner projection.',
  }, peer);
  await assert.rejects(
    callAgentLinkTool('agentlink_update_contract', {
      conversationId,
      section: 'Owner Review',
      content: 'Must refresh before this can proceed.',
    }, owner),
    /generated compatibility view was modified.*--refresh/i,
  );
});

test('MCP listing, safe targets, cursors, acknowledgement, caps, and cross-repo routing share authority', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'agentlink-mcp-routing-source-'));
  const peer = await mkdtemp(join(tmpdir(), 'agentlink-mcp-routing-peer-'));
  t.after(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  });

  const first = await callAgentLinkTool('agentlink_start_conversation', {
    topic: 'Shared API',
    maxMessages: 3,
  }, source);
  const firstId = first.content[0].text.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(firstId);
  await callAgentLinkTool('agentlink_update_contract', { conversationId: firstId, syncTo: peer, status: 'Proposed' }, source);
  await callAgentLinkTool('agentlink_join_conversation', { conversationId: firstId }, peer);

  const second = await callAgentLinkTool('agentlink_start_conversation', { topic: 'Other thread' }, source);
  const secondId = second.content[0].text.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(secondId);

  const listed = await callAgentLinkTool('agentlink_list_conversations', {}, peer);
  const summaries = listed.structuredContent?.conversations as Array<Record<string, unknown>>;
  assert.deepEqual(new Set(summaries.map((summary) => summary.id)), new Set([firstId, secondId]));
  assert.ok(summaries.every((summary) => typeof summary.updatedAt === 'string'));
  assert.ok(summaries.every((summary) => typeof summary.messageCount === 'number'));

  await assert.rejects(
    callAgentLinkTool('agentlink_send_message', { body: 'ambiguous' }, source),
    new RegExp(`ambiguous.*${firstId}.*${secondId}|ambiguous.*${secondId}.*${firstId}`, 'is'),
  );
  await assert.rejects(
    callAgentLinkTool('agentlink_close_conversation', {}, source),
    /Missing required argument: conversationId/,
  );

  const sent = await callAgentLinkTool('agentlink_send_message', {
    conversationId: firstId,
    role: 'assistant',
    body: '  exact shared body  ',
    kind: 'proposal',
    refs: [{ type: 'commit', value: 'abcdef1' }],
  }, peer);
  assert.match(sent.content[0].text, /Persisted message msg_/);
  assert.match(sent.content[0].text, /Notification: not attempted/);

  const inbox = await callAgentLinkTool('agentlink_read_inbox', { conversationId: firstId, limit: 1 }, source);
  const message = (inbox.structuredContent?.messages as Array<Record<string, unknown>>)[0];
  assert.equal(message.body, '  exact shared body  ');
  assert.equal(message.kind, 'proposal');
  assert.equal(inbox.structuredContent?.unreadCount, 1);
  await callAgentLinkTool('agentlink_ack_inbox', { conversationId: firstId, messageId: message.messageId }, source);
  assert.equal((await callAgentLinkTool('agentlink_read_inbox', { conversationId: firstId }, source)).structuredContent?.unreadCount, 0);

  await callAgentLinkTool('agentlink_set_message_cap', { conversationId: firstId, maxMessages: 5 }, source);
  const relisted = await callAgentLinkTool('agentlink_list_conversations', {}, peer);
  const shared = (relisted.structuredContent?.conversations as Array<Record<string, unknown>>).find((summary) => summary.id === firstId);
  assert.equal(shared?.messageCap, 5);
});
