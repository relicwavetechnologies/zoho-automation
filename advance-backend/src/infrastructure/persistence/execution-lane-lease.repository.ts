import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

export interface LaneLease {
  readonly laneKey: string;
  readonly ownerId: string;
  /**
   * Presented on every renew, release, and publish. A holder whose token is
   * behind the lane's current one has been superseded.
   */
  readonly fencingToken: number;
  readonly expiresAt: Date;
}

/**
 * What an acquisition found.
 *
 * `held` is returned rather than a bare `false` because the caller has to
 * decide between waiting and giving up, and it can only do that if it knows
 * when the current lease expires. A boolean would push that decision onto a
 * guess.
 */
export type LaneLeaseOutcome =
  | { outcome: 'acquired'; lease: LaneLease }
  | { outcome: 'held'; ownerId: string; expiresAt: Date };

export interface AcquireLaneInput {
  channel: string;
  laneKey: string;
  ownerId: string;
  ttlMs: number;
}

export interface ExecutionLaneLeaseRepoPort {
  acquire(input: AcquireLaneInput): Promise<Result<LaneLeaseOutcome, InfraError>>;
  heartbeat(
    lease: LaneLease,
    input: { channel: string; ttlMs: number },
  ): Promise<Result<boolean, InfraError>>;
  release(lease: LaneLease, channel: string): Promise<Result<void, InfraError>>;
  holdsLane(lease: LaneLease, channel: string): Promise<Result<boolean, InfraError>>;
}

type LeaseRow = {
  id: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: Date;
  releasedAt: Date | null;
};

const LEASE_SELECT = {
  id: true, ownerId: true, fencingToken: true, expiresAt: true, releasedAt: true,
} as const;

/**
 * One live owner per execution lane, across every replica.
 *
 * The `(channel, laneKey)` unique constraint is the mutual exclusion itself,
 * not an optimisation of it: two replicas racing to open the same lane both
 * insert, and exactly one survives. Everything else here exists to make a
 * *dead* owner recoverable without making a *live* one stealable.
 *
 * Expiry is compared against this process's clock. Replicas are assumed to be
 * within a few seconds of each other; the TTL is set far larger than any
 * plausible skew, so a modest disagreement cannot hand one lane to two owners.
 */
export class ExecutionLaneLeaseRepository implements ExecutionLaneLeaseRepoPort {
  constructor(private readonly prisma: Pick<PrismaClient, 'executionLaneLease'>) {}

  async acquire(input: AcquireLaneInput): Promise<Result<LaneLeaseOutcome, InfraError>> {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + input.ttlMs);
      const where = { channel_laneKey: { channel: input.channel, laneKey: input.laneKey } };

      const existing = await this.prisma.executionLaneLease.findUnique({
        where, select: LEASE_SELECT,
      }) as LeaseRow | null;

      if (existing) return ok(await this.takeIfFree(existing, input, now, expiresAt));

