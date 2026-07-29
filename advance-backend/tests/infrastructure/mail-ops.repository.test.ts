import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAILBOX_RECONCILIATION_INTERVAL_MS } from '../../src/application/mail-ops/mail-ops.types.ts';
import { MailOpsRepository } from '../../src/infrastructure/persistence/mail-ops.repository.ts';

const dueMailbox = {
  id: 'mailbox-1',
  companyId: 'company-1',
  userId: 'user-1',
  connectionId: 'connection-1',
  mailboxEmail: 'user@example.com',
  historyId: '100',
  nextPollAt: new Date('2026-07-29T05:00:00.000Z'),
  signalVersion: 0,
};

describe('MailOpsRepository', () => {
  it('creates one idempotent rule and activates its user-owned mailbox atomically', async () => {
    let subscriptionUpsert: any;
    let ruleUpsert: any;
    const tx = {
      mailboxSubscription: {
        upsert: async (input: any) => {
          subscriptionUpsert = input;
          return { id: 'mailbox-1' };
        },
      },
      mailAutomationRule: {
        upsert: async (input: any) => {
          ruleUpsert = input;
          return { id: 'rule-1' };
        },
      },
    };
    const repo = new MailOpsRepository({
      $transaction: async (fn: any) => fn(tx),
    } as any);

    const result = await repo.createRuleForMailbox({
      companyId: 'company-1',
      createdByUserId: 'user-1',
      connectionId: 'connection-1',
      mailboxEmail: 'user@example.com',
      name: 'Forward OTP',
      match: { from: 'alerts@example.com' },
      action: { type: 'forward' },
      destination: { type: 'email', email: 'owner@example.com' },
      dedupeKey: 'mail-rule:key',
    });

    assert.deepEqual(result, {
      ok: true,
      value: { ruleId: 'rule-1', subscriptionId: 'mailbox-1' },
    });
    assert.equal(subscriptionUpsert.where.connectionId, 'connection-1');
    assert.equal(subscriptionUpsert.create.userId, 'user-1');
    assert.equal(subscriptionUpsert.update.companyId, undefined);
    assert.equal(subscriptionUpsert.update.status, 'active');
    assert.equal(ruleUpsert.where.dedupeKey, 'mail-rule:key');
    assert.equal(ruleUpsert.create.subscriptionId, 'mailbox-1');
    assert.equal(ruleUpsert.update.name, 'Forward OTP');
    assert.equal(ruleUpsert.update.status, 'active');
  });

  it('does not reactivate an archived rule', async () => {
    let updates = 0;
    const tx = {
      mailAutomationRule: {
        findFirst: async () => ({
          id: 'rule-1',
          subscriptionId: 'mailbox-1',
          status: 'archived',
        }),
        update: async () => {
          updates += 1;
        },
      },
    };
    const repo = new MailOpsRepository({
      $transaction: async (fn: any) => fn(tx),
    } as any);

    const result = await repo.setRuleStatus({
      companyId: 'company-1',
      userId: 'user-1',
      ruleId: 'rule-1',
      status: 'active',
    });

    assert.deepEqual(result, { ok: true, value: false });
    assert.equal(updates, 0);
  });

  it('claims a due mailbox with a conditional lease, not one claim per rule', async () => {
    let findInput: any;
    let updateInput: any;
    const repo = new MailOpsRepository({
      mailboxSubscription: {
        findFirst: async (input: any) => {
          findInput = input;
          return dueMailbox;
        },
        updateMany: async (input: any) => {
          updateInput = input;
          return { count: 1 };
        },
      },
    } as any);
    const now = new Date('2026-07-29T05:01:00.000Z');

    const result = await repo.claimNextDueMailbox(now, true);

    assert.ok(result.ok && result.value);
    assert.equal(result.value.subscriptionId, 'mailbox-1');
    assert.equal(result.value.historyId, '100');
    assert.deepEqual(findInput.where.historyId, { not: null });
    assert.deepEqual(findInput.where.watchRegisteredAt, { not: null });
    assert.equal(updateInput.where.id, 'mailbox-1');
    assert.equal(updateInput.where.nextPollAt, dueMailbox.nextPollAt);
    assert.equal(updateInput.data.claimToken, result.value.claimToken);
  });

  it('records new messages idempotently before cursor advancement', async () => {
    let createManyInput: any;
    const tx = {
      mailEvent: {
        createMany: async (input: any) => {
          createManyInput = input;
          return { count: 0 };
        },
        findMany: async () => [{
          id: 'event-1',
          providerMessageId: 'gmail-1',
          providerThreadId: 'thread-1',
          historyId: '101',
          metadataJson: { from: 'alerts@example.com' },
          occurredAt: new Date('2026-07-29T05:02:00.000Z'),
        }],
      },
    };
    const repo = new MailOpsRepository({
      $transaction: async (fn: any) => fn(tx),
    } as any);

    const result = await repo.recordEvents(
      {
        subscriptionId: 'mailbox-1',
        companyId: 'company-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        mailboxEmail: 'user@example.com',
        historyId: '100',
        signalVersion: 0,
        claimToken: 'claim-1',
      },
      [{
        providerMessageId: 'gmail-1',
        providerThreadId: 'thread-1',
        historyId: '101',
        metadata: { from: 'alerts@example.com' },
        occurredAt: new Date('2026-07-29T05:02:00.000Z'),
      }],
    );

    assert.ok(result.ok);
    assert.equal(createManyInput.skipDuplicates, true);
    assert.equal(createManyInput.data[0].providerMessageId, 'gmail-1');
    assert.equal(result.value[0]?.eventId, 'event-1');
  });

  it('advances the cursor only after downstream event work succeeds', async () => {
    let cursorUpdate: any;
    const repo = new MailOpsRepository({
      mailboxSubscription: {
        updateMany: async (input: any) => {
          cursorUpdate = input;
          return { count: 1 };
        },
      },
    } as any);
    const now = new Date('2026-07-29T05:03:00.000Z');

    const result = await repo.advanceCursor(
      {
        subscriptionId: 'mailbox-1',
        companyId: 'company-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        mailboxEmail: 'user@example.com',
        signalVersion: 0,
        claimToken: 'claim-1',
      },
      '101',
      now,
    );

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(cursorUpdate.where.claimToken, 'claim-1');
    assert.equal(cursorUpdate.where.signalVersion, 0);
    assert.equal(cursorUpdate.data.historyId, '101');
    assert.equal(
      cursorUpdate.data.nextPollAt.getTime(),
      now.getTime() + MAILBOX_RECONCILIATION_INTERVAL_MS,
    );
  });

  it('keeps the mailbox due when a Pub/Sub signal arrives during sync', async () => {
    const cursorUpdates: any[] = [];
    const repo = new MailOpsRepository({
      mailboxSubscription: {
        updateMany: async (input: any) => {
          cursorUpdates.push(input);
          return { count: cursorUpdates.length === 1 ? 0 : 1 };
        },
      },
    } as any);
    const now = new Date('2026-07-29T05:03:00.000Z');

    const result = await repo.advanceCursor({
      subscriptionId: 'mailbox-1',
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      mailboxEmail: 'user@example.com',
      signalVersion: 1,
      claimToken: 'claim-1',
    }, '102', now);

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(cursorUpdates.length, 2);
    assert.equal(cursorUpdates[1].where.signalVersion, undefined);
    assert.equal(cursorUpdates[1].data.nextPollAt, now);
  });

  it('coalesces a Pub/Sub signal into a durable due-mailbox marker', async () => {
    let update: any;
    const repo = new MailOpsRepository({
      mailboxSubscription: {
        updateMany: async (input: any) => {
          update = input;
          return { count: 1 };
        },
      },
    } as any);
    const now = new Date('2026-07-29T05:03:00.000Z');

    const result = await repo.signalMailbox({
      mailboxEmail: 'USER@example.com',
      historyId: '102',
      messageId: 'pubsub-1',
      now,
    });

    assert.deepEqual(result, { ok: true, value: 1 });
    assert.equal(update.data.nextPollAt, now);
    assert.deepEqual(update.data.signalVersion, { increment: 1 });
    assert.equal(update.data.lastSignalHistoryId, '102');
  });

  it('renews Gmail watch without skipping an existing history cursor', async () => {
    let update: any;
    const tx = {
      mailboxSubscription: {
        findUnique: async () => ({ historyId: '100' }),
        updateMany: async (input: any) => {
          update = input;
          return { count: 1 };
        },
      },
    };
    const repo = new MailOpsRepository({
      $transaction: async (fn: any) => fn(tx),
    } as any);
    const claim = {
      subscriptionId: 'mailbox-1',
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      mailboxEmail: 'user@example.com',
      claimToken: 'watch-claim',
    };

    const result = await repo.completeWatchRenewal(
      claim,
      '200',
      new Date('2026-08-05T05:00:00.000Z'),
      new Date('2026-07-29T05:00:00.000Z'),
    );

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(update.data.historyId, undefined);
    assert.equal(update.data.watchClaimToken, null);
  });

  it('treats a duplicate delivered rule-event pair as already complete', async () => {
    let createInput: any;
    const repo = new MailOpsRepository({
      mailDelivery: {
        create: async (input: any) => {
          createInput = input;
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        },
        findUnique: async () => ({ id: 'delivery-1', status: 'delivered' }),
      },
    } as any);

    assert.deepEqual(
      await repo.reserveDelivery(
        'company-1',
        'mailbox-1',
        'rule-1',
        'event-1',
        { destination: 'oc_chat' },
      ),
      {
        ok: true,
        value: { outcome: 'delivered', deliveryId: 'delivery-1' },
      },
    );
    assert.equal(createInput.data.companyId, 'company-1');
    assert.equal(createInput.data.subscriptionId, 'mailbox-1');
  });

  it('terminally abandons a claimed delivery after authority is revoked', async () => {
    let update: any;
    const repo = new MailOpsRepository({
      mailDelivery: {
        updateMany: async (input: any) => {
          update = input;
          return { count: 1 };
        },
      },
    } as any);

    const result = await repo.markDeliveryAbandoned(
      'delivery-1',
      2,
      'execute access revoked',
    );

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(update.where, {
      id: 'delivery-1',
      status: 'sending',
      attempts: 2,
    });
    assert.equal(update.data.status, 'abandoned');
    assert.equal(update.data.nextAttemptAt, null);
  });
});
