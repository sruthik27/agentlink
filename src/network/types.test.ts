import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ENVELOPE_BODY_BYTES, parseEnvelope } from './types.js';

const validEnvelope = () => ({
  version: 1 as const,
  eventId: 'event-1',
  sender: { nodeId: 'node-a', agentId: 'backend' },
  recipient: { nodeId: 'node-b', agentId: 'frontend' },
  collaborationId: 'orders-v2',
  kind: 'message' as const,
  body: 'hello',
  createdAt: '2026-10-10T04:00:00.000Z',
});

test('wire envelope validation is strict, versioned, bounded, and path-safe', () => {
  assert.deepEqual(parseEnvelope(validEnvelope()), validEnvelope());
  assert.throws(() => parseEnvelope({ ...validEnvelope(), version: 2 }), /version/);
  assert.throws(() => parseEnvelope({ ...validEnvelope(), eventId: '../escape' }), /eventId/);
  assert.throws(() => parseEnvelope({ ...validEnvelope(), extra: true }), /unknown field/);
  assert.throws(
    () => parseEnvelope({ ...validEnvelope(), body: 'x'.repeat(MAX_ENVELOPE_BODY_BYTES + 1) }),
    /body.*bytes/,
  );
});
