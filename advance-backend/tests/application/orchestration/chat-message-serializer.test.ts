import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatMessageSerializer,
  DEFAULT_MAX_CONCURRENT,
} from '../../../src/application/orchestration/chat-message-serializer.ts';

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

describe('ChatMessageSerializer global concurrency', () => {
  /** Run `count` tasks that all park on one gate, and report the peak overlap. */
  async function measurePeak(serializer: ChatMessageSerializer, count: number) {
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    let running = 0;
    let peak = 0;

    const started = Array.from({ length: count }, (_, i) =>
      serializer.runAndWait(`lane-${i}`, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
      }));

    await new Promise<void>(resolve => setTimeout(resolve, 25));
    const observed = peak;
    openGate!();
    await Promise.all(started);
    return observed;
  }

  it('bounds parallel runs by default rather than inheriting no limit', async () => {
    // Group work can open one lane per thread (or requester in inline mode).
    // An unbounded default lets one room burst start arbitrarily many runs.
    const serializer = new ChatMessageSerializer({ timeoutMs: 5_000 });

    const peak = await measurePeak(serializer, DEFAULT_MAX_CONCURRENT + 3);

    assert.equal(peak, DEFAULT_MAX_CONCURRENT, 'excess work waits for a slot');
  });

  it('still honours an explicit limit', async () => {
    const serializer = new ChatMessageSerializer({ maxConcurrent: 2, timeoutMs: 5_000 });

    assert.equal(await measurePeak(serializer, 5), 2);
  });
});
