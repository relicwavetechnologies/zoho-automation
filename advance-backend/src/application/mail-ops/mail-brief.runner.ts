/**
 * One brief: read the window, compose it, send it, move the window forward.
 *
 * Kept apart from the worker so the order of those four steps can be read in one
 * screen, and so the two that must not be reordered are visible together: the
 * window is only advanced **after** a successful send, and a failed send leaves
 * `coveredThrough` untouched so the mail in that window is folded into the next
 * brief rather than lost.
 *
 * Every exit releases the claim. A brief that throws and holds its claim is a
 * member who silently stops being briefed until somebody notices.
 */
import type { Logger } from '../../shared/logger';
import type { ClaimedMailBrief } from '../../infrastructure/persistence/mail-ops/brief.repository';
import {
  mailBriefWindowStart,
  nextMailBriefRunAt,
  mailBriefScheduleSchema,
} from './mail-brief.schedule';
import type { MailBrief, MailBriefRuleActivity, MailBriefWindow } from './mail-brief';
import { readMessageMetadata } from './mail-ops.types';

export interface MailBriefRunnerDeps {
  repo: {
    readBriefWindow(input: {
      companyId: string;
      subscriptionId: string;
      from: Date;
      to: Date;
    }): Promise<
      | {
          ok: true;
          value: {
            messages: Array<{ metadata: Record<string, unknown>; occurredAt: Date }>;
            activity: Array<{ ruleName: string; status: string; count: number }>;
          };
        }
      | { ok: false; error: { message: string } }
    >;
    completeBrief(input: {
      briefId: string;
      coveredThrough: Date;
      nextRunAt: Date | null;
      ranAt: Date;
    }): Promise<{ ok: boolean; error?: { message: string } }>;
    releaseBrief(input: {
      briefId: string;
      nextRunAt: Date | null;
    }): Promise<{ ok: boolean; error?: { message: string } }>;
  };
  compose(window: MailBriefWindow): Promise<MailBrief>;
  /** The same Lark DM path a `lark_dm` mail rule already delivers on. */
  deliverLarkDm(input: {
    openId: string;
    idempotencyKey: string;
    text: string;
  }): Promise<string>;
  resolveLarkOpenId(input: {
    userId: string;
    companyId: string;
  }): Promise<string | null>;
  logger: Logger;
  now?: () => Date;
}

/**
 * Rolls a status count into the four words a member reads.
 *
 * `held` is its own column rather than folded into failures, because on a rule
 * with an AI step it is the commonest outcome and reporting it as a failure
 * would make a working rule read as a broken one twice a day, forever.
 */
function foldActivity(
  rows: Array<{ ruleName: string; status: string; count: number }>,
): MailBriefRuleActivity[] {
  const byRule = new Map<string, MailBriefRuleActivity>();
  for (const row of rows) {
    const entry = byRule.get(row.ruleName) ?? {
      ruleName: row.ruleName, delivered: 0, held: 0, blocked: 0, failed: 0,
    };
    if (row.status === 'delivered') entry.delivered += row.count;
    else if (row.status === 'held') entry.held += row.count;
    else if (row.status === 'blocked') entry.blocked += row.count;
    else if (row.status === 'abandoned') entry.failed += row.count;
    // `pending` and `sending` are deliberately dropped. They are mid-flight and
    // will be reported by whichever brief covers the window they settle in;
    // counting them here would report the same message twice.
    byRule.set(row.ruleName, entry);
  }
  return [...byRule.values()];
}

