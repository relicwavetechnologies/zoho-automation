import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import type { MailOpsRepository } from '../../infrastructure/persistence/mail-ops.repository';
import type { MailboxSyncClaim } from '../../infrastructure/persistence/mail-ops.repository';
import {
  GmailApiError,
  MailTooLargeError,
  type GmailHistoryClient,
} from '../../infrastructure/google/gmail-history.client';
import {
  larkChatDeliveryAllowed,
  type AuthorizeLarkChatDestination,
} from './lark-chat-destination';
import {
  MAIL_DELIVERY_PAYLOAD_RETENTION_MS,
  MAIL_EVENT_BODY_RETENTION_MS,
  MAIL_EVENT_RETENTION_MS,
  MAIL_RETENTION_BATCH_SIZE,
  MAIL_RETENTION_MAX_BATCHES,
  MAIL_RETENTION_SWEEP_INTERVAL_MS,
  mailDeliveryIdempotencyKey,
  type MailMessageMetadata,
  type MailRuleAction,
  type PendingMailDeliveryPayload,
} from './mail-ops.types';
import {
  mailRuleMatches,
  parseMailRule,
  parseMailRuleDelivery,
} from './mail-rule.matcher';

const MAILBOX_BATCH_SIZE = 20;
const DEFAULT_BUDGET_RETRY_MS = 5 * 60_000;
const MAX_BUDGET_RETRY_MS = 60 * 60_000;
const DELIVERY_BATCH_SIZE = 50;

/**
 * How many pieces of work of one kind run at once.
 *
 * Four rather than one because the failure this worker had at scale was never
 * throughput in aggregate — it was head-of-line blocking. One mailbox with a
 * twenty-megabyte attachment spends half a minute in a media upload, and
 * serially every other mailbox and every other delivery waits behind it for
 * that half minute. Lanes mean the slow one occupies a lane rather than the
 * worker.
 *
 * Four rather than forty because the ceiling is Google's, not Divo's: past a
 * point more lanes only convert waiting into `quotaExceeded`, and a rate-limit
 * failure costs an attempt off a delivery's ladder.
 */
const DEFAULT_MAILBOX_LANES = 4;
const DEFAULT_DELIVERY_LANES = 4;
/** The most lanes a deployment may ask for, whatever it puts in the env. */
const MAX_LANES = 16;

/**
 * How many times one wake-up may refill its batch before yielding to the timer.
 *
 * A drain that spends its whole budget has not finished, it has stopped, so it
 * asks for another pass — otherwise a backlog leaves at fifty deliveries per
 * ten-second tick, five a second, no matter how much is queued. The cap is what
 * keeps that from becoming a loop this worker never returns from: twenty passes
 * is a thousand deliveries, and anything still waiting is picked up ten seconds
 * later rather than held.
 */
const MAX_TICK_PASSES = 20;

/** Lane counts come from a deployment, so they are bounded before use. */
function clampLanes(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_LANES, Math.max(1, Math.floor(value)));
}

/**
 * Whether a rule may act right now.
 *
 * `denied` carries the sentence a person will read on their rules screen —
 * "your access changed" is only useful if it says which access.
 */
export type RuleAuthorization =
  | { verdict: 'allowed' }
  | { verdict: 'denied'; reason: string }
  | { verdict: 'unavailable'; reason: string };

/**
 * Raised when the permission question could not be answered.
 *
 * A class rather than a plain Error so it can be told apart from a provider
 * failure by type. Nothing about this originates at Google: the permission
 * store was unreachable, which is Divo's problem, and the member must not be
 * sent to reconnect a healthy account over it.
 *
 * It used to matter more than it does. `syncFailureCode` decided by grepping
 * the error's prose, and this error's canonical text — "Failed to load
 * department permission rules" — contains the word "permission", so without
 * the type check a Divo-side database blip stamped the mailbox
 * `scope_missing`. That heuristic is gone; the type check stays, because
 * being explicit about which side a failure came from is worth more than the
 * one bug it originally prevented.
 */
class AuthorizationUnavailableError extends Error {
  constructor(reason: string) {
    super(`Mail rule authorization is unavailable: ${reason}`);
    this.name = 'AuthorizationUnavailableError';
  }
}

/**
 * Raised when a mailbox's history backlog cannot be advanced through.
 *
 * Distinct from a provider error because nothing is wrong with Google or with
 * the member's account — Divo simply cannot get past this stretch of history
 * with the page budget it allows itself.
 */
class HistoryBacklogStalledError extends Error {
  constructor(mailboxEmail: string) {
    super(
      `Gmail history for ${mailboxEmail} could not be advanced within the page limit.`,
    );
    this.name = 'HistoryBacklogStalledError';
  }
}

/**
 * What one wake-up of the worker did.
 *
 * Counters rather than a metrics client, because there is no metrics backend
 * to send them to yet and a log line somebody can grep is worth more than an
 * abstraction over a thing that does not exist.
 */
interface TickCounters {
  watchesRenewed: number;
  mailboxesSynced: number;
  mailboxesFailed: number;
  deliveriesAttempted: number;
  deliveriesSent: number;
  deliveriesFailed: number;
}

/** The rule's own hourly ceiling, where it has one. `organize` never does. */
const ruleRateLimit = (action: MailRuleAction): number | undefined =>
  action.type === 'organize' ? undefined : action.rateLimitPerHour;

type MailRepo = Pick<
  MailOpsRepository,
  | 'claimNextDueMailbox'
  | 'countRecentDeliveries'
  | 'recordEvents'
  | 'advanceCursor'
  | 'markSyncFailed'
  | 'recordReconciliation'
  | 'listActiveRules'
  | 'reserveDelivery'
  | 'recordBlockedDelivery'
  | 'isRuleSendable'
  | 'claimNextDueDelivery'
  | 'rescheduleDelivery'
  | 'stageDeliveryDraft'
  | 'markDeliveryDelivered'
  | 'markDeliveryFailed'
  | 'markDeliveryAbandoned'
  | 'stripEventBodies'
  | 'deleteEventsBefore'
  | 'dropTerminalPayloads'
  | 'claimNextWatchRenewal'
  | 'completeWatchRenewal'
  | 'failWatchRenewal'
>;

