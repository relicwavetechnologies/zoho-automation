/**
 * The brief's own scheduling rows.
 *
 * Claimed the way every other piece of Mail Ops work is claimed: a
 * compare-and-swap that one replica wins, with a staleness window so a worker
 * that dies mid-run does not strand its row forever. There is no new idea here
 * on purpose — the mailbox claim next door has already had its races found.
 */
import { Prisma, type PrismaClient } from '../../../generated/prisma';
import { err, ok, type Result } from '../../../shared/result';
import { wrapInfra, type InfraError } from '../../../shared/errors';

type BriefDb = Pick<PrismaClient, 'mailBrief' | 'mailEvent' | 'mailDelivery'>;

/**
 * How long a claim may sit before another replica may take it.
 *
 * Well past the longest a brief can legitimately take — one database read and
 * one model call bounded at thirty seconds — because reclaiming a run that is
 * still in flight sends the member the same brief twice.
 */
const BRIEF_CLAIM_STALE_AFTER_MS = 10 * 60_000;

export interface ClaimedMailBrief {
  briefId: string;
  companyId: string;
  userId: string;
  subscriptionId: string;
  mailboxEmail: string;
  /**
   * Whether Divo is still watching the mailbox this brief reports on.
   *
   * Carried on the claim rather than looked up later because it changes what
   * the brief is allowed to say. A paused mailbox syncs nothing, so its window
   * is empty for a reason that has nothing to do with a quiet inbox — and
   * "no mail arrived" about a mailbox nobody is reading is a false all-clear.
   */
  mailboxActive: boolean;
  times: string[];
  days: string[];
  timeZone: string;
  coveredThrough: Date | null;
  scheduledFor: Date;
}

export class MailBriefRepository {
  constructor(private readonly db: BriefDb) {}

