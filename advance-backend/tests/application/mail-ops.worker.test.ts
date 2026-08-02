import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MailOpsWorker } from '../../src/application/mail-ops/mail-ops.worker.ts';
import { GmailApiError } from '../../src/infrastructure/google/gmail-history.client.ts';

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

// Every rule fixture carries a floor in the past. Production always
// populates `activatedAt`, and leaving it undefined makes the worker's
// rule-age guard vacuously true — it would pass even if the guard were
// deleted or pointed at a field that does not exist.
const RULE_ACTIVATED_AT = new Date('2020-01-01T00:00:00.000Z');

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
          activatedAt: RULE_ACTIVATED_AT,
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
            activatedAt: RULE_ACTIVATED_AT,
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
          activatedAt: RULE_ACTIVATED_AT,
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

  it('classifies a provider failure by its status and reason, not its prose', async () => {
    // `scope_missing` puts "Reconnect Google and allow Divo to read and send
    // mail" in front of a member, so a misclassification sends somebody to fix
    // an account that is working. This used to be decided by grepping Google's
    // English for `scope`, `permission`, `token` and `rate` — words Google
    // rewrites whenever it likes.
    const codeFor = async (error: unknown): Promise<string> => {
      let recorded = '';
      const worker = new MailOpsWorker({
        repo: syncRepo({
          markSyncFailed: async (_claim: any, code: string) => {
            recorded = code;
            return { ok: true, value: true };
          },
        }),
        gmail: { ...syncGmail, sync: async () => { throw error } },
        resolveAccessToken: async () => 'access-token',
        authorizeRule: async () => ({ verdict: 'allowed' }),
        deliverLark: async () => 'lark-message',
        logger,
      } as any);
      await worker.runOnce();
      return recorded;
    };

    // A 403 is both "not allowed" and "too fast"; only the reason separates them.
    assert.equal(
      await codeFor(new GmailApiError(403, 'Quota exceeded.', 'rateLimitExceeded')),
      'provider_rate_limited',
    );
    assert.equal(
      await codeFor(new GmailApiError(403, 'Insufficient Permission', 'insufficientPermissions')),
      'scope_missing',
    );
    assert.equal(
      await codeFor(new GmailApiError(401, 'Invalid Credentials', 'authError')),
      'connection_unavailable',
    );
    assert.equal(
      await codeFor(new GmailApiError(429, 'Too many requests.')),
      'provider_rate_limited',
    );
    // A 500 is transient and is nobody's account problem. The old heuristic
    // filed anything whose message merely said "rate" as rate limiting.
    assert.equal(
      await codeFor(new GmailApiError(500, 'Backend Error')),
      'provider_sync_failed',
    );
    // And a Google message that happens to contain a trigger word no longer
    // decides anything on its own.
    assert.equal(
      await codeFor(new GmailApiError(500, 'Could not verify scope permission token rate.')),
      'provider_sync_failed',
    );
  });

  it('does not blame Google for a failure that never came from it', async () => {
    let recorded = '';
    const worker = new MailOpsWorker({
      repo: syncRepo({
        markSyncFailed: async (_claim: any, code: string) => {
          recorded = code;
          return { ok: true, value: true };
        },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => {
        throw new Error('Divo could not read the stored connection permission rules.');
      },
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => 'lark-message',
      logger,
    } as any);

    await worker.runOnce();

    // "permission" in a Divo-side error used to stamp the mailbox
    // `scope_missing` and send its owner to reconnect a healthy account.
    assert.equal(recorded, 'provider_sync_failed');
  });

  it('drops a message over the rule ceiling and records what it cost', async () => {
    // Dropped, not deferred. Deferring holds the flood back for an hour and
    // then releases all of it at once, which is the outcome a ceiling exists to
    // prevent — so the drop has to be visible instead.
    let blocked: any;
    let reserved = 0;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        listActiveRules: async () => ({
          ok: true,
          value: [{
            ruleId: 'rule-1',
            activatedAt: RULE_ACTIVATED_AT,
            match: { from: 'alerts@example.com' },
            action: { type: 'deliver', rateLimitPerHour: 5 },
            destination: { type: 'lark_chat', chatId: 'oc_destination' },
          }],
        }),
        countRecentDeliveries: async () => ({ ok: true, value: 5 }),
        recordBlockedDelivery: async (input: any) => {
          blocked = input;
          return { ok: true, value: true };
        },
        reserveDelivery: async () => {
          reserved += 1;
          return { ok: true, value: { outcome: 'reserved', deliveryId: 'd' } };
        },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => { throw new Error('Nothing should be delivered.') },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(reserved, 0);
    assert.equal(blocked?.ruleId, 'rule-1');
    assert.match(blocked?.reason, /limit of 5 per hour/);
  });

  it('counts the ceiling against the hour the mail arrived in', async () => {
    // Not the hour Divo got round to it. A backlog drained late must decide the
    // same way it would have decided live, or the ceiling silently becomes a
    // function of how far behind the worker is.
    let since: Date | undefined;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        listActiveRules: async () => ({
          ok: true,
          value: [{
            ruleId: 'rule-1',
            activatedAt: RULE_ACTIVATED_AT,
            match: { from: 'alerts@example.com' },
            action: { type: 'deliver', rateLimitPerHour: 5 },
            destination: { type: 'lark_chat', chatId: 'oc_destination' },
          }],
        }),
        countRecentDeliveries: async (input: any) => {
          since = input.since;
          return { ok: true, value: 0 };
        },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => 'lark-message',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(
      since?.toISOString(),
      new Date(event.occurredAt.getTime() - 60 * 60_000).toISOString(),
    );
  });

  it('never asks about a ceiling a rule does not have', async () => {
    let counted = 0;
    const worker = new MailOpsWorker({
      repo: syncRepo({
        countRecentDeliveries: async () => {
          counted += 1;
          return { ok: true, value: 0 };
        },
      }),
      gmail: syncGmail,
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => 'lark-message',
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(counted, 0);
  });

  it('labels and archives in place, sending nothing', async () => {
    const modified: any[] = [];
    const worker = new MailOpsWorker({
      repo: syncRepo({
        claimNextDueDelivery: (() => {
          let handed = false;
          return async () => {
            if (handed) return { ok: true, value: null };
            handed = true;
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
                  idempotencyKey: 'mail:key',
                  action: { type: 'organize', label: 'Receipts', archive: true, markRead: true },
                  destination: { type: 'none' },
                  message: event.metadata,
                },
              },
            };
          };
        })(),
        claimNextDueMailbox: async () => ({ ok: true, value: null }),
      }),
      gmail: {
        ...syncGmail,
        resolveLabelId: async () => 'Label_7',
        organizeMessage: async (input: any) => {
          modified.push(input);
          return 'message-1';
        },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => { throw new Error('Nothing should be delivered.') },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(modified.length, 1);
    assert.equal(modified[0].messageId, 'message-1');
    assert.deepEqual(modified[0].addLabelIds, ['Label_7']);
    // Archiving is removing INBOX, which is what archiving is in Gmail.
    assert.deepEqual(modified[0].removeLabelIds, ['INBOX', 'UNREAD']);
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
            activatedAt: RULE_ACTIVATED_AT,
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

  it('does not backfill a brand-new rule with mail that predates it', async () => {
    // Pause every rule and the mailbox stops; add a rule a fortnight later and
    // its very first pass is a stale-cursor recovery holding a week of INBOX.
    // The new rule has no prior deliveries, so `reserveDelivery` dedupes
    // nothing — without this guard it forwards all of it. The tool's own
    // contract is that a rule reacts to future arrivals.
    //
    // Read off `activatedAt`, not `createdAt`, because the row outlives its
    // own archival: recreating an archived rule is the only way to bring it
    // back, and a replace reuses the row too. A rule first written in January,
    // archived, and asked for again today would otherwise carry a January
    // floor and pass the entire recovery window.
    const ruleCreatedAt = new Date('2026-01-04T00:00:00.000Z');
    const ruleActivatedAt = new Date('2026-08-01T00:00:00.000Z');
    const reserved: string[] = [];
    let mailboxClaimed = false;
    const worker = new MailOpsWorker({
      repo: {
        claimNextWatchRenewal: async () => ({ ok: true, value: null }),
        claimNextDueMailbox: async () => {
          if (mailboxClaimed) return { ok: true, value: null };
          mailboxClaimed = true;
          return { ok: true, value: claim };
        },
        recordEvents: async () => ({
          ok: true,
          value: [
            {
              eventId: 'event-old',
              occurredAt: new Date('2026-07-28T09:00:00.000Z'),
              metadata: event.metadata,
            },
            {
              eventId: 'event-new',
              occurredAt: new Date('2026-08-02T09:00:00.000Z'),
              metadata: event.metadata,
            },
          ],
        }),
        listActiveRules: async () => ({
          ok: true,
          value: [{
            ruleId: 'rule-1',
            createdAt: ruleCreatedAt,
            activatedAt: ruleActivatedAt,
            match: { from: 'alerts@example.com' },
            action: { type: 'deliver' },
            destination: { type: 'lark_chat', chatId: 'oc_destination' },
          }],
        }),
        reserveDelivery: async (
          _companyId: string,
          _subscriptionId: string,
          _ruleId: string,
          eventId: string,
        ) => {
          reserved.push(eventId);
          return { ok: true, value: true };
        },
        recordBlockedDelivery: async () => ({ ok: true, value: true }),
        advanceCursor: async () => ({ ok: true, value: true }),
        markSyncFailed: async () => ({ ok: true, value: true }),
        claimNextDueDelivery: async () => ({ ok: true, value: null }),
      },
      gmail: {
        watch: async () => ({ historyId: '100', expiration: new Date('2026-08-05T05:00:00.000Z') }),
        sync: async () => ({
          nextHistoryId: '900',
          events: [event],
          staleCursorRecovered: true,
          recoveredMessageCount: 2,
        }),
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => 'lark-message-1',
      logger,
    } as any);

    await worker.runOnce();

    assert.deepEqual(reserved, ['event-new']);
  });

  it('does not match its own forward arriving back in the mailbox', async () => {
    // A destination that aliases home, plus a rule matching on subject alone,
    // re-matches its own `Fwd:` output on every pass. Nothing else in a message
    // distinguishes Divo's forward from ordinary mail.
    let reservations = 0;
    let mailboxClaimed = false;
    const worker = new MailOpsWorker({
      repo: {
        claimNextWatchRenewal: async () => ({ ok: true, value: null }),
        claimNextDueMailbox: async () => {
          if (mailboxClaimed) return { ok: true, value: null };
          mailboxClaimed = true;
          return { ok: true, value: claim };
        },
        recordEvents: async () => ({
          ok: true,
          value: [{
            eventId: 'event-1',
            metadata: {
              ...event.metadata,
              subject: 'Fwd: Your secure link',
              forwardedByRuleId: 'rule-1',
            },
          }],
        }),
        listActiveRules: async () => ({
          ok: true,
          value: [{
            ruleId: 'rule-1',
            activatedAt: RULE_ACTIVATED_AT,
            match: { subjectContains: 'secure link' },
            action: { type: 'forward' },
            destination: { type: 'email', email: 'owner@example.com' },
          }],
        }),
        reserveDelivery: async () => { reservations += 1; return { ok: true, value: true }; },
        recordBlockedDelivery: async () => ({ ok: true, value: true }),
        advanceCursor: async () => ({ ok: true, value: true }),
        markSyncFailed: async () => ({ ok: true, value: true }),
        claimNextDueDelivery: async () => ({ ok: true, value: null }),
      },
      gmail: {
        watch: async () => ({ historyId: '100', expiration: new Date('2026-08-05T05:00:00.000Z') }),
        sync: async () => ({
          nextHistoryId: '101',
          events: [event],
          staleCursorRecovered: false,
        }),
        forward: async () => { throw new Error('Nothing should be forwarded.'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => { throw new Error('A skipped event must not cost a permission lookup.'); },
      deliverLark: async () => { throw new Error('unused'); },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(reservations, 0);
  });

  it('charges the connection rate budget for a background delivery', async () => {
    // A manager could throttle interactive use of a connection and a mail rule
    // on that same connection then ran under no policy at all — the worker was
    // built without any governance service at all.
    let deliveryClaimed = false;
    let consumed: any;
    let failedWith: string | undefined;
    let rescheduled: any;
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
        rescheduleDelivery: async (input: any) => {
          rescheduled = input;
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
      connectionRateLimits: {
        consume: async (input: any) => {
          consumed = input;
          return {
            kind: 'limited',
            message: 'Connection budget exhausted.',
            check: {
              windows: [
                // Both exhausted, so the retry has to clear both — the longer
                // is the answer. A shorter one first, so taking the head of
                // the list or the minimum is visibly wrong.
                { retryAfterSeconds: 90, used: 60, limit: 60 },
                { retryAfterSeconds: 1_800, used: 60, limit: 60 },
                // Configured, reported, nowhere near its ceiling. Waiting for
                // this one would drain the mailbox at a daily cadence because
                // a half-hour window was touched.
                { retryAfterSeconds: 80_000, used: 61, limit: 5_000 },
              ],
            },
          };
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
    // Rescheduled, not failed. The retry ladder abandons at five attempts with
    // backoff totalling about seventy-five seconds, so counting this as an
    // attempt threw the mail away a minute into a half-hour rate window.
    assert.equal(failedWith, undefined);
    assert.equal(rescheduled?.deliveryId, 'delivery-1');
    assert.equal(rescheduled?.attempts, 1);
    assert.equal(rescheduled?.reason, 'Connection budget exhausted.');
    // Waits for the window that actually refused it, not the longest window
    // the store happened to report.
    const waitMs = rescheduled!.nextAttemptAt.getTime() - Date.now();
    assert.ok(waitMs > 1_700_000 && waitMs <= 1_800_000, `waited ${waitMs}ms`);
  });

  it('never abandons a delivery for being over budget, however long that lasts', async () => {
    // The claim spends an attempt, so a refusal has to hand it back — five
    // refusals inside a rate window must leave the row exactly where it was.
    let claims = 0;
    let abandoned = 0;
    let failed = 0;
    const attemptsSeen: number[] = [];
    const worker = new MailOpsWorker({
      repo: {
        claimNextWatchRenewal: async () => ({ ok: true, value: null }),
        claimNextDueMailbox: async () => ({ ok: true, value: null }),
        claimNextDueDelivery: async () => {
          if (claims >= 5) return { ok: true, value: null };
          claims += 1;
          return {
            ok: true,
            value: {
              deliveryId: 'delivery-1',
              // The row never advances, because every refusal gives the
              // attempt back.
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
        rescheduleDelivery: async (input: any) => {
          attemptsSeen.push(input.attempts);
          return { ok: true, value: true };
        },
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async () => { failed += 1; return { ok: true, value: true }; },
        markDeliveryAbandoned: async () => { abandoned += 1; return { ok: true, value: true }; },
      },
      gmail: {
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      connectionRateLimits: {
        consume: async () => ({ kind: 'limited', message: 'Over budget.' }),
      },
      deliverLark: async () => { throw new Error('Nothing should be delivered.'); },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(claims, 5);
    assert.equal(failed, 0);
    assert.equal(abandoned, 0);
    assert.deepEqual(attemptsSeen, [1, 1, 1, 1, 1]);
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
    let staged: any;
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
        stageDeliveryDraft: async (input: any) => {
          staged = input;
          return { ok: true, value: true };
        },
      },
      gmail: {
        createForwardDraft: async (input: any) => {
          forwardCalls++;
          assert.equal(input.destination, 'owner@example.com');
          assert.equal(input.mailboxEmail, 'user@example.com');
          assert.equal(input.sourceMessageId, 'message-1');
          assert.equal(input.source.from, from);
          return 'draft-1';
        },
        sendForwardDraft: async (input: any) => {
          assert.equal(input.draftId, 'draft-1');
          return 'gmail-message-1';
        },
        forwardDraftPending: async () => {
          throw new Error('A first attempt has no staged draft to ask about.');
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
    // The draft ID is written down before the send, or it is invisible to the
    // retry and this is the duplicate-forward bug wearing a new hat.
    assert.deepEqual(staged, {
      deliveryId: 'delivery-1',
      attempts: 1,
      providerDraftId: 'draft-1',
    });
    assert.deepEqual(delivered, {
      deliveryId: 'delivery-1',
      providerMessageId: 'gmail-message-1',
    });
  });

  function retryHarness(input: {
    draftPending: boolean;
    onSend?: () => void;
  }) {
    let deliveryClaimed = false;
    const state: {
      delivered?: { deliveryId: string; providerMessageId?: string };
      failed: boolean;
      sends: number;
      drafts: number;
      askedAbout?: string;
    } = { failed: false, sends: 0, drafts: 0 };
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
              attempts: 2,
              // A previous attempt staged this and we never learned whether it
              // also sent — the exact state the old search-based guard could
              // not resolve.
              providerDraftId: 'draft-1',
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
                destination: { type: 'email', email: 'owner@example.com' },
                message: event.metadata,
              },
            },
          };
        },
        stageDeliveryDraft: async () => {
          throw new Error('A staged retry must not create a second draft.');
        },
        markDeliveryDelivered: async (deliveryId: string, providerMessageId?: string) => {
          state.delivered = { deliveryId, ...(providerMessageId ? { providerMessageId } : {}) };
          return { ok: true, value: true };
        },
        markDeliveryFailed: async () => { state.failed = true; return { ok: true, value: true }; },
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
      },
      gmail: {
        createForwardDraft: async () => { state.drafts++; return 'draft-2'; },
        forwardDraftPending: async (arg: any) => {
          state.askedAbout = arg.draftId;
          return input.draftPending;
        },
        sendForwardDraft: async () => {
          state.sends++;
          input.onSend?.();
          return 'gmail-message-1';
        },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => { throw new Error('unused'); },
      logger,
    } as any);
    return { worker, state };
  }

  it('does not file a completed send as refused when permission was revoked after it', async () => {
    // A retry holding a staged draft may be retrying a send that already
    // succeeded. Deciding it was refused — or dropping it for any other reason
    // — files a lie about mail already sitting in somebody's inbox, and leaves
    // the row permanently `ambiguous`.
    let deliveryClaimed = false;
    let abandoned = 0;
    let delivered: any;
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
              attempts: 2,
              providerDraftId: 'draft-1',
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
                destination: { type: 'email', email: 'owner@example.com' },
                message: event.metadata,
              },
            },
          };
        },
        markDeliveryDelivered: async (deliveryId: string) => {
          delivered = { deliveryId };
          return { ok: true, value: true };
        },
        markDeliveryFailed: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async () => { abandoned += 1; return { ok: true, value: true }; },
      },
      gmail: {
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
        forwardDraftPending: async () => false,
        createForwardDraft: async () => { throw new Error('unused'); },
        sendForwardDraft: async () => { throw new Error('Nothing should be sent again.'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => {
        throw new Error('A completed send must be settled before permission is re-asked.');
      },
      deliverLark: async () => { throw new Error('unused'); },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(abandoned, 0);
    assert.deepEqual(delivered, { deliveryId: 'delivery-1' });
  });

  it('stops calling a delivery unconfirmed once it is proved nothing was sent', async () => {
    // The probe answers "nothing went out" definitively when the draft is
    // still there. Abandoning the row right afterwards without spending that
    // answer leaves the screen showing "Unconfirmed" — "may already be in
    // somebody's inbox" — about mail that provably never left, and nothing
    // later will ever revisit it.
    let deliveryClaimed = false;
    let abandonedWith: any;
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
              attempts: 2,
              providerDraftId: 'draft-1',
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
                destination: { type: 'email', email: 'owner@example.com' },
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
          options?: unknown,
        ) => {
          abandonedWith = { deliveryId, attempts, reason, options };
          return { ok: true, value: true };
        },
      },
      gmail: {
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
        forwardDraftPending: async () => true,
        createForwardDraft: async () => { throw new Error('unused'); },
        sendForwardDraft: async () => { throw new Error('A denied delivery must not send.'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({
        verdict: 'denied',
        reason: 'Your Google connection no longer allows Divo to send mail.',
      }),
      deliverLark: async () => { throw new Error('unused'); },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(abandonedWith?.deliveryId, 'delivery-1');
    assert.deepEqual(abandonedWith?.options, { nothingWasSent: true });
  });

  it('leaves an unproved delivery unconfirmed when it is abandoned', async () => {
    // The mirror case, and the reason the flag is not just "we abandoned it".
    // With no staged draft nothing was ever asked, so the row keeps whatever
    // it already said about itself.
    let deliveryClaimed = false;
    let abandonedWith: any;
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
              attempts: 2,
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
                destination: { type: 'email', email: 'owner@example.com' },
                message: event.metadata,
              },
            },
          };
        },
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async (
          _deliveryId: string,
          _attempts: number,
          _reason: string,
          options?: unknown,
        ) => {
          abandonedWith = { options };
          return { ok: true, value: true };
        },
      },
      gmail: {
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
        forwardDraftPending: async () => { throw new Error('Nothing to ask about.'); },
        createForwardDraft: async () => { throw new Error('unused'); },
        sendForwardDraft: async () => { throw new Error('unused'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'denied', reason: 'Permission withdrawn.' }),
      deliverLark: async () => { throw new Error('unused'); },
      logger,
    } as any);

    await worker.runOnce();

    assert.deepEqual(abandonedWith?.options, { nothingWasSent: false });
  });

  it('carries the unsent proof into the last rung of the retry ladder', async () => {
    // The denial path is not the only terminal one. A throw between the probe
    // and the send — an unreadable permission store, a token that would not
    // resolve — abandons the row too once attempts reach five, which is about
    // seventy-five seconds of outage. The proof has to be spent there or the
    // "Unconfirmed" tag outlives every chance to answer it.
    let deliveryClaimed = false;
    let failedWith: any;
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
              attempts: 5,
              providerDraftId: 'draft-1',
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
                destination: { type: 'email', email: 'owner@example.com' },
                message: event.metadata,
              },
            },
          };
        },
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async (
          _id: string,
          _cause: unknown,
          attempts: number,
          _now?: Date,
          options?: unknown,
        ) => {
          failedWith = { attempts, options };
          return { ok: true, value: true };
        },
      },
      gmail: {
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
        forwardDraftPending: async () => true,
        createForwardDraft: async () => { throw new Error('unused'); },
        sendForwardDraft: async () => { throw new Error('Nothing should be sent.'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({
        verdict: 'unavailable',
        reason: 'The permission store could not be read.',
      }),
      deliverLark: async () => { throw new Error('unused'); },
      logger,
    } as any);

    await worker.runOnce();

    assert.equal(failedWith?.attempts, 5);
    assert.deepEqual(failedWith?.options, { nothingWasSent: true });
  });

  it('does not claim a send never happened once one has been attempted', async () => {
    // The mirror. Past the send the probe's answer is stale — that is the
    // whole reason the old code was ambiguous — so a failure after it must
    // leave the warning standing.
    let deliveryClaimed = false;
    let failedWith: any;
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
              attempts: 5,
              providerDraftId: 'draft-1',
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
                destination: { type: 'email', email: 'owner@example.com' },
                message: event.metadata,
              },
            },
          };
        },
        markDeliveryDelivered: async () => ({ ok: true, value: true }),
        markDeliveryAbandoned: async () => ({ ok: true, value: true }),
        markDeliveryFailed: async (
          _id: string,
          _cause: unknown,
          _attempts: number,
          _now?: Date,
          options?: unknown,
        ) => {
          failedWith = { options };
          return { ok: true, value: true };
        },
      },
      gmail: {
        watch: async () => { throw new Error('unused'); },
        sync: async () => { throw new Error('unused'); },
        forwardDraftPending: async () => true,
        createForwardDraft: async () => { throw new Error('unused'); },
        // The send is where it dies, so whether the mail went out is once
        // again genuinely unknown.
        sendForwardDraft: async () => { throw new Error('connection reset'); },
      },
      resolveAccessToken: async () => 'access-token',
      authorizeRule: async () => ({ verdict: 'allowed' }),
      deliverLark: async () => { throw new Error('unused'); },
      logger,
    } as any);

    await worker.runOnce();

    assert.deepEqual(failedWith?.options, { nothingWasSent: false });
  });

  it('does not forward twice when a send succeeded but its response was lost', async () => {
    // Gmail deletes a draft the moment it sends it, so a missing draft is proof
    // the mail went out. The old guard searched `in:sent rfc822msgid:` — for a
    // Message-ID Gmail commonly replaces, in an index that lags the send — and
    // so retried a delivery that had already happened.
    const { worker, state } = retryHarness({ draftPending: false });

    await worker.runOnce();

    assert.equal(state.askedAbout, 'draft-1');
    assert.equal(state.sends, 0);
    assert.equal(state.drafts, 0);
    assert.equal(state.failed, false);
    assert.deepEqual(state.delivered, { deliveryId: 'delivery-1' });
  });

  it('sends the staged draft when no send ever completed', async () => {
    // A draft that still exists is proof nothing went out, so sending that same
    // draft is safe — and reusing it is what keeps the retry from composing a
    // second copy.
    const { worker, state } = retryHarness({ draftPending: true });

    await worker.runOnce();

    assert.equal(state.drafts, 0);
    assert.equal(state.sends, 1);
    assert.deepEqual(state.delivered, {
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
