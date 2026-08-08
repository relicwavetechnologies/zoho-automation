import assert from 'node:assert/strict';
import test from 'node:test';
import { LarkStatusCoordinator } from '../../src/infrastructure/channels/lark/lark-status.coordinator';

const logger = {
  info() {},
  warn() {},
  child() { return this; },
};

test('status updates are not deduped when subagent child rows change', async () => {
  const calls: string[] = [];
  const coordinator = new LarkStatusCoordinator({
    chatId: 'oc_test',
    logger: logger as never,
    minUpdateIntervalMs: 0,
    client: {
      async sendMessage() {
        calls.push('send');
        return { messageId: 'om_status' };
      },
      async updateMessage() {
        calls.push('update');
      },
    },
  });

  const baseTimeline = {
    phase: 'Working',
    state: 'working' as const,
    liveLabel: 'Running a subagent…',
    actionCount: 1,
    startedAtMs: 0,
  };

  await coordinator.update({
    timeline: {
      ...baseTimeline,
      ledger: [{ label: 'Subagents', count: 1, status: 'running' as const }],
    },
  });
  await coordinator.update({
    timeline: {
      ...baseTimeline,
      ledger: [{
        label: 'Subagents',
        count: 1,
        status: 'running' as const,
        children: [{ label: 'scout', count: 1, status: 'running' as const, outcome: 'reading' }],
      }],
    },
  });
  await coordinator.close();

  assert.deepEqual(calls, ['send', 'update']);
});