export function createMailBriefRunner(deps: MailBriefRunnerDeps) {
  const log = deps.logger.child({ service: 'mail-brief' });
  const now = () => deps.now?.() ?? new Date();

  /** The next slot after this one, or `null` if the schedule no longer parses. */
  const nextSlot = (claim: ClaimedMailBrief, after: Date): Date | null => {
    const schedule = mailBriefScheduleSchema.safeParse({
      times: claim.times, days: claim.days, timeZone: claim.timeZone,
    });
    if (!schedule.success) {
      // Left with no next run rather than defaulted to something. A stored
      // schedule that no longer parses is a rule nobody can predict, and
      // guessing one would deliver at an hour the member never chose.
      log.error('mail_brief.schedule_unreadable', {
        briefId: claim.briefId,
        reason: schedule.error.issues[0]?.message,
      });
      return null;
    }
    return nextMailBriefRunAt(schedule.data, after);
  };

  return async function runMailBrief(claim: ClaimedMailBrief): Promise<void> {
    const ranAt = now();
    const after = nextSlot(claim, ranAt);

    try {
      const openId = await deps.resolveLarkOpenId({
        userId: claim.userId,
        companyId: claim.companyId,
      });
      if (!openId) {
        // Not a failure to retry. Divo has nowhere to send this and will not
        // until the member links Lark, so the window moves on rather than
        // accumulating a month of mail against the day they do.
        log.info('mail_brief.no_lark_identity', {
          briefId: claim.briefId, userId: claim.userId,
        });
        const skipped = await deps.repo.completeBrief({
          briefId: claim.briefId,
          coveredThrough: claim.scheduledFor,
          nextRunAt: after,
          ranAt,
        });
        if (!skipped.ok) log.error('mail_brief.skip_not_recorded', { briefId: claim.briefId });
        return;
      }

      const from = mailBriefWindowStart(claim.coveredThrough, ranAt);
      const read = await deps.repo.readBriefWindow({
        companyId: claim.companyId,
        subscriptionId: claim.subscriptionId,
        from,
        to: ranAt,
      });
      if (!read.ok) throw new Error(read.error.message);

      const messages = read.value.messages.flatMap(row => {
        const message = readMessageMetadata(row.metadata);
        if (!message) return [];
        return [{
          from: message.from,
          subject: message.subject,
          snippet: message.snippet,
          occurredAt: row.occurredAt,
        }];
      });

      const brief = await deps.compose({
        mailboxEmail: claim.mailboxEmail,
        from,
        to: ranAt,
        timeZone: claim.timeZone,
        messages,
        handled: foldActivity(read.value.activity),
      });

      /*
       * Sent even when there is nothing to report.
       *
       * A brief that only appears on busy days is one nobody can rely on: its
       * absence would mean either "a quiet morning" or "Divo is broken", and
       * those need opposite responses. A one-line "nothing is waiting on you" is
       * the whole value of a standing report.
       */
      await deps.deliverLarkDm({
        openId,
        // Keyed on the slot rather than on the send, so a worker that crashes
        // after Lark accepted the card cannot deliver the same brief twice.
        // Lark caps this at 50 characters — see the adapter.
        idempotencyKey: `brief-${claim.briefId.slice(0, 8)}-${claim.scheduledFor.getTime()}`,
        text: brief.text,
      });

      const done = await deps.repo.completeBrief({
        briefId: claim.briefId,
        // The instant the brief actually covered up to, not `now` at the end of
        // the send: mail that arrived while the card was in flight belongs to
        // the next brief, not to neither.
        coveredThrough: ranAt,
        nextRunAt: after,
        ranAt,
      });
      if (!done.ok) throw new Error(done.error?.message ?? 'The brief could not be recorded.');

      log.info('mail_brief.delivered', {
        briefId: claim.briefId,
        wants: brief.wantCount,
        degraded: brief.degraded,
        nextRunAt: after?.toISOString() ?? null,
      });
    } catch (error) {
      log.error('mail_brief.failed', {
        briefId: claim.briefId,
        error: error instanceof Error ? error.message : String(error),
      });
      // `coveredThrough` untouched on purpose: this window folds into the next
      // brief. A member who was owed a summary at 09:00 and did not get one
      // should read about that mail at 16:00, not never.
      const released = await deps.repo.releaseBrief({
        briefId: claim.briefId,
        nextRunAt: after,
      });
      if (!released.ok) {
        log.error('mail_brief.claim_not_released', { briefId: claim.briefId });
      }
    }
  };
}
