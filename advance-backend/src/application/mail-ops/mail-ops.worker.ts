import type { Logger } from '../../shared/logger';
import type { MailOpsRepository } from '../../infrastructure/persistence/mail-ops.repository';
import type { MailboxSyncClaim } from '../../infrastructure/persistence/mail-ops.repository';
import type { GmailHistoryClient } from '../../infrastructure/google/gmail-history.client';
import {
  mailDeliveryIdempotencyKey,
  type MailMessageMetadata,
  type PendingMailDeliveryPayload,
} from './mail-ops.types';
import {
  mailRuleMatches,
  parseMailRule,
  parseMailRuleDelivery,
} from './mail-rule.matcher';

const MAILBOX_BATCH_SIZE = 20;
const DELIVERY_BATCH_SIZE = 50;

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

type MailRepo = Pick<
  MailOpsRepository,
  | 'claimNextDueMailbox'
  | 'recordEvents'
  | 'advanceCursor'
  | 'markSyncFailed'
  | 'listActiveRules'
  | 'reserveDelivery'
  | 'recordBlockedDelivery'
  | 'claimNextDueDelivery'
  | 'markDeliveryDelivered'
  | 'markDeliveryFailed'
  | 'markDeliveryAbandoned'
  | 'claimNextWatchRenewal'
  | 'completeWatchRenewal'
  | 'failWatchRenewal'
>;

