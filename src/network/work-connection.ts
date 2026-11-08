import { readConnection } from './connect.js';
import { exportPublicIdentity } from './identity.js';
import { resolvePairedPeer } from './config.js';
import { validateNetworkId } from './types.js';

export async function workConnection(workspace: string, id: unknown) {
  const connection = await readConnection(workspace, validateNetworkId(id, 'connection'));
  if (!connection.peerActor || !connection.peerNode) throw new Error('Connection pairing is not complete');
  const [identity, peer] = await Promise.all([exportPublicIdentity(connection.root), resolvePairedPeer(connection.root, 'peer')]);
  if (connection.peerNode !== peer.nodeId) throw new Error('Connection pinned peer changed');
  return { connection, actor: { nodeId: identity.nodeId, actorId: connection.actor, fingerprint: identity.fingerprint },
    other: { nodeId: peer.nodeId, actorId: connection.peerActor, fingerprint: peer.identity.fingerprint }, peer };
}
