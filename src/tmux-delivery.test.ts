import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverTmuxMessage,
  TmuxDeliveryError,
  type TmuxCommandRunner,
} from './tmux-delivery.js';

test('delivery reads, types, verifies, then presses Enter', async () => {
  const calls: string[][] = [];
  const text = '{"conversationId":"conversation-1","body":"Please review."}';
  let capture = 'agent> ';
  const runner: TmuxCommandRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'capture-pane') return { stdout: capture, stderr: '' };
    if (args[0] === 'send-keys' && args.includes('-l')) {
      capture += args.at(-1);
    }
    return { stdout: '', stderr: '' };
  };

  const result = await deliverTmuxMessage({ paneId: '%3', text }, runner);

  assert.deepEqual(calls, [
    ['capture-pane', '-p', '-J', '-t', '%3'],
    ['send-keys', '-l', '-t', '%3', '--', text],
    ['capture-pane', '-p', '-J', '-t', '%3'],
    ['send-keys', '-t', '%3', 'Enter'],
  ]);
  assert.deepEqual(result, {
    status: 'delivered',
    paneId: '%3',
    text,
    captureBefore: 'agent> ',
    captureAfter: `agent> ${text}`,
    verified: true,
    submitted: true,
  });
});

test('delivery verifies text that appears wrapped by terminal UI whitespace', async () => {
  const calls: string[][] = [];
  const text = '{"conversationId":"abc","body":"AgentLink smoke test: please acknowledge receipt only; do not modify files."}';
  const wrapped = '› {"conversationId":"abc","body":"AgentLin\n  k smoke test: please acknowledge receipt only; do not modify\n  files."}';
  let captureCount = 0;
  const runner: TmuxCommandRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'capture-pane') {
      captureCount += 1;
      return { stdout: captureCount === 1 ? 'agent> ' : wrapped, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const result = await deliverTmuxMessage({ paneId: '%5', text }, runner);

  assert.equal(result.verified, true);
  assert.equal(calls.filter((args) => args.at(-1) === 'Enter').length, 1);
});

test('delivery does not press Enter when the typed text cannot be verified', async () => {
  const calls: string[][] = [];
  let captureCount = 0;
  const runner: TmuxCommandRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'capture-pane') {
      captureCount += 1;
      return {
        stdout: captureCount === 1
          ? 'history: Please review.\nagent> '
          : 'history: Please review.\nbackground output\nagent> ',
        stderr: '',
      };
    }
    return {
      stdout: '',
      stderr: '',
    };
  };

  await assert.rejects(
    deliverTmuxMessage({ paneId: '%4', text: 'Please review.' }, runner),
    (error: unknown) => {
      assert.ok(error instanceof TmuxDeliveryError);
      assert.equal(error.code, 'verification-failed');
      assert.equal(error.stage, 'verify');
      assert.equal(error.paneId, '%4');
      assert.match(error.message, /Enter was not pressed/);
      return true;
    },
  );
  assert.equal(calls.filter((args) => args.at(-1) === 'Enter').length, 0);
});

test('delivery fails before typing when the initial pane capture fails', async () => {
  const calls: string[][] = [];
  const runner: TmuxCommandRunner = async (args) => {
    calls.push([...args]);
    throw Object.assign(new Error('tmux failed'), { stderr: 'pane not found' });
  };

  await assert.rejects(
    deliverTmuxMessage({ paneId: '%99', text: 'Please review.' }, runner),
    (error: unknown) => {
      assert.ok(error instanceof TmuxDeliveryError);
      assert.equal(error.code, 'capture-before-failed');
      assert.equal(error.stage, 'capture-before');
      assert.match(error.message, /pane not found/);
      return true;
    },
  );
  assert.deepEqual(calls, [['capture-pane', '-p', '-J', '-t', '%99']]);
});

test('delivery rejects control characters before invoking tmux', async () => {
  let called = false;
  const runner: TmuxCommandRunner = async () => {
    called = true;
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    deliverTmuxMessage({ paneId: '%3', text: 'first line\nsecond line' }, runner),
    (error: unknown) => {
      assert.ok(error instanceof TmuxDeliveryError);
      assert.equal(error.code, 'invalid-input');
      assert.equal(error.stage, 'validate');
      return true;
    },
  );
  assert.equal(called, false);
});
