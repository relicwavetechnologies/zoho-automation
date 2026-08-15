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
        children: [{ label: 'scout', status: 'running' as const, outcome: 'reading' }],
      }],
    },
  });
  await coordinator.close();

  assert.deepEqual(calls, ['send', 'update']);
});

/*
 * An agent's elapsed time changes once a second by design. It used to travel
 * glued onto the task — `"reading the export · working 1m 30s"` — so every
 * second of every subagent run looked like news, and the card was repainted on
 * a clock rather than on anything a reader would notice. A long fan-out spent
 * dozens of Lark edits moving a digit.
 */
test('an agent’s clock ticking is not a reason to repaint the card', async () => {
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

  const atElapsed = (elapsed: string) => coordinator.update({
    timeline: {
      phase: 'Working',
      state: 'working' as const,
      liveLabel: 'Running a subagent…',
      actionCount: 1,
      startedAtMs: 0,
      ledger: [{
        label: 'Subagents',
        count: 1,
        status: 'running' as const,
        children: [{ label: 'scout', status: 'running' as const, outcome: 'reading', elapsed }],
      }],
    },
  });

  await atElapsed('12s');
  await atElapsed('13s');
  await atElapsed('14s');
  await coordinator.close();

  assert.deepEqual(calls, ['send']);
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