      try {
        const created = await this.prisma.executionLaneLease.create({
          data: {
            channel: input.channel,
            laneKey: input.laneKey,
            ownerId: input.ownerId,
            fencingToken: 1,
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt,
          },
          select: { fencingToken: true, expiresAt: true },
        });
        return ok({
          outcome: 'acquired' as const,
          lease: {
            laneKey: input.laneKey,
            ownerId: input.ownerId,
            fencingToken: created.fencingToken,
            expiresAt: created.expiresAt,
          },
        });
      } catch (cause) {
        // Another replica opened this lane between the read and the insert. The
        // constraint did its job; resolve it to a verdict rather than an error,
        // because an error here reads to the caller as "the lease system is
        // broken" — and the safe response to that is to refuse to run at all,
        // when the correct answer is simply "someone else has it".
        if ((cause as { code?: string }).code !== 'P2002') throw cause;
        const winner = await this.prisma.executionLaneLease.findUnique({
          where, select: LEASE_SELECT,
        }) as LeaseRow | null;
        if (!winner) throw cause;
        return ok(await this.takeIfFree(winner, input, now, expiresAt));
      }
    } catch (e) {
      return err(wrapInfra('prisma', 'executionLaneLease.acquire', e));
    }
  }

  /**
   * Take a lane whose owner has released it or gone silent.
   *
   * The update predicate repeats the freeness check so two workers that both
   * saw the same expired lease cannot both take it: the predicate is evaluated
   * inside the write, and the loser updates zero rows.
   */
  private async takeIfFree(
    row: LeaseRow,
    input: AcquireLaneInput,
    now: Date,
    expiresAt: Date,
  ): Promise<LaneLeaseOutcome> {
    const free = row.releasedAt !== null || row.expiresAt <= now;
    if (!free) {
      return { outcome: 'held', ownerId: row.ownerId, expiresAt: row.expiresAt };
    }

    const nextToken = row.fencingToken + 1;
    const claimed = await this.prisma.executionLaneLease.updateMany({
      where: {
        id: row.id,
        fencingToken: row.fencingToken,
        OR: [{ releasedAt: { not: null } }, { expiresAt: { lte: now } }],
      },
      data: {
        ownerId: input.ownerId,
        fencingToken: nextToken,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
        releasedAt: null,
      },
    });

    if (claimed.count === 0) {
      const current = await this.prisma.executionLaneLease.findUnique({
        where: { channel_laneKey: { channel: input.channel, laneKey: input.laneKey } },
        select: { ownerId: true, expiresAt: true },
      });
      return {
        outcome: 'held',
        ownerId: current?.ownerId ?? 'unknown',
        expiresAt: current?.expiresAt ?? expiresAt,
      };
    }

    return {
      outcome: 'acquired',
      lease: {
        laneKey: input.laneKey,
        ownerId: input.ownerId,
        fencingToken: nextToken,
        expiresAt,
      },
    };
  }

  /**
   * Extend the lease, and report whether it is still ours.
   *
   * `false` is not a failure to write — it means the lane was taken while this
   * run was working, and the run must stop. Reporting that as an error would
   * make a lost lane indistinguishable from a database blip, and those two
   * demand opposite responses.
   */
  async heartbeat(
    lease: LaneLease,
    input: { channel: string; ttlMs: number },
  ): Promise<Result<boolean, InfraError>> {
    try {
      const now = new Date();
      const renewed = await this.prisma.executionLaneLease.updateMany({
        where: {
          channel: input.channel,
          laneKey: lease.laneKey,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          releasedAt: null,
        },
        data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + input.ttlMs) },
      });
      return ok(renewed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'executionLaneLease.heartbeat', e));
    }
  }

  async release(lease: LaneLease, channel: string): Promise<Result<void, InfraError>> {
    try {
      // Scoped by owner and token so a worker that already lost the lane cannot
      // release it out from under whoever took it.
      await this.prisma.executionLaneLease.updateMany({
        where: {
          channel,
          laneKey: lease.laneKey,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          releasedAt: null,
        },
        data: { releasedAt: new Date() },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'executionLaneLease.release', e));
    }
  }

  /**
   * Whether this lease is still the lane's current one.
   *
   * A read rather than a renew, because the caller uses it immediately before
   * publishing, and extending the lease at that point would hide the very
   * staleness it is checking for. The check cannot be atomic with a send to
   * Lark, so it narrows the window rather than closing it; the delivery
   * reservation is what actually makes a duplicate impossible.
   */
  async holdsLane(lease: LaneLease, channel: string): Promise<Result<boolean, InfraError>> {
    try {
      const row = await this.prisma.executionLaneLease.findUnique({
        where: { channel_laneKey: { channel, laneKey: lease.laneKey } },
        select: { ownerId: true, fencingToken: true, releasedAt: true, expiresAt: true },
      });
      if (!row) return ok(false);
      return ok(
        row.ownerId === lease.ownerId
        && row.fencingToken === lease.fencingToken
        && row.releasedAt === null
        && row.expiresAt > new Date(),
      );
    } catch (e) {
      return err(wrapInfra('prisma', 'executionLaneLease.holdsLane', e));
    }
  }
}
