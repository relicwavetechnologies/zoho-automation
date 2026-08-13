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

/*
 * The model's reasoning rides the timeline but never reaches a card — a card is
 * read by everyone in the chat. So a run that thinks between two tool calls
 * changes the timeline without changing anything the card draws, and treating
 * that as an update spends a Lark API edit repainting an identical card. On a
 * run that reasons every few seconds that is dozens of them.
 */
test('a thought alone is not a reason to repaint the card', async () => {
  const calls: string[] = [];
  const coordinator = new LarkStatusCoordinator({
    chatId: 'oc_test',
    logger: logger as never,
    minUpdateIntervalMs: 0,
    client: {
      async sendMessage() { calls.push('send'); return { messageId: 'om_status' }; },
      async updateMessage() { calls.push('update'); },
    },
  });

  const withLedger = (ledger: unknown[]) => coordinator.update({
    timeline: {
      phase: 'Working',
      state: 'working' as const,
      liveLabel: 'Working…',
      actionCount: 1,
      startedAtMs: 0,
      ledger,
    },
  } as never);

  const tool = { kind: 'tool' as const, label: 'Zoho Books', count: 1, status: 'running' as const };
  await withLedger([tool]);
  await coordinator.flush();
  const afterFirst = calls.length;

  await withLedger([tool, { kind: 'thought', label: 'Unpaid means overdue.', count: 1, status: 'done' }]);
  await coordinator.flush();
  assert.equal(calls.length, afterFirst, 'a thought must not cost a card edit');

  // A change the card *does* draw still gets through.
  await withLedger([{ ...tool, status: 'done' as const, outcome: 'Listed 4 invoices' }]);
  await coordinator.flush();
  assert.ok(calls.length > afterFirst, 'a real change must still repaint');
});
