import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MailOpsMailboxNotifier } from '../../src/application/mail-ops/mail-ops-notifier';
import type { MailboxHealthRecord } from '../../src/infrastructure/persistence/mail-ops-read.repository';

const silent = {
  child: () => silent,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function record(
  overrides: Partial<MailboxHealthRecord> = {},
): MailboxHealthRecord {
  return {
    subscriptionId: 'sub-1',
    companyId: 'co-1',
    userId: 'user-1',
    mailboxEmail: 'person@acme.com',
    status: 'active',
    connectionId: 'conn-1',
    hasHistoryCursor: true,
    watchRegisteredAt: new Date('2026-08-01T00:00:00.000Z'),
    watchExpirationAt: null,
    watchFailureCode: null,
    lastSignalAt: null,
    lastSyncAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    failureCode: null,
    lastError: null,
    activeRuleCount: 1,
    totalRuleCount: 1,
    notifiedState: null,
    ...overrides,
  };
}

function harness(
  value: MailboxHealthRecord | null,
  options: { openId?: string | null; sendFails?: boolean } = {},
) {
  const sent: string[] = [];
  const remembered: string[] = [];
  const notifier = new MailOpsMailboxNotifier({
    readRepo: { getMailboxHealth: async () => ({ ok: true, value }) } as any,
    repo: {
      recordNotifiedMailboxState: async (_id: string, state: string) => {
        remembered.push(state);
        return { ok: true, value: true };
      },
    } as any,
    resolveLarkOpenId: async () =>
      options.openId === undefined ? 'ou_owner' : options.openId,
    sendDirectCard: async (_openId: string, card: string) => {
      if (options.sendFails) {
        return { ok: false, error: { message: 'lark down' } } as any;
      }
      sent.push(card);
      return { ok: true, value: { messageId: 'om_1' } } as any;
    },
    logger: silent,
  });
  return { notifier, sent, remembered };
}

describe('mail ops mailbox notifier', () => {
  it('alerts the owner the first time a mailbox cannot run rules', async () => {
    const { notifier, sent, remembered } = harness(
      record({ watchRegisteredAt: null }),
    );

    const result = await notifier.review('sub-1');

    assert.equal(result.notified, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /never been able to start watching/);
    assert.deepEqual(remembered, ['never_started']);
  });

  it('stays silent while the mailbox remains broken the same way', async () => {
    const { notifier, sent } = harness(
      record({ watchRegisteredAt: null, notifiedState: 'never_started' }),
    );

    assert.equal((await notifier.review('sub-1')).notified, false);
    assert.equal(sent.length, 0);
  });

  it('alerts again when a broken mailbox breaks a different way', async () => {
    const { notifier, sent } = harness(
      record({ failureCode: 'scope_missing', notifiedState: 'watch_failing' }),
    );

    assert.equal((await notifier.review('sub-1')).notified, true);
    assert.equal(sent.length, 1);
  });

  it('never announces recovery, but records it so the next break alerts', async () => {
    const { notifier, sent, remembered } = harness(
      record({ notifiedState: 'sync_failing' }),
    );

    assert.equal((await notifier.review('sub-1')).notified, false);
    assert.equal(sent.length, 0);
    assert.deepEqual(remembered, ['healthy']);
  });

  it('does not record a failed send, so the warning is retried', async () => {
    // A duplicate alert is a smaller failure than never warning them at all.
    const { notifier, remembered } = harness(
      record({ watchRegisteredAt: null }),
      { sendFails: true },
    );

    assert.equal((await notifier.review('sub-1')).notified, false);
    assert.deepEqual(remembered, []);
  });

  it('records the state when the owner has no Lark identity to reach', async () => {
    const { notifier, sent, remembered } = harness(
      record({ watchRegisteredAt: null }),
      { openId: null },
    );

    assert.equal((await notifier.review('sub-1')).notified, false);
    assert.equal(sent.length, 0);
    // Recorded despite not sending: retrying every pass would never succeed.
    assert.deepEqual(remembered, ['never_started']);
  });

  it('treats an unrecognised stored state as never notified', async () => {
    const { notifier, sent } = harness(
      record({ watchRegisteredAt: null, notifiedState: 'from_a_future_build' }),
    );

    assert.equal((await notifier.review('sub-1')).notified, true);
    assert.equal(sent.length, 1);
  });

  it('does nothing when the subscription has gone', async () => {
    const { notifier, sent, remembered } = harness(null);

    assert.equal((await notifier.review('sub-1')).notified, false);
    assert.equal(sent.length, 0);
    assert.deepEqual(remembered, []);
  });

  it('never lets a notification failure escape to the caller', async () => {
    const notifier = new MailOpsMailboxNotifier({
      readRepo: {
        getMailboxHealth: async () => {
          throw new Error('database is on fire');
        },
      } as any,
      repo: { recordNotifiedMailboxState: async () => ({ ok: true, value: true }) } as any,
      resolveLarkOpenId: async () => 'ou_owner',
      sendDirectCard: async () => ({ ok: true, value: { messageId: 'x' } }) as any,
      logger: silent,
    });

    assert.deepEqual(await notifier.review('sub-1'), { notified: false });
  });
});
