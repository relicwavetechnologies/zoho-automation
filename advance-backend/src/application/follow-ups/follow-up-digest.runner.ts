import { randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import type { AuditService } from '../observability/audit.service';
import {
  nextRecurringRunAt,
  recurringScheduleSchema,
  windowStartFrom,
} from '../scheduling/recurring-schedule';
import {
  larkChatDeliveryAllowed,
  type AuthorizeLarkChatDestination,
} from '../mail-ops/lark-chat-destination';
import type {
  ClaimedDigest,
  FollowUpsRepoPort,
} from '../../infrastructure/persistence/follow-ups.repository';
import {
  composeHealthCard,
  composeNumberCard,
  type DigestCard,
  type NumberDigest,
} from './follow-up-digest';

/**
 * One digest: read the window, compose the cards, send them, move the window on.
 *
 * Kept apart from the worker so the order of those four steps reads in one
 * screen, and so the two that must not be reordered are visible together: the
 * window advances **only** after a successful send, and a failed send leaves
 * `coveredThrough` untouched so whatever it would have reported folds into the
 * next digest rather than being lost.
 *
 * Every exit releases the claim. A digest that throws while holding one is a
 * group that silently stops being told anything until somebody notices.
 *
 * No model runs here. Every line on every card is a row we already hold.
 */

/** How far back a digest reaches when it has never run. */
const COLD_START_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * The most a missed run can widen the next one.
 *
 * Bounded for the same reason a brief is: a group that has not been sent to
 * since last month should get today and a fresh start, not a month of backlog.
 * It matters less here than for mail, because open follow-ups are reported in
 * full every time regardless of window — but the dark-number half does read the
 * window, and an unbounded one would make that half meaningless.
 */
const MAX_WINDOW_MS = 3 * 24 * 60 * 60_000;

export interface DigestRunnerDeps {
  readonly repo: FollowUpsRepoPort;
  /** Posts one card into the Lark room. Throws on failure. */
  readonly deliver: (input: {
    chatId: string;
    text: string;
    idempotencyKey: string;
  }) => Promise<string>;
  /**
   * The same guard Mail Ops uses. A room this company has never been in is
   * refused rather than guessed at — and a room belonging to another company on
   * the same Lark install is refused permanently.
   */
  readonly authorizeLarkChat?: AuthorizeLarkChatDestination;
  /**
   * Where the card's "open this number" link points, when one is configured.
   *
   * Optional so a deployment without a public app URL sends cards without a
   * link rather than cards linking to nowhere.
   */
  readonly appBaseUrl?: string;
  readonly auditService: AuditService;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function createFollowUpDigestRunner(deps: DigestRunnerDeps) {
  const log = deps.logger.child({ service: 'follow-up-digest' });
  const now = deps.now ?? (() => new Date());

  const nextSlot = (claim: ClaimedDigest, after: Date): Date | null => {
    const schedule = recurringScheduleSchema.safeParse({
      times: claim.timesJson,
      days: claim.daysJson,
      timeZone: claim.timeZone,
    });
    if (!schedule.success) {
      // Reported, not defaulted. A digest with an unreadable schedule stops
      // rather than firing at a time nobody chose, and the reason names itself.
      log.error('follow_up_digest.unreadable_schedule', {
        digestId: claim.digestId,
        reason: schedule.error.issues[0]?.message,
      });
      return null;
    }
    return nextRecurringRunAt(schedule.data, after);
  };

  return async function runFollowUpDigest(claim: ClaimedDigest): Promise<void> {
    const ranAt = now();
    const after = nextSlot(claim, ranAt);

    try {
      if (deps.authorizeLarkChat) {
        const verdict = await deps.authorizeLarkChat({
          companyId: claim.companyId,
          chatId: claim.larkChatId,
        });
        if (!larkChatDeliveryAllowed(verdict)) {
          // Never going to become right, so retrying only means this
          // department's follow-ups knock on another company's door twice a day.
          log.error('follow_up_digest.cross_company_chat', {
            digestId: claim.digestId,
            companyId: claim.companyId,
            chatId: claim.larkChatId,
          });
          await deps.repo.releaseDigest({
            digestId: claim.digestId,
            claimToken: claim.claimToken,
            nextRunAt: null,
          });
          return;
        }
        if (verdict.status === 'unknown_chat') {
          // Ordinary and fixable: Divo has simply never been in that room. Add
          // it to the group and the record appears. The digest keeps its
          // schedule so it starts working the moment somebody does.
          log.warn('follow_up_digest.unknown_chat', {
            digestId: claim.digestId, chatId: claim.larkChatId,
          });
          await deps.repo.releaseDigest({
            digestId: claim.digestId, claimToken: claim.claimToken, nextRunAt: after,
          });
          return;
        }
      }

      const from = windowStartFrom(claim.coveredThrough, ranAt, {
        maxWindowMs: MAX_WINDOW_MS,
        coldStartLookbackMs: COLD_START_LOOKBACK_MS,
      });

      const read = await deps.repo.readDigestWindow({
        companyId: claim.companyId,
        departmentId: claim.departmentId,
        from,
        to: ranAt,
      });
      if (!read.ok) throw new Error(read.error.message);

      // Pooled for the data, split for delivery: a follow-up belongs to Urban
      // Aura, but the card that carries it names the handset whose chat it came
      // from, so the group can see which line should pick it up.
      const byNumber = new Map<string, NumberDigest>();
      for (const item of read.value.items) {
        if (!item.sessionId) continue;
        const existing = byNumber.get(item.sessionId);
        const entry: NumberDigest = existing ?? {
          sessionId: item.sessionId,
          label: item.sessionLabel,
          items: [],
          withheld: 0,
        };
        byNumber.set(item.sessionId, {
          ...entry,
          items: [...entry.items, {
            id: item.id,
            title: item.title,
            owner: item.owner,
            counterparty: item.counterparty,
            chatName: item.chatName,
            dueDate: item.dueDate,
            urgency: item.urgency,
          }],
        });
      }

      const cards: DigestCard[] = [];
      for (const digest of byNumber.values()) {
        const card = composeNumberCard(digest, claim.timeZone, ranAt, deps.appBaseUrl);
        if (card) cards.push(card);
      }
      // Last, so it is the message the group is left looking at.
      const health = composeHealthCard(read.value.dark, claim.timeZone, deps.appBaseUrl);
      if (health) cards.push(health);

      if (cards.length === 0) {
        // Nothing outstanding anywhere and every number reporting. Sending
        // "all clear" twice a day from ten handsets is how a group learns to
        // ignore the channel. The window still advances — the run happened.
        log.info('follow_up_digest.nothing_to_say', { digestId: claim.digestId });
        const done = await deps.repo.completeDigest({
          digestId: claim.digestId,
          claimToken: claim.claimToken,
          coveredThrough: ranAt,
          nextRunAt: after,
          ranAt,
          cards: [],
        });
        if (!done.ok) throw new Error(done.error.message);
        return;
      }

      const sent: { sessionId: string; itemCount: number; cardText: string }[] = [];
      for (const card of cards) {
        // Keyed by digest, slot and card so a retry of the same slot cannot
        // post the same card twice into the group.
        const idempotencyKey = `followup-digest:${claim.digestId}:${claim.scheduledFor.toISOString()}:${card.sessionId ?? 'health'}`;
        await deps.deliver({
          chatId: claim.larkChatId,
          text: card.card,
          idempotencyKey,
        });
        if (card.sessionId) {
          sent.push({
            sessionId: card.sessionId,
            itemCount: card.itemCount,
            cardText: card.markdown,
          });
        }
      }

      // Only now. Everything above could fail and be worth repeating.
      const completed = await deps.repo.completeDigest({
        digestId: claim.digestId,
        claimToken: claim.claimToken,
        coveredThrough: ranAt,
        nextRunAt: after,
        ranAt,
        cards: sent,
      });
      if (!completed.ok) throw new Error(completed.error.message);

      log.info('follow_up_digest.sent', {
        digestId: claim.digestId,
        cards: cards.length,
        items: read.value.items.length,
        darkNumbers: read.value.dark.length,
      });

      deps.auditService.record({
        actorId: 'system',
        companyId: claim.companyId,
        action: 'followups.digest.delivered',
        outcome: 'success',
        metadata: {
          digestId: claim.digestId,
          departmentId: claim.departmentId,
          cards: cards.length,
          items: read.value.items.length,
          darkNumbers: read.value.dark.length,
        },
      });
    } catch (error) {
      log.error('follow_up_digest.failed', {
        digestId: claim.digestId,
        error: error instanceof Error ? error.message : String(error),
      });

      deps.auditService.record({
        actorId: 'system',
        companyId: claim.companyId,
        action: 'followups.digest.delivered',
        outcome: 'failure',
        metadata: {
          digestId: claim.digestId,
          departmentId: claim.departmentId,
          // The reason, not just the fact. `log.error` above carries it too, but
          // that line rolls off with the container's log cap; this row is the
          // copy that survives long enough to answer "why did the group go quiet
          // last Tuesday".
          error: error instanceof Error ? error.message : String(error),
        },
      });
      // `coveredThrough` untouched on purpose: this window folds into the next
      // digest rather than being dropped.
      const released = await deps.repo.releaseDigest({
        digestId: claim.digestId,
        claimToken: claim.claimToken,
        nextRunAt: after,
      });
      if (!released.ok) {
        // The claim is now stuck until the stale-claim reaper takes it, so say
        // so rather than letting a group silently stop being told anything.
        log.error('follow_up_digest.claim_not_released', {
          digestId: claim.digestId, error: released.error.message,
        });
      }
    }
  };
}

/** A token identifying this worker's claim, for the length of one sweep. */
export const newDigestClaimToken = (): string => randomUUID();
