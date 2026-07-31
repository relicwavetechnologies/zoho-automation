import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MailOpsWorker } from '../../src/application/mail-ops/mail-ops.worker.ts';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

const claim = {
  subscriptionId: 'mailbox-1',
  companyId: 'company-1',
  userId: 'user-1',
  connectionId: 'connection-1',
  mailboxEmail: 'user@example.com',
  historyId: '100',
  signalVersion: 1,
  claimToken: 'mailbox-claim',
};

const event = {
  eventId: 'event-1',
  providerMessageId: 'message-1',
  providerThreadId: 'thread-1',
  historyId: '101',
  occurredAt: new Date('2026-07-29T05:00:00.000Z'),
  metadata: {
    from: 'Alerts <alerts@example.com>',
    to: 'user@example.com',
    subject: 'Login OTP',
    snippet: 'Your OTP is 123456',
    bodyText: 'Your OTP is 123456',
    hasAttachment: false,
  },
};

describe('MailOpsWorker', () => {
  it('renews watch, syncs history, reserves deterministically, then delivers', async () => {
    const operations: string[] = [];
    let watchClaimed = false;
    let mailboxClaimed = false;
    let deliveryPayload: Record<string, unknown> | undefined;
    let deliveryClaimed = false;
    let requiredRegisteredWatch = false;
    const repo = {
      claimNextWatchRenewal: async () => {
        if (watchClaimed) return { ok: true, value: null };
        watchClaimed = true;
        return {
          ok: true,
          value: {
            subscriptionId: 'mailbox-1',
            companyId: 'company-1',
            userId: 'user-1',
            connectionId: 'connection-1',
            mailboxEmail: 'user@example.com',
            claimToken: 'watch-claim',
          },
        };
      },
      completeWatchRenewal: async () => {
        operations.push('watch-complete');
        return { ok: true, value: true };
      },
      failWatchRenewal: async () => ({ ok: true, value: true }),
      claimNextDueMailbox: async (
        _now: Date,
        requireRegisteredWatch: boolean,
      ) => {
        requiredRegisteredWatch = requireRegisteredWatch;
        if (mailboxClaimed) return { ok: true, value: null };
        mailboxClaimed = true;
        return { ok: true, value: claim };
      },
      recordEvents: async () => {
        operations.push('record-events');
        return { ok: true, value: [event] };
      },
      listActiveRules: async () => ({
        ok: true,
        value: [{
          ruleId: 'rule-1',
          match: { from: 'alerts@example.com', subjectContains: 'otp' },
          action: { type: 'deliver' },
          destination: { type: 'lark_chat', chatId: 'oc_destination' },
        }],
      }),
      reserveDelivery: async (
        _companyId: string,
        _subscriptionId: string,
        _ruleId: string,
        _eventId: string,
        payload: Record<string, unknown>,
      ) => {
        operations.push('reserve-delivery');
        deliveryPayload = payload;
        return {
          ok: true,
          value: { outcome: 'reserved', deliveryId: 'delivery-1' },
        };
      },
      advanceCursor: async () => {
        operations.push('advance-cursor');
        return { ok: true, value: true };
      },
      markSyncFailed: async () => ({ ok: true, value: true }),
      claimNextDueDelivery: async () => {
        if (!deliveryPayload || deliveryClaimed) return { ok: true, value: null };
        deliveryClaimed = true;
        return {
          ok: true,
          value: {
            deliveryId: 'delivery-1',
            attempts: 1,
            payload: deliveryPayload,
          },
        };
      },
        markDeliveryDelivered: async () => {
          operations.push('delivery-complete');
          return { ok: true, value: true };
        },
        markDeliveryFailed: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
    };
    const worker = new MailOpsWorker({
      repo,
      gmail: {
        watch: async () => {
          operations.push('watch');
          return {
            historyId: '100',
            expiration: new Date('2026-08-05T05:00:00.000Z'),
          };
        },
        sync: async () => {
          operations.push('history-sync');
          return {
            nextHistoryId: '101',
            events: [event],
            staleCursorRecovered: false,
          };
        },
        forward: async () => {
          throw new Error('Email forwarding should not run.');
        },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => true,
      deliverLark: async input => {
        operations.push('lark-delivery');
        assert.equal(input.chatId, 'oc_destination');
        assert.match(input.text, /Your OTP is 123456/);
        return 'lark-message-1';
      },
      logger,
      pubsubTopicName: 'projects/test/topics/gmail',
    } as any);

    await worker.runOnce();

    assert.equal(requiredRegisteredWatch, true);
    assert.deepEqual(operations, [
      'watch',
      'watch-complete',
      'history-sync',
      'record-events',
      'reserve-delivery',
      'advance-cursor',
      'lark-delivery',
      'delivery-complete',
    ]);
  });

  it('does not advance the history cursor when outbox reservation fails', async () => {
    let mailboxClaimed = false;
    let cursorAdvanced = false;
    let syncFailed = false;
    const worker = new MailOpsWorker({
      repo: {
        claimNextWatchRenewal: async () => ({ ok: true, value: null }),
        completeWatchRenewal: async () => ({ ok: true, value: true }),
        failWatchRenewal: async () => ({ ok: true, value: true }),
        claimNextDueMailbox: async () => {
          if (mailboxClaimed) return { ok: true, value: null };
          mailboxClaimed = true;
          return { ok: true, value: claim };
        },
        recordEvents: async () => ({ ok: true, value: [event] }),
        listActiveRules: async () => ({
          ok: true,
          value: [{
            ruleId: 'rule-1',
            match: { from: 'alerts@example.com' },
            action: { type: 'deliver' },
            destination: { type: 'lark_chat', chatId: 'oc_destination' },
          }],
        }),
        reserveDelivery: async () => ({
          ok: false,
          error: new Error('database unavailable'),
        }),
        advanceCursor: async () => {
          cursorAdvanced = true;
          return { ok: true, value: true };
        },
        markSyncFailed: async () => {
          syncFailed = true;
          return { ok: true, value: true };
        },
        claimNextDueDelivery: async () => ({ ok: true, value: null }),
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
      },
      gmail: {
        watch: async () => {
          throw new Error('Watch should not run without a topic.');
        },
        sync: async () => ({
          nextHistoryId: '101',
          events: [event],
          staleCursorRecovered: false,
        }),
        forward: async () => 'unused',
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => true,
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(cursorAdvanced, false);
    assert.equal(syncFailed, true);
  });

  it('abandons a reserved delivery when current authority is revoked', async () => {
    let deliveryClaimed = false;
    let abandoned: { deliveryId: string; attempts: number; reason: string }
      | undefined;
    let providerCalls = 0;
    const worker = new MailOpsWorker({
      repo: {
        claimNextWatchRenewal: async () => ({ ok: true, value: null }),
        completeWatchRenewal: async () => ({ ok: true, value: true }),
        failWatchRenewal: async () => ({ ok: true, value: true }),
        claimNextDueMailbox: async () => ({ ok: true, value: null }),
        recordEvents: async () => ({ ok: true, value: [] }),
        listActiveRules: async () => ({ ok: true, value: [] }),
        reserveDelivery: async () => ({
          ok: true,
          value: { outcome: 'in_flight' },
        }),
        advanceCursor: async () => ({ ok: true, value: true }),
        markSyncFailed: async () => ({ ok: true, value: true }),
        claimNextDueDelivery: async () => {
          if (deliveryClaimed) return { ok: true, value: null };
          deliveryClaimed = true;
          return {
            ok: true,
            value: {
              deliveryId: 'delivery-1',
              attempts: 2,
              payload: {
                companyId: 'company-1',
                userId: 'user-1',
                departmentId: 'department-1',
                subscriptionId: 'mailbox-1',
                connectionId: 'connection-1',
                mailboxEmail: 'user@example.com',
                ruleId: 'rule-1',
                eventId: 'event-1',
                sourceMessageId: 'message-1',
                idempotencyKey: 'mail:idempotency',
                action: { type: 'deliver' },
                destination: {
                  type: 'lark_chat',
                  chatId: 'oc_destination',
                },
                message: event.metadata,
              },
            },
          };
        },
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async (
          deliveryId: string,
          attempts: number,
          reason: string,
        ) => {
          abandoned = { deliveryId, attempts, reason };
          return { ok: true, value: true };
        },
      },
      gmail: {
        watch: async () => {
          throw new Error('unused');
        },
        sync: async () => {
          throw new Error('unused');
        },
        forward: async () => {
          providerCalls += 1;
          return 'unexpected';
        },
      },
      resolveAccessToken: async () => {
        providerCalls += 1;
        return 'unexpected';
      },
      authorizeRule: async input => {
        assert.equal(input.departmentId, 'department-1');
        assert.equal(input.connectionId, 'connection-1');
        return false;
      },
      deliverLark: async () => {
        providerCalls += 1;
        return 'unexpected';
      },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(providerCalls, 0);
    assert.deepEqual(abandoned, {
      deliveryId: 'delivery-1',
      attempts: 2,
      reason: 'Mail automation execute access or Google connection was revoked.',
    });
  });

  it('forwards a real display-name sender without revalidating it as a rule', async () => {
    let deliveryClaimed = false;
    let delivered: { deliveryId: string; providerMessageId: string }
      | undefined;
    let failed = false;
    let forwardCalls = 0;
    const from = 'Anthropic <no-reply-6TP4qN7hl3K2lWz3v9wSIQ@mail.anthropic.com>';
    const worker = new MailOpsWorker({
      repo: {
        claimNextWatchRenewal: async () => ({ ok: true, value: null }),
        claimNextDueMailbox: async () => ({ ok: true, value: null }),
        claimNextDueDelivery: async () => {
          if (deliveryClaimed) return { ok: true, value: null };
          deliveryClaimed = true;
          return {
            ok: true,
            value: {
              deliveryId: 'delivery-1',
              attempts: 1,
              payload: {
                companyId: 'company-1',
                userId: 'user-1',
                subscriptionId: 'mailbox-1',
                connectionId: 'connection-1',
                mailboxEmail: 'user@example.com',
                ruleId: 'rule-1',
                eventId: 'event-1',
                sourceMessageId: 'message-1',
                idempotencyKey: 'mail:idempotency',
                action: { type: 'forward' },
                destination: {
                  type: 'email',
                  email: 'owner@example.com',
                },
                message: {
                  from,
                  to: 'user@example.com',
                  subject: 'Your secure link to Claude.ai is here',
                  snippet: 'Use this secure link.',
                  bodyText: 'Use this secure link.',
                  hasAttachment: false,
                },
              },
            },
          };
        },
        markDeliveryDelivered: async (
          deliveryId: string,
          providerMessageId: string,
        ) => {
          delivered = { deliveryId, providerMessageId };
          return { ok: true, value: true };
        },
        markDeliveryFailed: async () => {
          failed = true;
          return { ok: true, value: true };
        },
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
      },
      gmail: {
        forward: async (input: any) => {
          forwardCalls++;
          assert.equal(input.destination, 'owner@example.com');
          assert.equal(input.mailboxEmail, 'user@example.com');
          assert.equal(input.sourceMessageId, 'message-1');
          assert.equal(input.source.from, from);
          return 'gmail-message-1';
        },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => true,
      deliverLark: async () => {
        throw new Error('Lark delivery should not run.');
      },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(forwardCalls, 1);
    assert.equal(failed, false);
    assert.deepEqual(delivered, {
      deliveryId: 'delivery-1',
      providerMessageId: 'gmail-message-1',
    });
  });

  it('reruns immediately when a wake arrives during an active pass', async () => {
    let claims = 0;
    let releaseFirstClaim: (() => void) | undefined;
    const firstClaimStarted = new Promise<void>(resolve => {
      releaseFirstClaim = resolve;
    });
    let allowFirstClaimToFinish: (() => void) | undefined;
    const firstClaimBlocked = new Promise<void>(resolve => {
      allowFirstClaimToFinish = resolve;
    });
    const worker = new MailOpsWorker({
      repo: {
        claimNextDueMailbox: async () => {
          claims++;
          if (claims === 1) {
            releaseFirstClaim?.();
            await firstClaimBlocked;
          }
          return { ok: true, value: null };
        },
        claimNextDueDelivery: async () => ({ ok: true, value: null }),
      },
      gmail: {},
      resolveAccessToken: async () => 'unused',
      authorizeRule: async () => true,
      deliverLark: async () => 'unused',
      logger,
    } as any);

    const running = worker.runOnce();
    await firstClaimStarted;
    worker.wake();
    allowFirstClaimToFinish?.();
    await running;

    assert.equal(claims, 2);
  });
});
