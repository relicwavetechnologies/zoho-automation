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

type MailRepo = Pick<
  MailOpsRepository,
  | 'claimNextDueMailbox'
  | 'recordEvents'
  | 'advanceCursor'
  | 'markSyncFailed'
  | 'listActiveRules'
  | 'reserveDelivery'
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
  private readonly log: Logger;

  constructor(private readonly deps: {
    repo: MailRepo;
    gmail: Pick<GmailHistoryClient, 'sync' | 'forward' | 'watch'>;
    resolveAccessToken(input: {
      companyId: string;
      userId: string;
      connectionId: string;
    }): Promise<string>;
    authorizeRule(input: {
      companyId: string;
      userId: string;
      connectionId: string;
      departmentId?: string;
    }): Promise<boolean>;
    deliverLark(input: {
      chatId: string;
      text: string;
      idempotencyKey: string;
    }): Promise<string>;
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.deps.pubsubTopicName) {
        for (let count = 0; count < MAILBOX_BATCH_SIZE; count++) {
          const claimed = await this.deps.repo.claimNextWatchRenewal();
          if (!claimed.ok) throw claimed.error;
          if (!claimed.value) break;
          await this.renewWatch(claimed.value);
        }
      }
      for (let count = 0; count < MAILBOX_BATCH_SIZE; count++) {
        const claimed = await this.deps.repo.claimNextDueMailbox(
          new Date(),
          Boolean(this.deps.pubsubTopicName),
        );
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
          const authorized = await this.deps.authorizeRule({
            companyId: claim.companyId,
            userId: claim.userId,
            connectionId: claim.connectionId,
            ...(rawRule.departmentId
              ? { departmentId: rawRule.departmentId }
              : {}),
          });
          if (!authorized) {
            this.log.warn('mail_ops.rule_permission_denied', {
              ruleId: rawRule.ruleId,
            });
            continue;
          }
          let rule;
          try {
            rule = parseMailRule(rawRule);
          } catch (error) {
            this.log.warn('mail_ops.rule_skipped', {
              ruleId: rawRule.ruleId,
              error: errorText(error),
            });
            continue;
          }
          if (!mailRuleMatches(rule.match, message)) continue;
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
  }

  private async deliver(input: {
    deliveryId: string;
    attempts: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      const payload = readDeliveryPayload(input.payload);
      const authorized = await this.deps.authorizeRule({
        companyId: payload.companyId,
        userId: payload.userId,
        connectionId: payload.connectionId,
        ...(payload.departmentId
          ? { departmentId: payload.departmentId }
          : {}),
      });
      if (!authorized) {
        const abandoned = await this.deps.repo.markDeliveryAbandoned(
          input.deliveryId,
          input.attempts,
          'Mail automation execute access or Google connection was revoked.',
        );
        if (!abandoned.ok) throw abandoned.error;
        this.log.warn('mail_ops.delivery_permission_revoked', {
          deliveryId: input.deliveryId,
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