export class MailOpsWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private rerunRequested = false;
  /** When retention last ran. Undefined means it has not run this process. */
  private lastRetentionAt?: number;
  private readonly log: Logger;
  private readonly mailboxLanes: number;
  private readonly deliveryLanes: number;

  constructor(private readonly deps: {
    repo: MailRepo;
    gmail: Pick<
      GmailHistoryClient,
      | 'sync'
      | 'watch'
      | 'createForwardDraft'
      | 'sendForwardDraft'
      | 'forwardDraftPending'
      | 'organizeMessage'
      | 'resolveLabelId'
    >;
    resolveAccessToken(input: {
      companyId: string;
      userId: string;
      connectionId: string;
    }): Promise<string>;
    /**
     * Three answers, not two.
     *
     * `denied` is a decision about this rule and nothing else: record it, move
     * on, keep syncing. `unavailable` means the question could not be answered
     * — the permission store was unreachable — and must be retried rather than
     * turned into a refusal.
     *
     * It used to be a boolean, and the denial path threw. That throw escaped
     * the per-rule loop into the method-level catch, failed the sync, and left
     * the cursor where it was. One person moving teams stalled every rule on
     * their mailbox, indefinitely, five minutes at a time.
     */
    authorizeRule(input: {
      companyId: string;
      userId: string;
      connectionId: string;
      departmentId?: string;
    }): Promise<RuleAuthorization>;
    deliverLark(input: {
      chatId: string;
      text: string;
      idempotencyKey: string;
    }): Promise<string>;
    /**
     * Last check before a company's mail leaves for a Lark room.
     *
     * Creation is where a chat is really vetted; this exists because the rule
     * outlives that check. It refuses only a room positively known to belong to
     * another company — it cannot demand a room record, because the commonest
     * destination of all, the member's own DM with Divo, never has one.
     */
    authorizeLarkChat?: AuthorizeLarkChatDestination;
    /**
     * The connection's operating budget, applied to background delivery.
     *
     * A manager could throttle interactive use of a Google connection and a
     * mail rule on that same connection then ran under no policy at all — the
     * worker was constructed without any governance service, so every forward
     * and every Lark delivery bypassed the ceiling entirely.
     */
    connectionRateLimits?: {
      consume(input: {
        readonly companyId: string;
        readonly connectionId?: string;
        readonly action: 'execute';
      }): Promise<{
        readonly kind: string;
        readonly message?: string;
        readonly check?: {
          // `used`/`limit` because a check reports every configured window,
          // exhausted or not, and only the exhausted ones say when this
          // delivery may go.
          readonly windows: ReadonlyArray<{
            readonly retryAfterSeconds: number;
            readonly used: number;
            readonly limit: number;
          }>;
        };
      }>;
    };
    /**
     * Tells the mailbox owner, once, when their rules have stopped running.
     * Optional so the worker still runs headless in tests and in environments
     * with no outbound channel configured.
     */
    reviewMailboxHealth?(subscriptionId: string): Promise<unknown>;
    logger: Logger;
    pubsubTopicName?: string;
    scanIntervalMs?: number;
    /**
     * How many mailboxes and deliveries this worker handles at once.
     *
     * Set to 1 to get back exactly the serial behaviour this replaced, which is
     * the escape hatch if concurrency turns out to provoke something at Google
     * that one-at-a-time did not.
     */
    mailboxLanes?: number;
    deliveryLanes?: number;
  }) {
    this.log = deps.logger.child({ service: 'mail-ops-worker' });
    this.mailboxLanes = clampLanes(deps.mailboxLanes, DEFAULT_MAILBOX_LANES);
    this.deliveryLanes = clampLanes(deps.deliveryLanes, DEFAULT_DELIVERY_LANES);
  }

  start(): void {
    const tick = () => {
      void this.runOnce().catch(error => {
        this.log.error('mail_ops.tick_failed', { error: errorText(error) });
      });
    };
    tick();
    this.timer = setInterval(tick, this.deps.scanIntervalMs ?? 10_000);
    this.timer.unref?.();
  }

  wake(): void {
    this.rerunRequested = true;
    void this.runOnce().catch(error => {
      this.log.error('mail_ops.wake_failed', { error: errorText(error) });
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Counted over the whole call, including a re-run, because the question a
    // tick summary answers is "did that wake-up move any mail" — and a rerun
    // is the same wake-up still working.
    const tick = {
      watchesRenewed: 0,
      mailboxesSynced: 0,
      mailboxesFailed: 0,
      deliveriesAttempted: 0,
      deliveriesSent: 0,
      deliveriesFailed: 0,
    };
    const startedAt = Date.now();
    // Split out of the total, because "the tick took ninety seconds" does not
    // say whether mail was slow to read or slow to send, and those have
    // different remedies.
    let mailboxMs = 0;
    let deliveryMs = 0;
    let saturated = false;
    let passes = 0;
    try {
      do {
        this.rerunRequested = false;
        passes += 1;
        if (this.deps.pubsubTopicName) {
          await this.drain({
            budget: MAILBOX_BATCH_SIZE,
            lanes: this.mailboxLanes,
            claim: () => this.deps.repo.claimNextWatchRenewal(),
            onClaimed: () => { tick.watchesRenewed += 1; },
            run: claim => this.renewWatch(claim),
          });
        }
        // Unconditional, whether or not Pub/Sub is configured and whether or
        // not this mailbox's watch ever registered. Reconciliation is the
        // safety net for a missing watch; gating it on the watch removed the
        // net exactly when it was needed.
        const mailboxes = await this.drain({
          budget: MAILBOX_BATCH_SIZE,
          lanes: this.mailboxLanes,
          claim: () => this.deps.repo.claimNextDueMailbox(),
          onClaimed: () => { tick.mailboxesSynced += 1; },
          run: claim => this.syncMailbox(claim, tick),
        });
        mailboxMs += mailboxes.durationMs;
        const deliveries = await this.drain({
          budget: DELIVERY_BATCH_SIZE,
          lanes: this.deliveryLanes,
          claim: () => this.deps.repo.claimNextDueDelivery(),
          onClaimed: () => { tick.deliveriesAttempted += 1; },
          run: claim => this.deliver(claim, tick),
        });
        deliveryMs += deliveries.durationMs;
        // Either drain stopping on its budget rather than on an empty queue
        // means there is known work still waiting. Going round again is the
        // difference between draining a backlog and metering it out fifty at a
        // time for as long as it lasts.
        if (mailboxes.saturated || deliveries.saturated) {
          saturated = true;
          if (passes < MAX_TICK_PASSES) this.rerunRequested = true;
        }
        await this.sweepRetention();
      } while (this.rerunRequested);
      // Emitted only when something happened. A worker that wakes every ten
      // seconds and finds nothing would otherwise bury the ticks that matter
      // under eight thousand a day that say nothing.
      if (
        tick.mailboxesSynced + tick.deliveriesAttempted + tick.watchesRenewed > 0
      ) {
        this.log.info('mail_ops.tick_summary', {
          ...tick,
          mailboxMs,
          deliveryMs,
          passes,
          // The one number that says this worker is behind rather than busy: a
          // tick that filled its budget left mail waiting for the next one.
          saturated,
          mailboxLanes: this.mailboxLanes,
          deliveryLanes: this.deliveryLanes,
          durationMs: Date.now() - startedAt,
        });
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Runs one kind of work across several lanes until it runs out or the batch
   * budget is spent.
   *
   * Safe to run concurrently because every claim underneath is a
   * compare-and-swap: two lanes reaching for the same row produce one winner,
   * and the loser looks past it rather than reporting the queue empty. That
   * property is what this depends on, and it is the reason the claims retry
   * internally now — without it the first collision in a drain would end the
   * losing lane's whole batch.
   *
   * The budget is shared across lanes rather than handed to each, so the lane
   * count changes how fast a tick drains and never how much it does. Failures
   * are collected and rethrown after every lane has settled: rethrowing from
   * inside `Promise.all` leaves the other lanes running against a worker that
   * has already given up, and their rejections then surface detached from the
   * tick that owned them.
   */
  private async drain<T>(input: {
    budget: number;
    lanes: number;
    claim: () => Promise<Result<T | null, InfraError>>;
    run: (claimed: T) => Promise<void>;
    onClaimed: () => void;
  }): Promise<{ saturated: boolean; durationMs: number }> {
    const startedAt = Date.now();
    let remaining = input.budget;
    let failure: unknown;
    const lane = async (): Promise<void> => {
      while (remaining > 0 && failure === undefined) {
        // Spent before the claim rather than after it, so two lanes cannot both
        // see the last unit of budget and between them do one more piece of
        // work than the tick allowed.
        remaining -= 1;
        const claimed = await input.claim();
        if (!claimed.ok) throw claimed.error;
        if (!claimed.value) return;
        input.onClaimed();
        await input.run(claimed.value);
      }
    };
    await Promise.all(
      Array.from({ length: input.lanes }, () => lane().catch((error: unknown) => {
        failure ??= error;
      })),
    );
    if (failure !== undefined) throw failure;
    // Distinguishable from "ran out of work" only here: the lanes themselves
    // cannot tell, because a lane that finds nothing and a lane that runs out
    // of budget both simply stop.
    return { saturated: remaining <= 0, durationMs: Date.now() - startedAt };
  }

  /**
   * Forgets what nothing needs any more.
   *
   * Runs at the end of a tick, after mail has moved, and at most hourly — it
   * is the least urgent thing this worker does and must never be the reason a
   * delivery waited. Its failures are logged and swallowed for the same
   * reason: a retention sweep that could not run is not a reason to stop
   * delivering somebody's mail.
   *
   * Nothing was ever forgotten before this. A mailbox watched for a year held
   * a year of message bodies, in two places — the event and the frozen
   * delivery payload — for no purpose after the first hour.
   */
  private async sweepRetention(now = Date.now()): Promise<void> {
    if (
      this.lastRetentionAt !== undefined
      && now - this.lastRetentionAt < MAIL_RETENTION_SWEEP_INTERVAL_MS
    ) return;
    this.lastRetentionAt = now;
    const at = (ageMs: number) => new Date(now - ageMs);
    /**
     * Runs one sweep in batches until it clears or the ceiling is reached.
     *
     * Stops the moment a batch comes back short, which is what "nothing left"
     * looks like — so a caught-up system pays one cheap query per hour rather
     * than ten.
     */
    const inBatches = async (
      sweep: (before: Date, limit: number) => Promise<Result<number, InfraError>>,
      before: Date,
    ): Promise<number> => {
      let total = 0;
      for (let batch = 0; batch < MAIL_RETENTION_MAX_BATCHES; batch++) {
        const done = await sweep(before, MAIL_RETENTION_BATCH_SIZE);
        if (!done.ok) throw done.error;
        total += done.value;
        if (done.value < MAIL_RETENTION_BATCH_SIZE) break;
      }
      return total;
    };
    try {
      // Bodies first, deletions after. Doing it the other way round is not
      // wrong, only wasteful: it strips text from rows about to be removed.
      const bodies = await inBatches(
        this.deps.repo.stripEventBodies,
        at(MAIL_EVENT_BODY_RETENTION_MS),
      );
      const payloads = await inBatches(
        this.deps.repo.dropTerminalPayloads,
        at(MAIL_DELIVERY_PAYLOAD_RETENTION_MS),
      );
      const events = await inBatches(
        this.deps.repo.deleteEventsBefore,
        at(MAIL_EVENT_RETENTION_MS),
      );
      if (bodies + payloads + events > 0) {
        this.log.info('mail_ops.retention_swept', {
          bodiesStripped: bodies,
          payloadsDropped: payloads,
          eventsDeleted: events,
        });
      }
    } catch (error) {
      this.log.error('mail_ops.retention_failed', { error: errorText(error) });
    }
  }

  private async renewWatch(claim: {
    subscriptionId: string;
    companyId: string;
    userId: string;
    connectionId: string;
    mailboxEmail: string;
    claimToken: string;
  }): Promise<void> {
    try {
      const accessToken = await this.deps.resolveAccessToken({
        companyId: claim.companyId,
        userId: claim.userId,
        connectionId: claim.connectionId,
      });
      const watch = await this.deps.gmail.watch({
        accessToken,
        topicName: this.deps.pubsubTopicName!,
      });
      const completed = await this.deps.repo.completeWatchRenewal(
        claim,
        watch.historyId,
        watch.expiration,
      );
      if (!completed.ok) throw completed.error;
      this.log.info('mail_ops.gmail_watch_renewed', {
        subscriptionId: claim.subscriptionId,
        expiration: watch.expiration.toISOString(),
      });
    } catch (error) {
      const failed = await this.deps.repo.failWatchRenewal(
        claim,
        syncFailureCode(error),
      );
      if (!failed.ok) throw failed.error;
      this.log.warn('mail_ops.gmail_watch_failed', {
        subscriptionId: claim.subscriptionId,
        error: errorText(error),
      });
    }
    await this.reviewHealth(claim.subscriptionId);
  }

  /**
   * Reviewed after the outcome is durable, so the owner is never told about a
   * state the database does not agree with. Failures here are swallowed by the
   * notifier itself — an unreachable owner must not stall the mailbox.
   */
  private async reviewHealth(subscriptionId: string): Promise<void> {
    if (!this.deps.reviewMailboxHealth) return;
    try {
      await this.deps.reviewMailboxHealth(subscriptionId);
    } catch (error) {
      this.log.warn('mail_ops.health_review_failed', {
        subscriptionId,
        error: errorText(error),
      });
    }
  }

  private async syncMailbox(
    claim: MailboxSyncClaim,
    tick?: TickCounters,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const accessToken = await this.deps.resolveAccessToken({
        companyId: claim.companyId,
        userId: claim.userId,
        connectionId: claim.connectionId,
      });
      const sync = await this.deps.gmail.sync({
        accessToken,
        ...(claim.historyId ? { historyId: claim.historyId } : {}),
        // Where the last truncated pass stopped. Only meaningful with the
        // cursor it was issued under, which is why the cursor is held still
        // for as long as a token is outstanding.
        ...(claim.historyPageToken ? { pageToken: claim.historyPageToken } : {}),
      });
      const persisted = await this.deps.repo.recordEvents(
        claim,
        sync.events,
      );
      if (!persisted.ok) throw persisted.error;
      const rules = await this.deps.repo.listActiveRules(claim.subscriptionId);
      if (!rules.ok) throw rules.error;

      // Resolved at most once per rule per sync rather than once per event per
      // rule. The old placement ran N events × M rules permission lookups for
      // an answer that cannot change mid-pass.
      const authorizations = new Map<string, RuleAuthorization>();
      const authorizationFor = async (
        rawRule: { ruleId: string; departmentId?: string },
      ): Promise<RuleAuthorization> => {
        const cached = authorizations.get(rawRule.ruleId);
        if (cached) return cached;
        const resolved = await this.deps.authorizeRule({
          companyId: claim.companyId,
          userId: claim.userId,
          connectionId: claim.connectionId,
          ...(rawRule.departmentId
            ? { departmentId: rawRule.departmentId }
            : {}),
        });
        authorizations.set(rawRule.ruleId, resolved);
        return resolved;
      };

      let deliveries = 0;
      // Sorted here as well as in the query, because this loop is what depends
      // on it: a rule's hourly ceiling counts what arrived *before* the message
      // being judged, so out of order every message in a recovered backlog sees
      // an empty window and the ceiling stops existing. Making the loop
      // establish its own precondition means a future change to how events come
      // back cannot quietly uncap every rate-limited rule.
      const inArrivalOrder = [...persisted.value].sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
      );
      for (const event of inArrivalOrder) {
        const message = readMessageMetadata(event.metadata);
        if (!message) {
          this.log.warn('mail_ops.event_metadata_invalid', {
            subscriptionId: claim.subscriptionId,
            eventId: event.eventId,
          });
          continue;
        }
        // Divo's own forward, arriving back in the mailbox it left. A
        // destination that aliases home plus a subject-only rule would
        // otherwise re-match its own `Fwd:` output on every pass, forever.
        // Skipped whichever rule sent it: a loop through two rules is still a
        // loop.
        if (message.forwardedByRuleId) {
          this.log.info('mail_ops.event_self_forward_skipped', {
            subscriptionId: claim.subscriptionId,
            eventId: event.eventId,
            forwardedByRuleId: message.forwardedByRuleId,
          });
          continue;
        }
        for (const rawRule of rules.value) {
          // A rule reacts to future arrivals, which is exactly what the tool
          // promises, and mail that predates it is not one. This matters
          // because a cursor can be a week stale — pause every rule and the
          // mailbox stops; add a rule later and the first pass is a
          // stale-cursor recovery holding a week of INBOX. Without this the
          // brand-new rule matches all of it, dedupes against nothing, and
          // forwards hundreds of old messages to its destination.
          //
          // Against `activatedAt`, not `createdAt`: reviving an archived rule
          // and replacing a rule both reuse the original row, so `createdAt`
          // can predate the current destination by months.
          if (event.occurredAt < rawRule.activatedAt) continue;

          let rule;
          try {
            rule = parseMailRule(rawRule);
          } catch (error) {
            // No blocked row here on purpose. The clause that failed to parse
            // is the match clause, so there is no honest way to say whether
            // this message would have matched. The rule itself already reports
            // `broken` with the reason, which is the truthful place for it.
            this.log.warn('mail_ops.rule_skipped', {
              ruleId: rawRule.ruleId,
              error: errorText(error),
            });
            continue;
          }
          // Matching before authorizing, so a recorded refusal always means
          // "this message matched your rule and was refused" rather than
          // covering every message the rule would have ignored anyway.
          if (!mailRuleMatches(rule.match, message, event.occurredAt)) continue;

          const authorized = await authorizationFor(rawRule);
          if (authorized.verdict === 'unavailable') {
            // Not an answer. Fail the sync so the cursor holds and the same
            // range is retried, rather than recording a refusal we cannot
            // stand behind.
            throw new AuthorizationUnavailableError(authorized.reason);
          }
          if (authorized.verdict === 'denied') {
            const blocked = await this.deps.repo.recordBlockedDelivery({
              companyId: claim.companyId,
              subscriptionId: claim.subscriptionId,
              ruleId: rawRule.ruleId,
              eventId: event.eventId,
              reason: authorized.reason,
              message,
            });
            if (!blocked.ok) throw blocked.error;
            this.log.warn('mail_ops.rule_permission_denied', {
              ruleId: rawRule.ruleId,
              eventId: event.eventId,
              reason: authorized.reason,
            });
            continue;
          }

          // The rule's own ceiling, distinct from the connection budget above
          // it: that one protects Google from Divo, this one protects whoever
          // is on the other end of the destination from a mailing list nobody
          // expected. Over the ceiling the message is *dropped*, not deferred —
          // deferring would hold the flood back for an hour and then release
          // all of it at once, which is the outcome a ceiling exists to
          // prevent. The drop is recorded, so the member can see what it cost.
          const ceiling = ruleRateLimit(rule.action);
          if (ceiling !== undefined) {
            const recent = await this.deps.repo.countRecentDeliveries({
              ruleId: rawRule.ruleId,
              since: new Date(event.occurredAt.getTime() - 60 * 60_000),
              until: event.occurredAt,
              exceptEventId: event.eventId,
            });
            if (!recent.ok) throw recent.error;
            if (recent.value >= ceiling) {
              const blocked = await this.deps.repo.recordBlockedDelivery({
                companyId: claim.companyId,
                subscriptionId: claim.subscriptionId,
                ruleId: rawRule.ruleId,
                eventId: event.eventId,
                reason: `This rule's limit of ${ceiling} per hour was already `
                  + 'reached, so this message was not sent.',
                message,
              });
              if (!blocked.ok) throw blocked.error;
              this.log.warn('mail_ops.rule_rate_limited', {
                ruleId: rawRule.ruleId,
                eventId: event.eventId,
                ceiling,
              });
              continue;
            }
          }

          const idempotencyKey = mailDeliveryIdempotencyKey(
            rawRule.ruleId,
            event.eventId,
          );
          const payload: PendingMailDeliveryPayload = {
            companyId: claim.companyId,
            userId: claim.userId,
            ...(rawRule.departmentId
              ? { departmentId: rawRule.departmentId }
              : {}),
            subscriptionId: claim.subscriptionId,
            connectionId: claim.connectionId,
            mailboxEmail: claim.mailboxEmail,
            ruleId: rawRule.ruleId,
            eventId: event.eventId,
            sourceMessageId: event.providerMessageId,
            idempotencyKey,
            action: rule.action,
            destination: rule.destination,
            message,
          };
          const reserved = await this.deps.repo.reserveDelivery(
            claim.companyId,
            claim.subscriptionId,
            rawRule.ruleId,
            event.eventId,
            payload as unknown as Record<string, unknown>,
          );
          if (!reserved.ok) throw reserved.error;
          if (reserved.value.outcome === 'reserved') deliveries++;
        }
      }
      // Truncated *and* stationary is not a success. The client hit the page
      // limit without consuming a single history record — pages of label
      // changes with no INBOX arrival among them — so it returned the cursor
      // it was given rather than guess forward.
      //
      // Recording that as a clean pass cleared failureCode and set
      // lastSucceededAt, so the mailbox reported healthy while repeating the
      // identical ten reads every hour and delivering nothing. Any arrival
      // sitting beyond that window went undelivered until Gmail expired the
      // cursor a week later and the 404 path recovered with a one-day scan,
      // silently dropping the days in between.
      //
      // Failing it is the honest answer: the member is told, and the state is
      // visible. It is now the last resort rather than the usual outcome — a
      // truncated pass hands back where it stopped, and the next one resumes
      // there instead of re-reading the same ten pages.
      if (sync.truncated && !sync.nextPageToken) {
        throw new HistoryBacklogStalledError(claim.mailboxEmail);
      }
      const advanced = await this.deps.repo.advanceCursor(
        claim,
        sync.nextHistoryId,
        new Date(),
        {
          pollImmediately: sync.truncated,
          // Written on every pass, not only a truncated one: the clear is what
          // ends a walk. Left standing after the walk finished, the next pass
          // would resume from a token belonging to history already consumed.
          pageToken: sync.nextPageToken ?? null,
        },
      );
      if (!advanced.ok) throw advanced.error;
      if (!advanced.value) {
        throw new Error('Mailbox sync claim was lost before cursor advancement.');
      }
      // A recovery is not an ordinary sync and should not read like one in the
      // logs: the cursor was rejected outright, which means mail was missed,
      // and this line is the only record of how much of it came back.
      if (sync.staleCursorRecovered) {
        // Durable as well as logged. `recoveryTruncated` marks the only place
        // in this system where mail is knowingly lost, and a log line is not
        // something anybody can query a month later when they are asked what
        // happened to a message. Best effort: this is evidence about a sync,
        // not part of one, and failing the pass over a failed audit insert
        // would turn a recovered mailbox back into a stopped one.
        const recorded = await this.deps.repo.recordReconciliation({
          companyId: claim.companyId,
          subscriptionId: claim.subscriptionId,
          recoveredCount: sync.recoveredMessageCount ?? 0,
          truncated: sync.recoveryTruncated === true,
        });
        if (!recorded.ok) {
          this.log.error('mail_ops.reconciliation_audit_failed', {
            subscriptionId: claim.subscriptionId,
            error: errorText(recorded.error),
          });
        }
        const log = sync.recoveryTruncated
          ? this.log.error.bind(this.log)
          : this.log.warn.bind(this.log);
        log('mail_ops.stale_cursor_recovered', {
          subscriptionId: claim.subscriptionId,
          mailboxEmail: claim.mailboxEmail,
          recoveredMessageCount: sync.recoveredMessageCount ?? 0,
          // True means the window held more than one pass reads, so some of
          // what the dead cursor missed is gone for good.
          recoveryTruncated: sync.recoveryTruncated === true,
        });
      }
      this.log.info('mail_ops.mailbox_synced', {
        subscriptionId: claim.subscriptionId,
        eventCount: persisted.value.length,
        deliveryCount: deliveries,
        staleCursorRecovered: sync.staleCursorRecovered,
        truncated: sync.truncated,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failed = await this.deps.repo.markSyncFailed(
        claim,
        syncFailureCode(error),
        error,
        new Date(Date.now() + 5 * 60_000),
      );
      if (!failed.ok) throw failed.error;
      if (tick) {
        tick.mailboxesFailed += 1;
        // A mailbox that failed did not sync, however the tick counted it on
        // the way in. A summary reporting twenty synced and three failed out
        // of twenty is the kind of arithmetic nobody checks and everybody
        // misreads.
        tick.mailboxesSynced = Math.max(0, tick.mailboxesSynced - 1);
      }
      this.log.warn('mail_ops.mailbox_sync_failed', {
        subscriptionId: claim.subscriptionId,
        error: errorText(error),
      });
    }
    await this.reviewHealth(claim.subscriptionId);
  }

  /**
   * Forward through a draft, and never send the same one twice.
   *
   * Three steps, in this order, because the order is the guarantee: stage the
   * draft, write its ID down, send it. If anything is lost after the send —
   * the response, the process, the network — the next attempt arrives holding
   * that ID, and `deliver` asks Gmail the one unambiguous question before it
   * gets here.
   *
   * So a draft handed in as `stagedDraftId` has already been proved live, and
   * is sent rather than composed again — reusing it is what keeps a retry from
   * putting a second copy in somebody's inbox.
   */
  private async forwardThroughDraft(input: {
    accessToken: string;
    deliveryId: string;
    attempts: number;
    payload: PendingMailDeliveryPayload;
    stagedDraftId?: string;
  }): Promise<string> {
    const { payload } = input;
    if (payload.destination.type !== 'email') {
      throw new Error('Mail delivery action and destination do not match.');
    }

    if (input.stagedDraftId) {
      return this.deps.gmail.sendForwardDraft({
        accessToken: input.accessToken,
        draftId: input.stagedDraftId,
      });
    }

    const draftId = await this.deps.gmail.createForwardDraft({
      accessToken: input.accessToken,
      destination: payload.destination.email,
      mailboxEmail: payload.mailboxEmail,
      sourceMessageId: payload.sourceMessageId,
      source: payload.message,
      idempotencyKey: payload.idempotencyKey,
      ruleId: payload.ruleId,
    });
    // Written down before the send, or the draft is invisible to the retry and
    // this is the old duplicate-forward bug wearing a new hat.
    const staged = await this.deps.repo.stageDeliveryDraft({
      deliveryId: input.deliveryId,
      attempts: input.attempts,
      providerDraftId: draftId,
    });
    if (!staged.ok) throw staged.error;
    if (!staged.value) {
      throw new Error('Mail delivery claim was lost before the draft was staged.');
    }
    return this.deps.gmail.sendForwardDraft({
      accessToken: input.accessToken,
      draftId,
    });
  }

  private async deliver(
    input: {
      deliveryId: string;
      attempts: number;
      payload: Record<string, unknown>;
      providerDraftId?: string;
    },
    tick?: TickCounters,
  ): Promise<void> {
    const startedAt = Date.now();
    // Set once the probe says the draft is still sitting there unsent, and
    // cleared the moment anything might have gone out. Declared out here
    // because the failure path is the other place that needs the answer.
    let nothingWasSent = false;
    try {
      const payload = readDeliveryPayload(input.payload);
      this.log.info('mail_ops.delivery_attempt_started', {
        deliveryId: input.deliveryId,
        attempts: input.attempts,
        action: payload.action.type,
        destination: payload.destination.type,
      });
      // Asked before anything else, because everything else assumes nothing
      // has been sent yet. A retry holding a staged draft may be retrying a
      // send that already succeeded, and deciding it was refused — or dropping
      // it for any other reason — would file a lie about mail that is already
      // in somebody's inbox, and leave the row permanently `ambiguous`.
      if (input.providerDraftId) {
        const pending = await this.deps.gmail.forwardDraftPending({
          accessToken: await this.deps.resolveAccessToken({
            companyId: payload.companyId,
            userId: payload.userId,
            connectionId: payload.connectionId,
          }),
          draftId: input.providerDraftId,
        });
        nothingWasSent = pending;
        if (!pending) {
          const settled = await this.deps.repo.markDeliveryDelivered(
            input.deliveryId,
          );
          if (!settled.ok) throw settled.error;
          this.log.info('mail_ops.delivery_confirmed_from_draft', {
            deliveryId: input.deliveryId,
            attempts: input.attempts,
          });
          return;
        }
      }
      // Asked after the draft and before everything else. Reserving a delivery
      // and sending it are two stages that can be over a minute apart once a
      // failed attempt is on the retry ladder, and the rule's status was only
      // ever read in the first — so pausing a rule stopped new mail matching
      // while whatever was already reserved went out regardless. "Stop
      // forwarding" is the whole of what pause promises.
      const sendable = await this.deps.repo.isRuleSendable(payload.ruleId);
      if (!sendable.ok) throw sendable.error;
      if (!sendable.value) {
        const abandoned = await this.deps.repo.markDeliveryAbandoned(
          input.deliveryId,
          input.attempts,
          'The rule was paused or archived before this message was sent.',
          { nothingWasSent },
        );
        if (!abandoned.ok) throw abandoned.error;
        this.log.info('mail_ops.delivery_rule_stopped', {
          deliveryId: input.deliveryId,
          ruleId: payload.ruleId,
        });
        return;
      }
      const authorized = await this.deps.authorizeRule({
        companyId: payload.companyId,
        userId: payload.userId,
        connectionId: payload.connectionId,
        ...(payload.departmentId
          ? { departmentId: payload.departmentId }
          : {}),
      });
      if (authorized.verdict === 'unavailable') {
        // Retryable: burning an attempt is fine, giving up permanently on an
        // unanswerable question is not.
        throw new AuthorizationUnavailableError(authorized.reason);
      }
      if (authorized.verdict === 'denied') {
        const abandoned = await this.deps.repo.markDeliveryAbandoned(
          input.deliveryId,
          input.attempts,
          authorized.reason,
          { nothingWasSent },
        );
        if (!abandoned.ok) throw abandoned.error;
        this.log.warn('mail_ops.delivery_permission_revoked', {
          deliveryId: input.deliveryId,
          reason: authorized.reason,
        });
        return;
      }
      // Charged per attempt, before the send, exactly as the interactive path
      // charges it. A rule that has exhausted its connection's budget waits for
      // the window rather than failing permanently — the mail is still there.
      if (this.deps.connectionRateLimits) {
        const budget = await this.deps.connectionRateLimits.consume({
          companyId: payload.companyId,
          connectionId: payload.connectionId,
          action: 'execute',
        });
        if (budget.kind === 'limited' || budget.kind === 'unavailable') {
          // Not a failed attempt — a "not yet". Counting it as an attempt
          // abandoned the mail about a minute into an hour-long rate window,
          // which is the opposite of what a budget is for.
          const rescheduled = await this.deps.repo.rescheduleDelivery({
            deliveryId: input.deliveryId,
            attempts: input.attempts,
            nextAttemptAt: new Date(
              Date.now() + budgetRetryDelayMs(budget.check),
            ),
            reason: budget.message
              ?? 'The connection rate budget refused this delivery.',
          });
          if (!rescheduled.ok) throw rescheduled.error;
          this.log.info('mail_ops.delivery_budget_deferred', {
            deliveryId: input.deliveryId,
            kind: budget.kind,
          });
          return;
        }
      }
      let providerMessageId: string;
      if (
        payload.action.type === 'forward'
        && payload.destination.type === 'email'
      ) {
        const accessToken = await this.deps.resolveAccessToken({
          companyId: payload.companyId,
          userId: payload.userId,
          connectionId: payload.connectionId,
        });
        // Past this line something may have gone out, so the probe's answer
        // stops being true and must not be spent on anything downstream.
        nothingWasSent = false;
        // The staged draft was already proved live at the top of this method,
        // so it is safe to send rather than compose a second copy.
        providerMessageId = await this.forwardThroughDraft({
          accessToken,
          deliveryId: input.deliveryId,
          attempts: input.attempts,
          payload,
          ...(input.providerDraftId
            ? { stagedDraftId: input.providerDraftId }
            : {}),
        });
      } else if (
        payload.action.type === 'deliver'
        && payload.destination.type === 'lark_chat'
      ) {
        const chat = payload.destination.chatId;
        if (this.deps.authorizeLarkChat) {
          const verdict = await this.deps.authorizeLarkChat({
            companyId: payload.companyId,
            chatId: chat,
          });
          if (!larkChatDeliveryAllowed(verdict)) {
            // Never going to become right, so retrying only means this
            // company's mail knocks on another company's door five times.
            const abandoned = await this.deps.repo.markDeliveryAbandoned(
              input.deliveryId,
              input.attempts,
              'The destination Lark chat belongs to a different company.',
            );
            if (!abandoned.ok) throw abandoned.error;
            this.log.error('mail_ops.delivery_cross_company_chat', {
              deliveryId: input.deliveryId,
              companyId: payload.companyId,
              chatId: chat,
            });
            return;
          }
        }
        nothingWasSent = false;
        providerMessageId = await this.deps.deliverLark({
          chatId: chat,
          idempotencyKey: payload.idempotencyKey,
          text: formatLarkDelivery(payload),
        });
      } else if (payload.action.type === 'organize') {
        const accessToken = await this.deps.resolveAccessToken({
          companyId: payload.companyId,
          userId: payload.userId,
          connectionId: payload.connectionId,
        });
        // Resolved per delivery rather than stored on the rule, because a label
        // ID is Gmail's and the member can delete the label at any time. Storing
        // one would leave the rule pointing at an ID that no longer exists, and
        // failing on it forever; resolving by name recreates it instead.
        const addLabelIds = payload.action.label
          ? [await this.deps.gmail.resolveLabelId({
              accessToken,
              name: payload.action.label,
            })]
          : [];
        // Archiving is removing INBOX, which is what archiving *is* in Gmail.
        const removeLabelIds = [
          ...(payload.action.archive ? ['INBOX'] : []),
          ...(payload.action.markRead ? ['UNREAD'] : []),
        ];
        // No `nothingWasSent = false` here, and no probe above it: modify is
        // idempotent, so a retry that repeats it changes nothing. Nothing is
        // sent by an organize rule at all — the claim stays true.
        providerMessageId = await this.deps.gmail.organizeMessage({
          accessToken,
          messageId: payload.sourceMessageId,
          addLabelIds,
          removeLabelIds,
        });
      } else {
        throw new Error('Mail delivery action and destination do not match.');
      }
      const delivered = await this.deps.repo.markDeliveryDelivered(
        input.deliveryId,
        providerMessageId,
      );
      if (!delivered.ok) throw delivered.error;
      if (tick) tick.deliveriesSent += 1;
      this.log.info('mail_ops.delivery_delivered', {
        deliveryId: input.deliveryId,
        action: payload.action.type,
        destination: payload.destination.type,
        providerMessageId,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      // Too big for Gmail is the one send failure retrying cannot fix. Left on
      // the ladder it burned five attempts and ended abandoned anyway, with
      // `lastError` reading like a transient provider fault — so the member saw
      // a rule that had worked all week stop for one message, and nothing said
      // the message was the reason. Abandoned once, in words, instead.
      if (error instanceof MailTooLargeError) {
        const abandoned = await this.deps.repo.markDeliveryAbandoned(
          input.deliveryId,
          input.attempts,
          error.message,
          // The draft is built before anything is staged, so a message refused
          // for its size never reached Gmail at all.
          { nothingWasSent: true },
        );
        if (!abandoned.ok) throw abandoned.error;
        this.log.warn('mail_ops.delivery_too_large', {
          deliveryId: input.deliveryId,
          bytes: error.bytes,
        });
        return;
      }
      const failed = await this.deps.repo.markDeliveryFailed(
        input.deliveryId,
        error,
        input.attempts,
        new Date(),
        // A throw between the probe and the send — an unreadable permission
        // store, an access token that would not resolve — is the last rung of
        // the ladder often enough to matter: five attempts is about seventy-
        // five seconds. Abandoning is terminal, so the proof has to be spent
        // here or it is lost.
        { nothingWasSent },
      );
      if (!failed.ok) throw failed.error;
      if (tick) tick.deliveriesFailed += 1;
      this.log.warn('mail_ops.delivery_failed', {
        deliveryId: input.deliveryId,
        attempts: input.attempts,
        error: errorText(error),
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

/**
 * When to look again after a budget refusal.
 *
 * Only the windows actually over their ceiling are what the delivery is
 * waiting on. A check reports every configured window, and a per-day window
 * reopens up to a day out, so taking the longest of all of them would defer by
 * a day because a per-minute ceiling was touched — the mailbox would then
 * drain at the daily cadence no matter how quickly the minute reopened. Among
 * the windows that are genuinely exhausted the longest is the right one: the
 * retry has to clear all of them to get through.
 *
 * Without any such answer — an unreadable policy store — five minutes is a
 * cadence that neither hammers the store nor leaves mail sitting for an hour.
 */
function budgetRetryDelayMs(
  check?: {
    readonly windows: ReadonlyArray<{
      readonly retryAfterSeconds: number;
      readonly used: number;
      readonly limit: number;
    }>;
  },
): number {
  const waits = (check?.windows ?? [])
    .filter(window => window.used >= window.limit)
    .map(window => window.retryAfterSeconds)
    .filter(seconds => Number.isFinite(seconds) && seconds > 0);
  if (waits.length === 0) return DEFAULT_BUDGET_RETRY_MS;
  return Math.min(Math.max(...waits) * 1_000, MAX_BUDGET_RETRY_MS);
}

function readMessageMetadata(
  value: Record<string, unknown>,
): MailMessageMetadata | null {
  if (
    typeof value['from'] !== 'string'
    || typeof value['to'] !== 'string'
    || typeof value['subject'] !== 'string'
    || typeof value['snippet'] !== 'string'
    || typeof value['hasAttachment'] !== 'boolean'
  ) return null;
  // `bodyText` is the one field that legitimately goes missing: retention
  // strips it at 30 days and leaves the event standing. Requiring it made a
  // stripped event unreadable, which quietly dropped it out of matching
  // altogether — so a rule tested against older mail matched nothing, and the
  // member was told the rule was wrong when the body was simply gone.
  return {
    ...value,
    bodyText: typeof value['bodyText'] === 'string' ? value['bodyText'] : '',
  } as MailMessageMetadata;
}

/**
 * The identifying half of a stored delivery payload.
 *
 * Every one of these ends up in a request to Google or Lark, or in a database
 * write, so an empty string is as bad as a missing key — `.min(1)` rather than
 * `z.string()`. The rest of the payload (`message`, `action`, `destination`)
 * has parsers of its own that predate this and are shared with the rule path.
 */
const deliveryPayloadSchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  departmentId: z.string().min(1).optional(),
  subscriptionId: z.string().min(1),
  connectionId: z.string().min(1),
  mailboxEmail: z.string().min(1),
  ruleId: z.string().min(1),
  eventId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

/**
 * A stored payload turned back into something the worker may act on.
 *
 * This is the boundary between JSON written by some earlier version of Divo and
 * code that sends mail on somebody's behalf, so it is validated rather than
 * asserted. It used to type-check nine keys in a loop and then
 * `as unknown as` the whole object through, which meant the fields it had just
 * proved were the only fields anybody had checked — everything else arrived
 * carrying whatever the row happened to hold, under a type that swore
 * otherwise.
 *
 * Zod also *drops* unknown keys rather than passing them along, so a field
 * removed from the payload in a later version cannot ride around inside a row
 * written before the removal.
 */
function readDeliveryPayload(
  value: Record<string, unknown>,
): PendingMailDeliveryPayload {
  const identity = deliveryPayloadSchema.safeParse(value);
  if (!identity.success) {
    throw new Error(
      `Invalid mail delivery payload: ${identity.error.errors
        .map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  const message = value['message'];
  if (!message || typeof message !== 'object') {
    throw new Error('Invalid mail delivery message.');
  }
  const parsedMessage = readMessageMetadata(message as Record<string, unknown>);
  if (!parsedMessage) throw new Error('Invalid mail delivery message metadata.');
  const action = value['action'];
  const destination = value['destination'];
  if (
    !action || typeof action !== 'object'
    || !destination || typeof destination !== 'object'
  ) {
    throw new Error('Invalid mail delivery action or destination.');
  }
  // Through the same parser the rule path uses, so a stored payload cannot
  // describe a pairing a rule could not have been created with.
  const parsedDelivery = parseMailRuleDelivery({
    action: action as Record<string, unknown>,
    destination: destination as Record<string, unknown>,
  });
  const { departmentId, ...required } = identity.data;
  return {
    ...required,
    // Spread only when present. Under `exactOptionalPropertyTypes` a key
    // holding `undefined` is not the same as an absent key, and this object is
    // handed to callers that test `payload.departmentId ? ... : {}`.
    ...(departmentId !== undefined ? { departmentId } : {}),
    message: parsedMessage,
    action: parsedDelivery.action,
    destination: parsedDelivery.destination,
  };
}

/** How much of a mail's text is worth reading in a chat before opening it. */
const LARK_PREVIEW_CHARS = 700;

/**
 * A mail, said in a chat.
 *
 * This used to paste the whole plain-text body in, up to twenty thousand
 * characters. For a real marketing mail that is unreadable: the plain-text
 * alternative of an HTML mail is the layout flattened into ragged half
 * sentences, and every link in it is a tracking URL that runs for a thousand
 * characters of encoded campaign parameters. One notification filled a chat
 * screen and said less than its own subject line did.
 *
 * So this is a notification and not a copy of the mail. The subject and the
 * sender are what a person reads to decide whether to care; a short preview
 * tells them what it is about; and the link opens the real message, with its
 * formatting, its images and its attachments, where those things work. Nothing
 * here is a summary — no model runs, no meaning is inferred — it is the mail's
 * own words, cut short.
 */
export function formatLarkDelivery(payload: PendingMailDeliveryPayload): string {
  const { message } = payload;
  const sender = formatSender(message.from);
  const lines = [
    message.subject?.trim() || '(no subject)',
    `From: ${sender}`,
  ];
  if (message.hasAttachment) lines.push('Has attachments');
  const preview = previewText(message.bodyText || message.snippet);
  if (preview) lines.push('', preview);
  // Where the mail actually is. A chat cannot render HTML, inline images or an
  // attachment, and pretending otherwise is what made the old format useless.
  //
  // Addressed by mailbox rather than by `u/0`. The index is a position in
  // whatever order that person happens to be signed into Google accounts, so
  // for anyone with more than one it opens the wrong mailbox and reports the
  // message as missing.
  lines.push(
    '',
    'Open in Gmail: https://mail.google.com/mail/u/'
      + `${encodeURIComponent(payload.mailboxEmail)}/#all/${payload.sourceMessageId}`,
  );
  return lines.join('\n');
}

/** `"Naukri" <a@b.com>` said the way a person would say it. */
function formatSender(from: string): string {
  const raw = (from ?? '').trim();
  if (!raw) return 'unknown sender';
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (!match) return raw;
  const name = (match[1] ?? '').replace(/^"|"$/g, '').trim();
  const address = (match[2] ?? '').trim();
  return name ? `${name} (${address})` : address;
}

/**
 * The readable part of a mail body.
 *
 * URLs go first and are not shortened or labelled: a tracking link is a
 * thousand characters of campaign parameters, and leaving even its host behind
 * puts a live link in a chat that nobody meant to click. Runs of blank lines
 * collapse because the plain-text twin of an HTML mail is mostly blank lines.
 */
function previewText(body: string): string {
  const cleaned = (body ?? '')
    .replace(/<?https?:\/\/[^\s>]+>?/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (cleaned.length <= LARK_PREVIEW_CHARS) return cleaned;
  return `${cleaned.slice(0, LARK_PREVIEW_CHARS).trimEnd()}…`;
}

/**
 * The reasons that genuinely mean "the member has not granted us this".
 *
 * `forbidden` is deliberately absent: Google uses it for any refusal it has no
 * better word for, and on this API that is overwhelmingly a Pub/Sub topic
 * permission Divo owns and the member cannot touch.
 */
const SCOPE_REASONS = new Set([
  'insufficientpermissions',
  'insufficientscope',
  'accesstokenscopeinsufficient',
]);

/** Google reasons that mean "too fast", not "not allowed". */
const RATE_LIMIT_REASONS = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'quotaexceeded',
  'dailylimitexceeded',
  'resourceexhausted',
]);

/**
 * Google is having a problem of its own. Nobody did anything wrong and nothing
 * needs doing.
 *
 * `backendError` used to sit in the set above, which meant a Gmail 500 told
 * the member "Google is rate-limiting this mailbox". The advice that followed
 * was right — keep waiting — but the sentence was false, and a member who
 * reads it goes looking for a quota they have not exceeded.
 */
const UNAVAILABLE_REASONS = new Set(['backenderror', 'internal', 'unavailable']);

/**
 * The same reason written every way Google writes it.
 *
 * The legacy `errors[]` channel says `insufficientPermissions`; the newer
 * `details[].ErrorInfo` channel says `ACCESS_TOKEN_SCOPE_INSUFFICIENT`; OAuth
 * says `insufficient_scope`. Folding case alone left the sets carrying two
 * spellings of one reason and still missing the third — a set entry that can
 * never match is a claim to handle something the code does not.
 */
function normalizeReason(reason: string | undefined): string {
  return (reason ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What to tell the mailbox owner went wrong.
 *
 * This is not a log label. `scope_missing` puts "Reconnect Google and allow
 * Divo to read and send mail" in front of a member, so a misclassification
 * sends somebody to reconnect a perfectly healthy account — and the previous
 * implementation decided by grepping the provider's English prose for
 * `scope`, `permission`, `token` and `rate`. Those are words Google rewrites
 * whenever it feels like it, and every unrelated error containing one of them
 * was already being filed under the wrong remedy.
 *
 * A `GmailApiError` carries the two things that are actually contractual: the
 * HTTP status, and Google's machine-readable reason. `403` alone is ambiguous
 * — it is both "insufficient permissions" and "you are going too fast" — so
 * the reason is what separates them, and only when it is absent does the
 * status decide alone.
 *
 * The substring pass survives for errors that never came from Gmail at all,
 * such as a token refresh failing inside Divo. It is a last resort now rather
 * than the first answer, and `scope` and `permission` are deliberately not in
 * it: a Divo-side error saying "permission" is our problem, not Google's.
 */
function syncFailureCode(error: unknown): string {
  if (error instanceof AuthorizationUnavailableError) {
    return 'authorization_unavailable';
  }
  if (error instanceof HistoryBacklogStalledError) {
    return 'history_backlog_stalled';
  }
  if (error instanceof GmailApiError) {
    const reason = normalizeReason(error.reason);
    if (RATE_LIMIT_REASONS.has(reason)) return 'provider_rate_limited';
    if (error.status === 429) return 'provider_rate_limited';
    if (UNAVAILABLE_REASONS.has(reason) || error.status >= 500) {
      return 'provider_unavailable';
    }
    if (error.status === 401) return 'connection_unavailable';
    // Named reasons only, never every remaining `403`. Gmail's commonest 403
    // on `users.watch` is not about the member's grant at all: it is
    // `forbidden`, "User not authorized to perform this action", raised when
    // the *Divo-owned* Pub/Sub topic is missing its publisher binding for
    // `gmail-api-push@system.gserviceaccount.com`. Filed as `scope_missing`
    // that tells every affected member to reconnect a healthy Google account,
    // which fixes nothing and hides the one thing that would — an operator
    // repairing the topic. A 403 with no reason is left unnamed for the same
    // rule the remedy table states: a wrong instruction is worse than none.
    if (error.status === 403 && SCOPE_REASONS.has(reason)) return 'scope_missing';
    return 'provider_sync_failed';
  }
  const text = errorText(error).toLowerCase();
  if (text.includes('token') || text.includes('unauthorized')) {
    return 'connection_unavailable';
  }
  return 'provider_sync_failed';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