export class MailOpsWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private rerunRequested = false;
  private readonly log: Logger;

  constructor(private readonly deps: {
    repo: MailRepo;
    gmail: Pick<GmailHistoryClient, 'sync' | 'forward' | 'watch'>;
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
     * Tells the mailbox owner, once, when their rules have stopped running.
     * Optional so the worker still runs headless in tests and in environments
     * with no outbound channel configured.
     */
    reviewMailboxHealth?(subscriptionId: string): Promise<unknown>;
    logger: Logger;
    pubsubTopicName?: string;
    scanIntervalMs?: number;
  }) {
    this.log = deps.logger.child({ service: 'mail-ops-worker' });
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
    try {
      do {
        this.rerunRequested = false;
        if (this.deps.pubsubTopicName) {
          for (let count = 0; count < MAILBOX_BATCH_SIZE; count++) {
            const claimed = await this.deps.repo.claimNextWatchRenewal();
            if (!claimed.ok) throw claimed.error;
            if (!claimed.value) break;
            await this.renewWatch(claimed.value);
          }
        }
        for (let count = 0; count < MAILBOX_BATCH_SIZE; count++) {
          // Unconditional, whether or not Pub/Sub is configured and whether or
          // not this mailbox's watch ever registered. Reconciliation is the
          // safety net for a missing watch; gating it on the watch removed the
          // net exactly when it was needed.
          const claimed = await this.deps.repo.claimNextDueMailbox();
          if (!claimed.ok) throw claimed.error;
          if (!claimed.value) break;
          await this.syncMailbox(claimed.value);
        }
        for (let count = 0; count < DELIVERY_BATCH_SIZE; count++) {
          const claimed = await this.deps.repo.claimNextDueDelivery();
          if (!claimed.ok) throw claimed.error;
          if (!claimed.value) break;
          await this.deliver(claimed.value);
        }
      } while (this.rerunRequested);
    } finally {
      this.running = false;
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
      for (const event of persisted.value) {
        const message = readMessageMetadata(event.metadata);
        if (!message) {
          this.log.warn('mail_ops.event_metadata_invalid', {
            subscriptionId: claim.subscriptionId,
            eventId: event.eventId,
          });
          continue;
        }
        for (const rawRule of rules.value) {
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
          if (!mailRuleMatches(rule.match, message)) continue;

          const authorized = await authorizationFor(rawRule);
          if (authorized.verdict === 'unavailable') {
            // Not an answer. Fail the sync so the cursor holds and the same
            // range is retried, rather than recording a refusal we cannot
            // stand behind.
            throw new Error(
              `Mail rule authorization is unavailable: ${authorized.reason}`,
            );
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
      const advanced = await this.deps.repo.advanceCursor(
        claim,
        sync.nextHistoryId,
        new Date(),
        // A partial drain is a success with work left over, so it comes back
        // on the next tick instead of waiting out the reconciliation interval.
        { pollImmediately: sync.truncated },
      );
      if (!advanced.ok) throw advanced.error;
      if (!advanced.value) {
        throw new Error('Mailbox sync claim was lost before cursor advancement.');
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
      this.log.warn('mail_ops.mailbox_sync_failed', {
        subscriptionId: claim.subscriptionId,
        error: errorText(error),
      });
    }
    await this.reviewHealth(claim.subscriptionId);
  }

  private async deliver(input: {
    deliveryId: string;
    attempts: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const startedAt = Date.now();
    try {
      const payload = readDeliveryPayload(input.payload);
      this.log.info('mail_ops.delivery_attempt_started', {
        deliveryId: input.deliveryId,
        attempts: input.attempts,
        action: payload.action.type,
        destination: payload.destination.type,
      });
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
        throw new Error(
          `Mail rule authorization is unavailable: ${authorized.reason}`,
        );
      }
      if (authorized.verdict === 'denied') {
        const abandoned = await this.deps.repo.markDeliveryAbandoned(
          input.deliveryId,
          input.attempts,
          authorized.reason,
        );
        if (!abandoned.ok) throw abandoned.error;
        this.log.warn('mail_ops.delivery_permission_revoked', {
          deliveryId: input.deliveryId,
          reason: authorized.reason,
        });
        return;
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
        providerMessageId = await this.deps.gmail.forward({
          accessToken,
          destination: payload.destination.email,
          mailboxEmail: payload.mailboxEmail,
          sourceMessageId: payload.sourceMessageId,
          source: payload.message,
          idempotencyKey: payload.idempotencyKey,
        });
      } else if (
        payload.action.type === 'deliver'
        && payload.destination.type === 'lark_chat'
      ) {
        providerMessageId = await this.deps.deliverLark({
          chatId: payload.destination.chatId,
          idempotencyKey: payload.idempotencyKey,
          text: formatLarkDelivery(payload),
        });
      } else {
        throw new Error('Mail delivery action and destination do not match.');
      }
      const delivered = await this.deps.repo.markDeliveryDelivered(
        input.deliveryId,
        providerMessageId,
      );
      if (!delivered.ok) throw delivered.error;
      this.log.info('mail_ops.delivery_delivered', {
        deliveryId: input.deliveryId,
        action: payload.action.type,
        destination: payload.destination.type,
        providerMessageId,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failed = await this.deps.repo.markDeliveryFailed(
        input.deliveryId,
        error,
        input.attempts,
      );
      if (!failed.ok) throw failed.error;
      this.log.warn('mail_ops.delivery_failed', {
        deliveryId: input.deliveryId,
        attempts: input.attempts,
        error: errorText(error),
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

function readMessageMetadata(
  value: Record<string, unknown>,
): MailMessageMetadata | null {
  if (
    typeof value['from'] !== 'string'
    || typeof value['to'] !== 'string'
    || typeof value['subject'] !== 'string'
    || typeof value['snippet'] !== 'string'
    || typeof value['bodyText'] !== 'string'
    || typeof value['hasAttachment'] !== 'boolean'
  ) return null;
  return value as MailMessageMetadata;
}

function readDeliveryPayload(
  value: Record<string, unknown>,
): PendingMailDeliveryPayload {
  const message = value['message'];
  const action = value['action'];
  const destination = value['destination'];
  for (const key of [
    'companyId',
    'userId',
    'subscriptionId',
    'connectionId',
    'mailboxEmail',
    'ruleId',
    'eventId',
    'sourceMessageId',
    'idempotencyKey',
  ]) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`Invalid mail delivery payload field: ${key}`);
    }
  }
  if (!message || typeof message !== 'object') {
    throw new Error('Invalid mail delivery message.');
  }
  if (
    value['departmentId'] !== undefined
    && typeof value['departmentId'] !== 'string'
  ) {
    throw new Error('Invalid mail delivery department.');
  }
  const parsedMessage = readMessageMetadata(message as Record<string, unknown>);
  if (!parsedMessage) throw new Error('Invalid mail delivery message metadata.');
  if (!action || typeof action !== 'object' || !destination || typeof destination !== 'object') {
    throw new Error('Invalid mail delivery action or destination.');
  }
  const parsedDelivery = parseMailRuleDelivery({
    action: action as Record<string, unknown>,
    destination: destination as Record<string, unknown>,
  });
  return {
    ...(value as unknown as Omit<PendingMailDeliveryPayload, 'message' | 'action' | 'destination'>),
    message: parsedMessage,
    action: parsedDelivery.action,
    destination: parsedDelivery.destination,
  };
}

function formatLarkDelivery(payload: PendingMailDeliveryPayload): string {
  return [
    `New mail from ${payload.message.from || 'unknown sender'}`,
    `Subject: ${payload.message.subject || '(no subject)'}`,
    '',
    payload.message.bodyText || payload.message.snippet,
  ].join('\n').slice(0, 20_000);
}

function syncFailureCode(error: unknown): string {
  const text = errorText(error).toLocaleLowerCase();
  if (text.includes('scope') || text.includes('permission')) return 'scope_missing';
  if (text.includes('token') || text.includes('unauthorized')) return 'connection_unavailable';
  if (text.includes('rate') || text.includes('429')) return 'provider_rate_limited';
  return 'provider_sync_failed';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
