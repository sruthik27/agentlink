import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeNodeIdentity } from '../network/identity.js';
import { pairPeer, exposeAgent } from '../network/config.js';
import { exportPublicIdentity } from '../network/identity.js';
import { startNetworkServer } from '../network/server.js';
import { addGrant } from '../network/trust.js';
import { readMailboxState } from '../network/mailbox.js';
import { AGENTLINK_REMOTE_MCP_TOOLS, callRemoteAgentLinkTool } from './remote-tools.js';

test('remote MCP schemas require explicit targets and expose no sender or workspace rebinding input', () => {
  const send = AGENTLINK_REMOTE_MCP_TOOLS.find((tool) => tool.name === 'agentlink_remote_send');
  assert.ok(send);
  const schema = send.inputSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  assert.deepEqual(schema.required, ['peer', 'agent', 'conversationId', 'body']);
  assert.equal(schema.additionalProperties, false);
  assert.equal('sender' in schema.properties, false);
  assert.equal('actorId' in schema.properties, false);
  assert.equal('workspaceRoot' in schema.properties, false);
});

test('remote MCP send is bound to its startup actor and explicit workspace exposure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-remote-mcp-'));
  const localState = join(root, 'local-state');
  const remoteState = join(root, 'remote-state');
  const localRepo = join(root, 'local-repo');
  const otherRepo = join(root, 'other-repo');
  await Promise.all([import('node:fs/promises').then(({ mkdir }) => mkdir(localRepo)), import('node:fs/promises').then(({ mkdir }) => mkdir(otherRepo))]);
  t.after(async () => rm(root, { recursive: true, force: true }));
  await initializeNodeIdentity(localState, 'node-a');
  await initializeNodeIdentity(remoteState, 'node-b');
  const [localIdentity, remoteIdentity] = await Promise.all([exportPublicIdentity(localState), exportPublicIdentity(remoteState)]);
  await pairPeer(remoteState, { name: 'local', address: 'https://127.0.0.1:1', identity: localIdentity, expectedFingerprint: localIdentity.fingerprint });
  const server = await startNetworkServer({ stateRoot: remoteState, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  await pairPeer(localState, { name: 'remote', address: `https://127.0.0.1:${server.port}`, identity: remoteIdentity, expectedFingerprint: remoteIdentity.fingerprint });
  await exposeAgent(localState, { agentId: 'backend', workspaceRoot: localRepo, peerName: 'remote' });
  await addGrant(remoteState, {
    grantId: 'grant-mcp', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'selected-thread', actions: ['deliver'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const binding = { stateRoot: localState, agentId: 'backend', workspaceRoot: localRepo };
  const sent = await callRemoteAgentLinkTool('agentlink_remote_send', {
    peer: 'remote', agent: 'frontend', conversationId: 'selected-thread', body: 'bounded request', messageId: 'mcp-message',
  }, binding);
  assert.equal((sent.structuredContent?.task as { contextId: string }).contextId, 'selected-thread');
  assert.ok(sent.content.some(block => block.type === 'text' && block.text === JSON.stringify(sent.structuredContent)), 'native clients that omit structuredContent still receive the exact result');
  const senderOutbox = (await readMailboxState(localState)).outbox;
  assert.equal(senderOutbox.length, 1);
  assert.equal(senderOutbox[0]?.status, 'transport-received');
  await assert.rejects(
    callRemoteAgentLinkTool('agentlink_remote_send', {
      peer: 'remote', agent: 'frontend', conversationId: 'selected-thread', body: 'spoof attempt',
    }, { ...binding, agentId: 'attacker' }),
    /not owner-exposed/,
  );
  await assert.rejects(
    callRemoteAgentLinkTool('agentlink_remote_send', {
      peer: 'remote', agent: 'frontend', conversationId: 'selected-thread', body: 'wrong repo',
    }, { ...binding, workspaceRoot: otherRepo }),
    /not owner-exposed/,
  );
  const wrongWorkspaceStatus = await callRemoteAgentLinkTool('agentlink_remote_status', {}, { ...binding, workspaceRoot: otherRepo });
  assert.deepEqual(wrongWorkspaceStatus.structuredContent?.peers, []);
  assert.equal(wrongWorkspaceStatus.structuredContent?.received, 0);
  assert.equal(wrongWorkspaceStatus.structuredContent?.queued, 0);
  await assert.rejects(
    callRemoteAgentLinkTool('agentlink_remote_send', {
      peer: 'remote', agent: 'frontend', conversationId: 'other-thread', body: 'cross-thread',
    }, binding),
    /A2A error/,
  );
});
