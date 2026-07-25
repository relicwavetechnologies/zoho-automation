import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatMessageSerializer } from '../../../src/application/orchestration/chat-message-serializer.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for serializer state');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

describe('ChatMessageSerializer timeout', () => {
  it('keeps the lane occupied until the timed-out task acknowledges cancellation', async () => {
    const events: string[] = [];
    let acknowledgeCancellation: (() => void) | undefined;
    const serializer = new ChatMessageSerializer({
      timeoutMs: 5,
      onTimeout: () => events.push('timeout'),
    });

    serializer.run('chat-1', async (signal) => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        acknowledgeCancellation = resolve;
        signal.addEventListener('abort', () => events.push('first:aborted'), { once: true });
      });
      events.push('first:end');
    });
    serializer.run('chat-1', async () => {
      events.push('second:start');
    });

    await waitFor(() => events.includes('first:aborted'));
    assert.deepEqual(events, ['first:start', 'timeout', 'first:aborted']);

    acknowledgeCancellation?.();
    await waitFor(() => events.includes('second:start'));
    assert.deepEqual(events, [
      'first:start',
      'timeout',
      'first:aborted',
      'first:end',
      'second:start',
    ]);
  });

  it('lets durable consumers await the exact queued task and observe its failure', async () => {
    const serializer = new ChatMessageSerializer();
    const first = serializer.runAndWait('chat-1', async () => {
      throw new Error('engine unavailable');
    });
    const events: string[] = [];
    const second = serializer.runAndWait('chat-1', async () => {
      events.push('second');
    });

    await assert.rejects(first, /engine unavailable/);
    await second;

    assert.deepEqual(events, ['second']);
    await waitFor(() => serializer.activeChats === 0);
    assert.equal(serializer.activeChats, 0);
  });
});
