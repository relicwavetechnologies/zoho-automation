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
        findUnique: async () => null,
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

  it('replaces an owned rule and reactivates its mailbox atomically', async () => {
    let findInput: any;
    let ruleUpdate: any;
    let subscriptionUpdate: any;
    const tx = {
      mailAutomationRule: {
        findFirst: async (input: any) => {
          findInput = input;
          return { id: 'rule-1', subscriptionId: 'mailbox-1' };
        },
        update: async (input: any) => {
          ruleUpdate = input;
        },
      },
      mailboxSubscription: {
        update: async (input: any) => {
          subscriptionUpdate = input;
        },
      },
    };
    const repo = new MailOpsRepository({
      $transaction: async (fn: any) => fn(tx),
    } as any);

    const result = await repo.replaceRule({
      companyId: 'company-1',
      userId: 'user-1',
      ruleId: 'rule-1',
      connectionId: 'connection-1',
      name: 'Forward Claude secure links',
      match: {
        from: '@mail.anthropic.com',
        subjectContains: 'Your secure link to Claude.ai',
      },
      action: { type: 'forward' },
      destination: { type: 'email', email: 'owner@example.com' },
      dedupeKey: 'mail-rule:updated',
    });

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(findInput.where, {
      id: 'rule-1',
      companyId: 'company-1',
      createdByUserId: 'user-1',
      status: { not: 'archived' },
      subscription: { connectionId: 'connection-1' },
    });
    assert.deepEqual(ruleUpdate.data.matchJson, {
      from: '@mail.anthropic.com',
      subjectContains: 'Your secure link to Claude.ai',
    });
    assert.deepEqual(ruleUpdate.data.version, { increment: 1 });
    assert.equal(subscriptionUpdate.where.id, 'mailbox-1');
    assert.equal(subscriptionUpdate.data.status, 'active');
  });

  it('keeps the mailbox syncing when the last active rule is paused', async () => {
    // Pausing the mailbox underneath a paused rule made "paused" untrue in both
    // directions: the cursor stopped moving, and past Gmail's history retention
    // the resume lost the intervening days *and* replayed up to a day of
    // already-read mail through the freshly resumed rule.
    let subscriptionUpdate: any;
    const counts: any[] = [];
    const tx = {
      mailAutomationRule: {
        findFirst: async () => ({ id: 'rule-1', subscriptionId: 'mailbox-1', status: 'active' }),
        update: async () => ({}),
        count: async (input: any) => {
          counts.push(input.where.status);
          // No active rules left; one paused rule survives.
          return input.where.status === 'active' ? 0 : 1;
        },
      },
      mailboxSubscription: {
        update: async (input: any) => { subscriptionUpdate = input; return {}; },
      },
    };
    const repo = new MailOpsRepository({ $transaction: async (fn: any) => fn(tx) } as any);

    const result = await repo.setRuleStatus({
      companyId: 'company-1',
      userId: 'user-1',
      ruleId: 'rule-1',
      status: 'paused',
    });

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(subscriptionUpdate.data.status, 'active');
    // Nothing can fire, so there is no reason to chase the mailbox right now —
    // it just keeps its ordinary cadence and its cursor.
    assert.equal('nextPollAt' in subscriptionUpdate.data, false);
    assert.deepEqual(counts, ['active', { not: 'archived' }]);
  });

  it('pauses the mailbox only once every rule on it is archived', async () => {
    let subscriptionUpdate: any;
    const tx = {
      mailAutomationRule: {
        findFirst: async () => ({ id: 'rule-1', subscriptionId: 'mailbox-1', status: 'active' }),
        update: async () => ({}),
        count: async () => 0,
      },
      mailboxSubscription: {
        update: async (input: any) => { subscriptionUpdate = input; return {}; },
      },
    };
    const repo = new MailOpsRepository({ $transaction: async (fn: any) => fn(tx) } as any);

    await repo.setRuleStatus({
      companyId: 'company-1',
      userId: 'user-1',
      ruleId: 'rule-1',
      status: 'archived',
    });

    assert.equal(subscriptionUpdate.data.status, 'paused');
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

    const result = await repo.claimNextDueMailbox(now);

    assert.ok(result.ok && result.value);
    assert.equal(result.value.subscriptionId, 'mailbox-1');
    assert.equal(result.value.historyId, '100');
    // Reconciliation is the safety net for a missing watch. Requiring a
    // registered watch here removed the net exactly when it was needed: a
    // mailbox whose watch failed permanently was excluded from the poll that
    // would otherwise have kept its rules running.
    assert.equal(findInput.where.historyId, undefined);
    assert.equal(findInput.where.watchRegisteredAt, undefined);
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

  it('keeps a partially drained mailbox due immediately', async () => {
    // A truncated pass succeeded, so it must not be scheduled like a failure —
    // but there is known unread history left, and an hour is too long to hold
    // it. Same treatment as an arriving signal, for the same reason.
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
      '120',
      now,
      { pollImmediately: true },
    );

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(cursorUpdate.data.historyId, '120');
    assert.equal(cursorUpdate.data.nextPollAt, now);
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

  it('records a refusal as an inert row the delivery loop will never claim', async () => {
    let created: any;
    const repo = new MailOpsRepository({
      mailDelivery: {
        create: async (input: any) => {
          created = input;
          return { id: 'delivery-1' };
        },
      },
    } as any);

    const result = await repo.recordBlockedDelivery({
      companyId: 'company-1',
      subscriptionId: 'mailbox-1',
      ruleId: 'rule-1',
      eventId: 'event-1',
      reason: 'You are no longer in that team.',
      message: { subject: 'Invoice', from: 'billing@acme.com' },
    });

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(created.data.status, 'blocked');
    // Only `pending` is ever claimed, and a null next attempt keeps it out of
    // the due query regardless — a refusal must not become a send.
    assert.equal(created.data.nextAttemptAt, null);
    assert.equal(created.data.attempts, 0);
    assert.match(created.data.lastError, /no longer in that team/);
    // The message rides along so the row can name the mail it refused; no
    // action or destination, because nothing was going to be sent.
    assert.deepEqual(created.data.payloadJson, {
      message: { subject: 'Invoice', from: 'billing@acme.com' },
    });
  });

  it('lets a real delivery win over a refusal for the same rule and event', async () => {
    const repo = new MailOpsRepository({
      mailDelivery: {
        create: async () => {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        },
      },
    } as any);

    const result = await repo.recordBlockedDelivery({
      companyId: 'company-1',
      subscriptionId: 'mailbox-1',
      ruleId: 'rule-1',
      eventId: 'event-1',
      reason: 'denied',
      message: {},
    });

    assert.deepEqual(result, { ok: true, value: false });
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

  it('retries transient delivery failures on the Mail Ops latency budget', async () => {
    const updates: any[] = [];
    const repo = new MailOpsRepository({
      mailDelivery: {
        updateMany: async (input: any) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as any);
    const now = new Date('2026-07-31T05:00:00.000Z');

    await repo.markDeliveryFailed('delivery-1', new Error('transient'), 1, now);
    await repo.markDeliveryFailed('delivery-2', new Error('transient'), 3, now);

    assert.equal(
      updates[0].data.nextAttemptAt.getTime(),
      now.getTime() + 5_000,
    );
    assert.equal(
      updates[1].data.nextAttemptAt.getTime(),
      now.getTime() + 20_000,
    );
  });

  it('hands back the attempt a claim spent when a delivery only has to wait', async () => {
    // The guard is the claim's own `attempts`, so the row can only be
    // rescheduled by the worker still holding it. The decrement undoes what
    // the claim took: five refusals inside one rate window must leave the
    // ladder exactly where it started, or waiting quietly abandons the mail.
    let update: any;
    const repo = new MailOpsRepository({
      mailDelivery: {
        updateMany: async (input: any) => {
          update = input;
          return { count: 1 };
        },
      },
    } as any);
    const nextAttemptAt = new Date('2026-08-02T06:30:00.000Z');

    const result = await repo.rescheduleDelivery({
      deliveryId: 'delivery-1',
      attempts: 3,
      nextAttemptAt,
      reason: 'Connection budget exhausted.',
    });

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(update.where, {
      id: 'delivery-1',
      status: 'sending',
      attempts: 3,
    });
    assert.equal(update.data.status, 'pending');
    assert.deepEqual(update.data.attempts, { decrement: 1 });
    assert.equal(update.data.nextAttemptAt, nextAttemptAt);
    assert.equal(update.data.lastError, 'Connection budget exhausted.');
  });

  it('reports a lost claim rather than rescheduling somebody else\'s delivery', async () => {
    const repo = new MailOpsRepository({
      mailDelivery: { updateMany: async () => ({ count: 0 }) },
    } as any);

    const result = await repo.rescheduleDelivery({
      deliveryId: 'delivery-1',
      attempts: 3,
      nextAttemptAt: new Date('2026-08-02T06:30:00.000Z'),
      reason: 'Connection budget exhausted.',
    });

    assert.deepEqual(result, { ok: true, value: false });
  });

  it('takes the unconfirmed warning down when the caller proved nothing was sent', async () => {
    // `ambiguous` reads as "this may already be in somebody's inbox".
    // Abandoning is terminal, so nothing later revisits the question — the
    // caller that answered it is the last chance to say so.
    const updates: any[] = [];
    const repo = new MailOpsRepository({
      mailDelivery: {
        updateMany: async (input: any) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as any);

    await repo.markDeliveryAbandoned('delivery-1', 2, 'denied', {
      nothingWasSent: true,
    });
    await repo.markDeliveryAbandoned('delivery-2', 2, 'denied');

    assert.equal(updates[0].data.ambiguous, false);
    // The draft is still sitting in the mailbox and the row is the only record
    // of which one it is.
    assert.equal(updates[0].data.providerDraftId, undefined);
    // Never asked, so nothing to say — not silently reclassified as safe.
    assert.equal(updates[1].data.ambiguous, undefined);
  });

  it('clears the unconfirmed warning on the last rung of the ladder, not before', async () => {
    // While the row is still retryable the next attempt re-probes and answers
    // the question properly. Clearing it early would be a lie the retry could
    // not take back: the send is staged, so nothing re-marks it ambiguous.
    const updates: any[] = [];
    const repo = new MailOpsRepository({
      mailDelivery: {
        updateMany: async (input: any) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as any);
    const now = new Date('2026-08-02T05:00:00.000Z');

    await repo.markDeliveryFailed('delivery-1', new Error('x'), 2, now, {
      nothingWasSent: true,
    });
    await repo.markDeliveryFailed('delivery-2', new Error('x'), 5, now, {
      nothingWasSent: true,
    });
    await repo.markDeliveryFailed('delivery-3', new Error('x'), 5, now, {
      nothingWasSent: false,
    });

    assert.equal(updates[0].data.status, 'pending');
    assert.equal(updates[0].data.ambiguous, undefined);
    assert.equal(updates[1].data.status, 'abandoned');
    assert.equal(updates[1].data.ambiguous, false);
    assert.equal(updates[2].data.status, 'abandoned');
    assert.equal(updates[2].data.ambiguous, undefined);
  });

  it('starts a revived rule watching from now, not from when it was first written', async () => {
    // Recreating an archived rule is the only way to bring one back, and the
    // upsert reuses the original row. Left on `createdAt`, a rule first
    // written in January and asked for again today would treat the entire
    // stale-cursor recovery window as mail it is entitled to forward.
    const upserts: any[] = [];
    const repo = (existing: { status: string } | null) => new MailOpsRepository({
      $transaction: async (fn: any) => fn({
        mailboxSubscription: { upsert: async () => ({ id: 'mailbox-1' }) },
        mailAutomationRule: {
          findUnique: async () => existing,
          upsert: async (input: any) => {
            upserts.push(input);
            return { id: 'rule-1' };
          },
        },
      }),
    } as any);
    const args = {
      companyId: 'company-1',
      createdByUserId: 'user-1',
      connectionId: 'connection-1',
      mailboxEmail: 'user@example.com',
      name: 'Forward OTP',
      match: { from: 'alerts@example.com' },
      action: { type: 'forward' },
      destination: { type: 'email', email: 'owner@example.com' },
      dedupeKey: 'mail-rule:key',
    };
    const before = Date.now();

    await repo({ status: 'archived' }).createRuleForMailbox(args);
    await repo({ status: 'paused' }).createRuleForMailbox(args);
    await repo(null).createRuleForMailbox(args);
    // The dedupe key is content-derived, so re-asking for a rule that is
    // already running lands here too. Moving its floor would silently discard
    // whatever backlog it had not reached yet — a stale cursor is exactly when
    // a member re-asks — and nobody asked for anything to stop.
    await repo({ status: 'active' }).createRuleForMailbox(args);

    assert.ok(upserts[0].update.activatedAt.getTime() >= before);
    assert.ok(upserts[1].update.activatedAt.getTime() >= before);
    // A genuinely new row takes the column default rather than a written value.
    assert.equal(upserts[2].create.activatedAt, undefined);
    assert.equal(upserts[3].update.activatedAt, undefined);
  });

  it('starts a replaced rule watching from now, so a new destination gets no backlog', async () => {
    let ruleUpdate: any;
    const repo = new MailOpsRepository({
      $transaction: async (fn: any) => fn({
        mailAutomationRule: {
          findFirst: async () => ({ id: 'rule-1', subscriptionId: 'mailbox-1' }),
          update: async (input: any) => { ruleUpdate = input; },
        },
        mailboxSubscription: { update: async () => undefined },
      }),
    } as any);
    const before = Date.now();

    await repo.replaceRule({
      companyId: 'company-1',
      userId: 'user-1',
      ruleId: 'rule-1',
      connectionId: 'connection-1',
      name: 'Forward OTP',
      match: { from: 'alerts@example.com' },
      action: { type: 'forward' },
      destination: { type: 'email', email: 'new-owner@example.com' },
      dedupeKey: 'mail-rule:key',
    });

    assert.ok(ruleUpdate.data.activatedAt.getTime() >= before);
  });

  it('starts a resumed rule watching from now, so a pause is not delivered later', async () => {
    // "Paused" was sold to the member as "stop forwarding". Resuming is not a
    // licence to deliver everything that arrived meanwhile.
    const updates: any[] = [];
    const now = new Date('2026-08-02T06:00:00.000Z');
    const repo = new MailOpsRepository({
      $transaction: async (fn: any) => fn({
        mailAutomationRule: {
          findFirst: async () => ({
            id: 'rule-1',
            subscriptionId: 'mailbox-1',
            status: 'paused',
          }),
          update: async (input: any) => { updates.push(input); },
          count: async () => 1,
        },
        mailboxSubscription: { update: async () => undefined },
      }),
    } as any);

    await repo.setRuleStatus({
      companyId: 'company-1',
      userId: 'user-1',
      ruleId: 'rule-1',
      status: 'active',
      now,
    });

    assert.equal(updates[0].data.activatedAt.getTime(), now.getTime());
  });

  it('does not move the watch floor when a rule is paused or archived', async () => {
    // Pausing must not silently forgive the gap when the rule is resumed by
    // some other route, and archiving is terminal.
    const updates: any[] = [];
    const repo = (status: 'paused' | 'archived') => new MailOpsRepository({
      $transaction: async (fn: any) => fn({
        mailAutomationRule: {
          findFirst: async () => ({
            id: 'rule-1',
            subscriptionId: 'mailbox-1',
            status: 'active',
          }),
          update: async (input: any) => { updates.push({ status, ...input }); },
          count: async () => 0,
        },
        mailboxSubscription: { update: async () => undefined },
      }),
    } as any);

    await repo('paused').setRuleStatus({
      companyId: 'company-1', userId: 'user-1', ruleId: 'rule-1', status: 'paused',
    });
    await repo('archived').setRuleStatus({
      companyId: 'company-1', userId: 'user-1', ruleId: 'rule-1', status: 'archived',
    });

    assert.equal(updates[0].data.activatedAt, undefined);
    assert.equal(updates[1].data.activatedAt, undefined);
  });
});
