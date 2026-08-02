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
    let claimArgs: unknown[] = [];
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
      claimNextDueMailbox: async (...args: unknown[]) => {
        claimArgs = args;
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
      authorizeRule: async () => ({ verdict: 'allowed' }),
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

    // Claimed with no watch precondition even though Pub/Sub is configured:
    // reconciliation is the safety net for a watch that never registers.
    assert.deepEqual(claimArgs, []);
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
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(cursorAdvanced, false);
    assert.equal(syncFailed, true);
  });

  /** Repo stub with only the bits a sync-path test touches. */
  function syncRepo(overrides: Record<string, unknown> = {}) {
    let mailboxClaimed = false;
    return {
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
          departmentId: 'department-1',
          match: { from: 'alerts@example.com' },
          action: { type: 'deliver' },
          destination: { type: 'lark_chat', chatId: 'oc_destination' },
        }],
      }),
      reserveDelivery: async () => ({
        ok: true,
        value: { outcome: 'reserved', deliveryId: 'delivery-1' },
      }),
      recordBlockedDelivery: async () => ({ ok: true, value: true }),
      advanceCursor: async () => ({ ok: true, value: true }),
      markSyncFailed: async () => ({ ok: true, value: true }),
      claimNextDueDelivery: async () => ({ ok: true, value: null }),
      markDeliveryDelivered: async () => ({ ok: true, value: true }),
      markDeliveryFailed: async () => ({ ok: true, value: true }),
      markDeliveryAbandoned: async () => ({ ok: true, value: true }),
      ...overrides,
    };
  }

  const syncGmail = {
    watch: async () => { throw new Error('Watch should not run without a topic.') },
    sync: async () => ({
      nextHistoryId: '101',
      events: [event],
      staleCursorRecovered: false,
      truncated: false,
    }),
    forward: async () => 'unused',
  };

  it('keeps syncing when one rule is refused, and records the refusal', async () => {
    // The failure this replaces: the denial threw, escaped the per-rule loop,
    // failed the whole sync, and left the cursor unmoved — so one person
    // changing department stalled every rule on their mailbox indefinitely.
    let blocked: any;
    let syncFailed = false;
    let cursorAdvanced = false;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        recordBlockedDelivery: async (input: any) => {
          blocked = input;
          return { ok: true, value: true };
        },
        markSyncFailed: async () => { syncFailed = true; return { ok: true, value: true } },
        advanceCursor: async () => { cursorAdvanced = true; return { ok: true, value: true } },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({
        verdict: 'denied',
        reason: 'This rule is tied to a team you are no longer in.',
      }),
      deliverLark: async () => { throw new Error('Nothing should be delivered.') },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(syncFailed, false);
    assert.equal(cursorAdvanced, true);
    assert.equal(blocked?.ruleId, 'rule-1');
    assert.equal(blocked?.eventId, 'event-1');
    assert.match(blocked?.reason, /no longer in/);
  });

  it('does not record a refusal against mail the rule never matched', async () => {
    // A blocked row must mean "this matched and was refused". Recording every
    // message a denied rule ignored anyway would be noise dressed as evidence.
    let blockedCalls = 0;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        listActiveRules: async () => ({
          ok: true,
          value: [{
            ruleId: 'rule-1',
            match: { from: 'someone-else@example.com' },
            action: { type: 'deliver' },
            destination: { type: 'lark_chat', chatId: 'oc_destination' },
          }],
        }),
        recordBlockedDelivery: async () => {
          blockedCalls++;
          return { ok: true, value: true };
        },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'denied', reason: 'no access' }),
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(blockedCalls, 0);
  });

  it('holds the cursor when the permission store cannot answer', async () => {
    // An unreachable store is not a decision. Recording a refusal we cannot
    // stand behind would be permanent; retrying the same range is not.
    let syncFailed = false;
    let cursorAdvanced = false;
    let blockedCalls = 0;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        recordBlockedDelivery: async () => { blockedCalls++; return { ok: true, value: true } },
        markSyncFailed: async () => { syncFailed = true; return { ok: true, value: true } },
        advanceCursor: async () => { cursorAdvanced = true; return { ok: true, value: true } },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({
        verdict: 'unavailable',
        reason: 'permission store unreachable',
      }),
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(syncFailed, true);
    assert.equal(cursorAdvanced, false);
    assert.equal(blockedCalls, 0);
  });

  it('does not classify its own permission outage as a Google scope problem', async () => {
    // The failure-code classifier matches on substrings, and the canonical
    // reason contains "permission". That landed on `scope_missing`, which the
    // health layer turns into "Reconnect Google" — sending a member to fix an
    // account that is working, during a Divo-side outage.
    let failureCode: string | undefined;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        markSyncFailed: async (_claim: unknown, code: string) => {
          failureCode = code;
          return { ok: true, value: true };
        },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({
        verdict: 'unavailable',
        reason: 'Failed to load department permission rules',
      }),
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(failureCode, 'authorization_unavailable');
  });

  it('asks about a rule once per sync, not once per message', async () => {
    let authorizationCalls = 0;
    const events = [event, { ...event, eventId: 'event-2' }];
    const worker = new MailOpsWorker({
      repo: syncRepo({ recordEvents: async () => ({ ok: true, value: events }) }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => {
        authorizationCalls++;
        return { verdict: 'allowed' };
      },
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(authorizationCalls, 1);
  });

  it('comes straight back for a backlog it could only partly drain', async () => {
    // Without this the mailbox advances and then waits out the full
    // reconciliation interval with known unread history sitting behind it.
    let mailboxClaimed = false;
    let advanceOptions: unknown;
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
        recordEvents: async () => ({ ok: true, value: [] }),
        listActiveRules: async () => ({ ok: true, value: [] }),
        reserveDelivery: async () => ({ ok: true, value: { outcome: 'in_flight' } }),
        advanceCursor: async (
          _claim: unknown,
          _historyId: string,
          _now: Date,
          options: unknown,
        ) => {
          advanceOptions = options;
          return { ok: true, value: true };
        },
        markSyncFailed: async () => ({ ok: true, value: true }),
        claimNextDueDelivery: async () => ({ ok: true, value: null }),
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
      },
      gmail: {
        watch: async () => { throw new Error('Watch should not run without a topic.') },
        sync: async () => ({
          nextHistoryId: '120',
          events: [],
          staleCursorRecovered: false,
          truncated: true,
        }),
        forward: async () => 'unused',
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.deepEqual(advanceOptions, { pollImmediately: true });
  });

  it('fails a truncated pass that made no progress rather than calling it healthy', async () => {
    // The client returns the cursor unchanged when it drained the page limit
    // without consuming a single history record. Recording that as a clean
    // pass cleared the failure code and set lastSucceededAt, so the mailbox
    // reported healthy while repeating the same ten reads every hour and
    // delivering nothing.
    let advanceCalls = 0;
    let failureCode: string | undefined;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        advanceCursor: async () => {
          advanceCalls++;
          return { ok: true, value: true };
        },
        markSyncFailed: async (_claim: unknown, code: string) => {
          failureCode = code;
          return { ok: true, value: true };
        },
      }),
      gmail: {
        ...syncGmail,
        sync: async () => ({
          // Same cursor the claim carried.
          nextHistoryId: '100',
          events: [],
          staleCursorRecovered: false,
          truncated: true,
        }),
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => 'unused',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(advanceCalls, 0);
    assert.equal(failureCode, 'history_backlog_stalled');
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
        return {
          verdict: 'denied',
          reason: 'Your Google connection no longer allows Divo to send mail.',
        };
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
      // The refusal's own words reach the row, so the screen can explain it
      // rather than showing one generic sentence for every cause.
      reason: 'Your Google connection no longer allows Divo to send mail.',
    });
  });

  it('charges the connection rate budget for a background delivery', async () => {
    // A manager could throttle interactive use of a connection and a mail rule
    // on that same connection then ran under no policy at all — the worker was
    // built without any governance service at all.
    let deliveryClaimed = false;
    let consumed: any;
    let failedWith: string | undefined;
    let larkSends = 0;
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
                action: { type: 'deliver' },
                destination: { type: 'lark_chat', chatId: 'oc_destination' },
                message: event.metadata,
              },
            },
          };
        },
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async (_id: string, error: unknown) => {
          failedWith = error instanceof Error ? error.message : String(error);
          return { ok: true, value: true };
        },
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
      },
      gmail: {
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
        forward: async () => { throw new Error('unused'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      connectionRateLimits: {
        consume: async (input: any) => {
          consumed = input;
          return { kind: 'limited', message: 'Connection budget exhausted.' };
        },
      },
      deliverLark: async () => { larkSends += 1; return 'unexpected'; },
      logger,
    } as any);

    await worker.runOnce();

    assert.deepEqual(consumed, {
      companyId: 'company-1',
      connectionId: 'connection-1',
      action: 'execute',
    });
    assert.equal(larkSends, 0);
    // Failed, not abandoned: the budget window reopens and the mail is still
    // sitting there.
    assert.equal(failedWith, 'Connection budget exhausted.');
  });

  it('abandons rather than retries a Lark chat owned by another company', async () => {
    // Creation is where a chat is vetted, but the rule outlives that check. A
    // room in somebody else's company is never going to become the right
    // destination, so retrying it five times just knocks on their door five
    // times.
    let deliveryClaimed = false;
    let abandoned: { deliveryId: string; attempts: number; reason: string } | undefined;
    let larkSends = 0;
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
                action: { type: 'deliver' },
                destination: { type: 'lark_chat', chatId: 'oc_other_company' },
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
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
        forward: async () => { throw new Error('unused'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      authorizeLarkChat: async input => {
        assert.equal(input.companyId, 'company-1');
        assert.equal(input.chatId, 'oc_other_company');
        return { status: 'other_company' };
      },
      deliverLark: async () => { larkSends += 1; return 'unexpected'; },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(larkSends, 0);
    assert.deepEqual(abandoned, {
      deliveryId: 'delivery-1',
      attempts: 1,
      reason: 'The destination Lark chat belongs to a different company.',
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
      authorizeRule: async () => ({ verdict: 'allowed' }),
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
      authorizeRule: async () => ({ verdict: 'allowed' }),
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
