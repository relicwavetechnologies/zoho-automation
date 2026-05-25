import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LarkStatusCoordinator } from '../../src/infrastructure/channels/lark/lark-status.coordinator.ts';

describe('LarkStatusCoordinator', () => {
  it('blocks a scheduled flush after finalizeMessage', async () => {
    const updates: string[] = [];
    let releaseDelayedFlush: (() => void) | undefined;
    const delayedGate = new Promise<void>(resolve => { releaseDelayedFlush = resolve; });

    const client = {
      async sendMessage() {
        updates.push('send');
        return { messageId: 'om_status_1' };
      },
      async updateMessage(_id: string, content: string) {
        if (content.includes('Final answer')) {
          updates.push('final');
          return;
        }
        if (!updates.includes('status_blocked')) {
          updates.push('status_blocked');
          await delayedGate;
          updates.push('status_after_delay');
        }
      },
    };

    const coordinator = new LarkStatusCoordinator({
      client,
      chatId:  'oc_test',
      logger:  { child: () => ({ warn: () => {}, info: () => {}, error: () => {} }) } as never,
      minUpdateIntervalMs: 5000,
    });

    await coordinator.update({
      timeline: { phase: 'Executing · 0/1', progressPct: 10, liveLabel: 'Starting…' },
    });

    void coordinator.update({
      timeline: { phase: 'Executing · 1/1', progressPct: 90, liveLabel: 'Almost…' },
    });

    const finalPayload = JSON.stringify({
      msg_type: 'interactive',
      card: JSON.stringify({
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: 'Final answer here' }] },
      }),
    });

    await coordinator.finalizeMessage(finalPayload);

    releaseDelayedFlush!();
    await new Promise<void>(r => setTimeout(r, 50));

    assert.ok(updates.includes('final'));
    assert.equal(updates.includes('status_after_delay'), false,
      `delayed flush must not run after finalize; got: ${updates.join(' -> ')}`);
  });
});