  /**
   * One brief per mailbox per member.
   *
   * An upsert rather than a create, because this is called when a member
   * connects Google and connecting twice is ordinary. Re-connecting must not
   * reset a schedule somebody has since changed — so the update branch writes
   * nothing but the mailbox link, and a member who paused their brief stays
   * paused.
   */
  async ensureBrief(input: {
    companyId: string;
    userId: string;
    subscriptionId: string;
    times: string[];
    days: string[];
    timeZone: string;
    nextRunAt: Date;
  }): Promise<Result<{ briefId: string; created: boolean }, InfraError>> {
    try {
      const existing = await this.db.mailBrief.findUnique({
        where: {
          userId_subscriptionId: {
            userId: input.userId,
            subscriptionId: input.subscriptionId,
          },
        },
        select: { id: true },
      });
      if (existing) return ok({ briefId: existing.id, created: false });

      const created = await this.db.mailBrief.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          subscriptionId: input.subscriptionId,
          timesJson: input.times as Prisma.InputJsonValue,
          daysJson: input.days as Prisma.InputJsonValue,
          timeZone: input.timeZone,
          nextRunAt: input.nextRunAt,
        },
        select: { id: true },
      });
      return ok({ briefId: created.id, created: true });
    } catch (cause) {
      // Two connects racing. The loser reads the winner's row rather than
      // reporting a failure for a brief that now exists.
      if ((cause as { code?: string }).code === 'P2002') {
        const won = await this.db.mailBrief.findUnique({
          where: {
            userId_subscriptionId: {
              userId: input.userId,
              subscriptionId: input.subscriptionId,
            },
          },
          select: { id: true },
        });
        if (won) return ok({ briefId: won.id, created: false });
      }
      return err(wrapInfra('prisma', 'mailBrief.ensureBrief', cause));
    }
  }

  /**
   * Make an existing active brief due immediately without disturbing schedules.
   *
   * `ensureBrief` deliberately preserves existing rows; reconnecting Google
   * must not rewrite the member's 09:00/16:00 preference. Onboarding is the one
   * place that needs a separate kick, so it moves only the next due instant and
   * only when the row is idle and not already due.
   */
  async scheduleBriefNow(input: {
    briefId: string;
    now: Date;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailBrief.updateMany({
        where: {
          id: input.briefId,
          status: 'active',
          claimedAt: null,
          OR: [
            { nextRunAt: null },
            { nextRunAt: { gt: input.now } },
          ],
        },
        data: { nextRunAt: input.now },
      });
      return ok(updated.count > 0);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailBrief.scheduleBriefNow', cause));
    }
  }

  /** This member's brief for a mailbox, or `null` if they have none yet. */
  async readBriefForUser(input: {
    companyId: string;
    userId: string;
  }): Promise<Result<{
    briefId: string;
    mailboxEmail: string;
    times: string[];
    days: string[];
    timeZone: string;
    status: string;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
  } | null, InfraError>> {
    try {
      const row = await this.db.mailBrief.findFirst({
        where: { companyId: input.companyId, userId: input.userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, timesJson: true, daysJson: true, timeZone: true,
          status: true, nextRunAt: true, lastRunAt: true,
          subscription: { select: { mailboxEmail: true } },
        },
      });
      if (!row) return ok(null);
      return ok({
        briefId: row.id,
        mailboxEmail: row.subscription.mailboxEmail,
        times: (row.timesJson as string[]) ?? [],
        days: (row.daysJson as string[]) ?? [],
        timeZone: row.timeZone,
        status: row.status,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailBrief.readBriefForUser', cause));
    }
  }

  /**
   * Change when a brief arrives, or switch it off.
   *
   * Ownership is in the `where` rather than checked first, so there is no window
   * in which one member could rewrite another's schedule. `nextRunAt` is
   * recomputed by the caller and written here in the same statement as the
   * schedule — leaving a stale `nextRunAt` beside a new schedule would fire the
   * next brief at the old time and look like the change was ignored.
   */
  async updateBriefForUser(input: {
    companyId: string;
    userId: string;
    times: string[];
    days: string[];
    timeZone: string;
    status: 'active' | 'paused';
    nextRunAt: Date | null;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailBrief.updateMany({
        where: { companyId: input.companyId, userId: input.userId },
        data: {
          timesJson: input.times as Prisma.InputJsonValue,
          daysJson: input.days as Prisma.InputJsonValue,
          timeZone: input.timeZone,
          status: input.status,
          // Paused means nothing is due, ever, until it is switched back on.
          nextRunAt: input.status === 'paused' ? null : input.nextRunAt,
        },
      });
      return ok(updated.count > 0);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailBrief.updateBriefForUser', cause));
    }
  }

  async claimNextDueBrief(
    now = new Date(),
  ): Promise<Result<ClaimedMailBrief | null, InfraError>> {
    try {
      const staleBefore = new Date(now.getTime() - BRIEF_CLAIM_STALE_AFTER_MS);
      const due = await this.db.mailBrief.findFirst({
        where: {
          status: 'active',
          nextRunAt: { lte: now },
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
        orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          companyId: true,
          userId: true,
          subscriptionId: true,
          timesJson: true,
          daysJson: true,
          timeZone: true,
          coveredThrough: true,
          nextRunAt: true,
          claimedAt: true,
          subscription: { select: { mailboxEmail: true, status: true } },
        },
      });
      if (!due?.nextRunAt) return ok(null);

      const token = `brief-${due.id}-${now.getTime()}`;
      const claimed = await this.db.mailBrief.updateMany({
        // `claimedAt` in the predicate as well as the id: two replicas reading
        // the same row is the normal case, and this is what makes exactly one
        // of them win it.
        where: { id: due.id, claimedAt: due.claimedAt },
        data: { claimToken: token, claimedAt: now },
      });
      if (claimed.count !== 1) return ok(null);

      return ok({
        briefId: due.id,
        companyId: due.companyId,
        userId: due.userId,
        subscriptionId: due.subscriptionId,
        mailboxEmail: due.subscription.mailboxEmail,
        mailboxActive: due.subscription.status === 'active',
        times: (due.timesJson as string[]) ?? [],
        days: (due.daysJson as string[]) ?? [],
        timeZone: due.timeZone,
        coveredThrough: due.coveredThrough,
        scheduledFor: due.nextRunAt,
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailBrief.claimNextDueBrief', cause));
    }
  }

  /**
   * The brief went out. Move the window forward and release the claim.
   *
   * `coveredThrough` is set to the moment the brief covered up to rather than
   * to now, so the next one starts exactly where this one stopped and no mail
   * falls between two briefs.
   */
  async completeBrief(input: {
    briefId: string;
    coveredThrough: Date;
    nextRunAt: Date | null;
    ranAt: Date;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.mailBrief.update({
        where: { id: input.briefId },
        data: {
          coveredThrough: input.coveredThrough,
          lastRunAt: input.ranAt,
          nextRunAt: input.nextRunAt,
          claimToken: null,
          claimedAt: null,
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailBrief.completeBrief', cause));
    }
  }

  /**
   * The brief did not go out. Release the claim and try at the next slot.
   *
   * `coveredThrough` is left exactly as it was, which is the whole point: the
   * window this run failed on is folded into the next brief rather than lost.
   */
  async releaseBrief(input: {
    briefId: string;
    nextRunAt: Date | null;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.mailBrief.update({
        where: { id: input.briefId },
        data: {
          nextRunAt: input.nextRunAt,
          claimToken: null,
          claimedAt: null,
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailBrief.releaseBrief', cause));
    }
  }

  /** Everything that arrived in the window, and what the rules did with it. */
  async readBriefWindow(input: {
    companyId: string;
    subscriptionId: string;
    from: Date;
    to: Date;
  }): Promise<Result<{
    messages: Array<{ metadata: Record<string, unknown>; occurredAt: Date }>;
    activity: Array<{ ruleName: string; status: string; count: number }>;
  }, InfraError>> {
    try {
      const [events, deliveries] = await Promise.all([
        this.db.mailEvent.findMany({
          where: {
            companyId: input.companyId,
            subscriptionId: input.subscriptionId,
            occurredAt: { gt: input.from, lte: input.to },
          },
          orderBy: { occurredAt: 'desc' },
          // Bounded here as well as in the composer: a mailing-list morning
          // should not pull four hundred rows into memory to then discard most
          // of them.
          take: 200,
          select: { metadataJson: true, occurredAt: true },
        }),
        this.db.mailDelivery.groupBy({
          by: ['ruleId', 'status'],
          where: {
            companyId: input.companyId,
            subscriptionId: input.subscriptionId,
            firstAttemptAt: { gt: input.from, lte: input.to },
          },
          _count: { _all: true },
        }),
      ]);

      const ruleIds = [...new Set(deliveries.map(d => d.ruleId))];
      const names = ruleIds.length === 0
        ? []
        : await this.db.mailDelivery.findMany({
            where: { ruleId: { in: ruleIds } },
            distinct: ['ruleId'],
            select: { ruleId: true, rule: { select: { name: true } } },
          });
      const nameById = new Map(names.map(n => [n.ruleId, n.rule.name]));

      return ok({
        messages: events.map(e => ({
          metadata: e.metadataJson as Record<string, unknown>,
          occurredAt: e.occurredAt,
        })),
        activity: deliveries.map(d => ({
          ruleName: nameById.get(d.ruleId) ?? 'A rule you have since removed',
          status: d.status,
          count: d._count._all,
        })),
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailBrief.readBriefWindow', cause));
    }
  }
}
