/**
 * Tells a member, once, when their mail rules have stopped working.
 *
 * Before this, a mailbox could fail permanently and the only trace was a log
 * line. The owner's first signal was noticing that expected mail never arrived
 * — which for something like forwarded login codes can take weeks.
 *
 * Deliberately quiet. It alerts on the transition into a broken state and then
 * stays silent while the state persists, because a mailbox can be broken for a
 * fortnight and an alert that repeats is one a person learns to ignore. It also
 * never announces recovery: a rule that starts working again announces itself
 * by working.
 */
import type { Logger } from '../../shared/logger';
import type { Result } from '../../shared/result';
import type { ChannelError } from '../../shared/errors';
import type { MailOpsReadRepository } from '../../infrastructure/persistence/mail-ops-read.repository';
import type { MailOpsRepository } from '../../infrastructure/persistence/mail-ops.repository';
import {
  assessMailbox,
  shouldNotifyMailbox,
  type MailboxHealth,
  type MailboxState,
} from './mail-ops-health';

export interface MailOpsNotifierDeps {
  readRepo: Pick<MailOpsReadRepository, 'getMailboxHealth'>;
  repo: Pick<MailOpsRepository, 'recordNotifiedMailboxState'>;
  /** Resolves the owner's Lark open ID, or null when they have no Lark identity. */
  resolveLarkOpenId(input: {
    userId: string;
    companyId: string;
  }): Promise<string | null>;
  sendDirectCard(
    openId: string,
    card: string,
  ): Promise<Result<{ messageId: string }, ChannelError>>;
  logger: Logger;
}

export class MailOpsMailboxNotifier {
  private readonly log: Logger;

  constructor(private readonly deps: MailOpsNotifierDeps) {
    this.log = deps.logger.child({ service: 'mail-ops-notifier' });
  }

  /**
   * Re-reads one mailbox and alerts its owner if it has just become unable to
   * run rules. Safe to call after every sync and watch outcome — the common
   * case is a healthy mailbox, which costs one indexed read and sends nothing.
   *
   * Never throws: a notification failure must not fail the mailbox operation
   * that triggered it.
   */
  async review(subscriptionId: string): Promise<{ notified: boolean }> {
    try {
      const record = await this.deps.readRepo.getMailboxHealth(subscriptionId);
      if (!record.ok) throw record.error;
      if (!record.value) return { notified: false };

      const health = assessMailbox(record.value);
      const previous = readState(record.value.notifiedState);
      if (!shouldNotifyMailbox(previous, health.state)) {
        // Persist a recovery so the next break alerts again, without sending.
        if (previous !== health.state) {
          await this.remember(subscriptionId, health.state);
        }
        return { notified: false };
      }

      const openId = await this.deps.resolveLarkOpenId({
        userId: record.value.userId,
        companyId: record.value.companyId,
      });
      if (!openId) {
        // No Lark identity means no channel to reach them on yet. Record the
        // state anyway so we do not re-attempt on every pass.
        await this.remember(subscriptionId, health.state);
        this.log.warn('mail_ops.notify_no_channel', {
          subscriptionId,
          state: health.state,
        });
        return { notified: false };
      }

      const sent = await this.deps.sendDirectCard(
        openId,
        buildMailboxAlertCard(health),
      );
      if (!sent.ok) {
        // Left unrecorded on purpose, so the next pass retries. A duplicate
        // alert is a smaller failure than never warning them at all.
        this.log.warn('mail_ops.notify_send_failed', {
          subscriptionId,
          state: health.state,
          reason: sent.error.message,
        });
        return { notified: false };
      }

      await this.remember(subscriptionId, health.state);
      this.log.info('mail_ops.notified', {
        subscriptionId,
        state: health.state,
        previousState: previous,
        messageId: sent.value.messageId,
      });
      return { notified: true };
    } catch (error) {
      this.log.warn('mail_ops.notify_failed', {
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { notified: false };
    }
  }

  private async remember(
    subscriptionId: string,
    state: MailboxState,
  ): Promise<void> {
    const recorded = await this.deps.repo.recordNotifiedMailboxState(
      subscriptionId,
      state,
    );
    if (!recorded.ok) {
      this.log.warn('mail_ops.notify_state_not_recorded', {
        subscriptionId,
        state,
        error: recorded.error.message,
      });
    }
  }
}

/** Unknown persisted values degrade to "never notified" rather than throwing. */
function readState(value: string | null): MailboxState | null {
  const states: MailboxState[] = [
    'never_started',
    'sync_failing',
    'watch_degraded',
    'watch_delayed',
    'paused',
    'healthy',
  ];
  return states.find(state => state === value) ?? null;
}

export function buildMailboxAlertCard(health: MailboxHealth): string {
  const lines = [health.summary];
  if (health.remedy) lines.push('', health.remedy);
  lines.push(
    '',
    health.activeRuleCount === 1
      ? '**1 mail rule** is affected.'
      : `**${health.activeRuleCount} mail rules** are affected.`,
  );
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      // A degraded watch still delivers, just late, and this card is now sent
      // for that too — a fixed "have stopped" would contradict the body text
      // sitting directly underneath it.
      template: health.rulesCanFire ? 'orange' : 'red',
      title: {
        tag: 'plain_text',
        content: health.rulesCanFire
          ? 'Your mail rules are running late'
          : 'Your mail rules have stopped',
      },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    ],
  });
}
