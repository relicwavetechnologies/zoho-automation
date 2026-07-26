import type { LarkChannelAdapter } from './lark.adapter';
import type { Logger } from '../../../shared/logger';
import { ChannelError } from '../../../shared/errors';
import { err } from '../../../shared/result';

/**
 * Stop a superseded lane owner from publishing.
 *
 * A worker that lost its lane — GC pause, network partition, a stalled model
 * call outliving the lease — may still be mid-run and still believe it owns the
 * conversation. By the time it finishes, a new owner has taken the lane and may
 * already have answered. Letting the old run post anyway puts a stale reply
 * *after* a fresh one, which reads to the user as Divo contradicting itself.
 *
 * Only `sendFinalReply` is fenced. Status cards are transient and get edited or
 * superseded anyway; refusing those would add failure paths without preventing
 * anything a user would notice.
 *
 * This narrows the window rather than closing it: the check cannot be atomic
 * with a call to Lark's API. What makes a *duplicate* impossible is the Wave 5
 * delivery reservation, which is keyed on the run and so collides regardless of
 * which worker gets there first. The fence handles the different problem of a
 * stale answer arriving out of order.
 */
export const fenceFinalReplies = (
  adapter: LarkChannelAdapter,
  holdsLane: () => Promise<boolean>,
  log: Logger,
): LarkChannelAdapter =>
  new Proxy(adapter, {
    get(target, property, receiver) {
      if (property !== 'sendFinalReply') return Reflect.get(target, property, receiver);

      return async (
        ...args: Parameters<LarkChannelAdapter['sendFinalReply']>
      ): ReturnType<LarkChannelAdapter['sendFinalReply']> => {
        let stillOurs: boolean;
        try {
          stillOurs = await holdsLane();
        } catch (error) {
          // An unanswerable fence is not proof of loss. Refusing here would
          // drop a legitimate reply every time the lease store hiccups, which
          // is a worse and far more common failure than the stale publish this
          // guards against.
          log.warn('lane_fence.check_failed', { error: String(error) });
          stillOurs = true;
        }

        if (!stillOurs) {
          log.warn('lane_fence.publish_refused', {
            reason: 'lane taken by a newer owner while this run was working',
          });
          return err(new ChannelError({
            channel: 'lark',
            stage: 'send_final',
            // Not a delivery failure — the send was never attempted, and a
            // retry by this owner would be refused again for the same reason.
            reason: 'not_supported',
            message: 'Refused: this run no longer owns its execution lane',
          }));
        }

        return target.sendFinalReply(...args);
      };
    },
  });
