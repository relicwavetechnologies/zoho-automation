import type {
  ExecutionLaneLeaseRepoPort,
  LaneLease,
} from '../../infrastructure/persistence/execution-lane-lease.repository';
import type { Logger } from '../../shared/logger';

/**
 * Lease timing.
 *
 * The TTL has to outlive a plausible pause — GC, a slow model call, a stalled
 * network write — or a healthy worker loses its own lane mid-run. It also has
 * to be short enough that a *dead* worker's lane frees up before the user gives
 * up. Renewing at a third of the TTL means two heartbeats can be lost without
 * the lease lapsing.
 */
export const LANE_LEASE_TTL_MS = 90_000;
export const LANE_LEASE_HEARTBEAT_MS = 30_000;

export type LaneRunOutcome =
  | { outcome: 'ran' }
  | { outcome: 'deferred'; ownerId: string; expiresAt: Date }
  | { outcome: 'lost' };

export interface LaneLeaseHolderDeps {
  readonly repo: ExecutionLaneLeaseRepoPort;
  readonly channel: string;
  readonly ownerId: string;
  readonly logger: Logger;
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
}

/**
 * Run `task` while holding the lane, or decline to run at all.
 *
 * The contract is deliberately narrow: either the task ran under a lease this
 * process genuinely held, or it did not start. There is no middle case where
 * work proceeds "probably alone" — that is exactly the state a second replica
 * would turn into two agents answering one message.
 *
 * A lease lost mid-run aborts the task through the same `AbortSignal` the
 * timeout uses, so cancellation has one path rather than two.
 */
export class LaneLeaseHolder {
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly deps: LaneLeaseHolderDeps) {
    this.ttlMs = deps.ttlMs ?? LANE_LEASE_TTL_MS;
    this.heartbeatMs = deps.heartbeatMs ?? LANE_LEASE_HEARTBEAT_MS;
  }

  /**
   * Whether a lease is still the lane's current one. Throws rather than
   * returning false on an unreachable store, so the caller can tell "you were
   * superseded" from "we could not find out" — those warrant opposite actions.
   */
  async holdsLane(lease: LaneLease): Promise<boolean> {
    const held = await this.deps.repo.holdsLane(lease, this.deps.channel);
    if (!held.ok) throw held.error;
    return held.value;
  }

  async withLane(
    laneKey: string,
    task: (lease: LaneLease, signal: AbortSignal) => Promise<void>,
    outerSignal?: AbortSignal,
  ): Promise<LaneRunOutcome> {
    const acquired = await this.deps.repo.acquire({
      channel: this.deps.channel,
      laneKey,
      ownerId: this.deps.ownerId,
      ttlMs: this.ttlMs,
    });

    if (!acquired.ok) {
      // A lease store that cannot answer is not permission to proceed. Running
      // anyway is precisely the two-replicas-one-thread failure this exists to
      // prevent, and the message is durable — deferring costs latency, while
      // proceeding costs a duplicate answer.
      this.deps.logger.error('lane_lease.acquire_failed', {
        laneKey, error: acquired.error.message,
      });
      throw acquired.error;
    }

    if (acquired.value.outcome === 'held') {
      this.deps.logger.info('lane_lease.deferred', {
        laneKey,
        heldBy: acquired.value.ownerId,
        expiresAt: acquired.value.expiresAt.toISOString(),
      });
      return {
        outcome: 'deferred',
        ownerId: acquired.value.ownerId,
        expiresAt: acquired.value.expiresAt,
      };
    }

    const lease = acquired.value.lease;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    outerSignal?.addEventListener('abort', forwardAbort, { once: true });
    if (outerSignal?.aborted) controller.abort();

    let lostLane = false;
    const timer = setInterval(() => {
      void this.deps.repo.heartbeat(lease, {
        channel: this.deps.channel,
        ttlMs: this.ttlMs,
      }).then(result => {
        if (!result.ok) {
          // One failed renewal is not proof the lane is gone; the lease still
          // has most of its TTL left and the next beat may succeed. Aborting
          // here would turn a transient blip into a cancelled run.
          this.deps.logger.warn('lane_lease.heartbeat_failed', {
            laneKey, error: result.error.message,
          });
          return;
        }
        if (!result.value) {
          lostLane = true;
          this.deps.logger.warn('lane_lease.lost', { laneKey, ownerId: lease.ownerId });
          controller.abort();
        }
      });
    }, this.heartbeatMs);
    (timer as ReturnType<typeof setInterval>).unref?.();

    try {
      await task(lease, controller.signal);
      return lostLane ? { outcome: 'lost' } : { outcome: 'ran' };
    } finally {
      clearInterval(timer);
      outerSignal?.removeEventListener('abort', forwardAbort);
      // Released even when the task threw: a crashed run should free its lane
      // now rather than make the next message wait out the full TTL. If the
      // lane was already taken from us the scoped predicate makes this a no-op.
      const released = await this.deps.repo.release(lease, this.deps.channel);
      if (!released.ok) {
        this.deps.logger.warn('lane_lease.release_failed', {
          laneKey, error: released.error.message,
        });
      }
    }
  }
}
