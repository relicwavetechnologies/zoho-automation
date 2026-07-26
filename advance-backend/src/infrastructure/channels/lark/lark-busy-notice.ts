/**
 * Telling someone their message is queued — once.
 *
 * A lane is FIFO, so a second message sent while Divo is still working waits.
 * Without a word that looks like being ignored. With a word *per message* it
 * looks worse: someone firing off four quick thoughts gets four "please wait"
 * notices and no answers, which is noisier than silence.
 *
 * So the rule is one notice per busy stretch of a lane, cleared when the lane
 * drains. The next time the lane goes busy, the user is worth telling again.
 */

export interface BusyNoticeDecision {
  readonly notify: boolean;
  readonly reason: 'lane_idle' | 'already_notified' | 'suppressed_kind' | 'notify';
}

export const decideBusyNotice = (input: {
  readonly laneBusy: boolean;
  readonly alreadyNotified: boolean;
  /**
   * Commands answer from the webhook path rather than from an agent run, so
   * they are not really waiting on the lane and a queue notice would be wrong.
   */
  readonly isCommand: boolean;
}): BusyNoticeDecision => {
  if (!input.laneBusy) return { notify: false, reason: 'lane_idle' };
  if (input.isCommand) return { notify: false, reason: 'suppressed_kind' };
  if (input.alreadyNotified) return { notify: false, reason: 'already_notified' };
  return { notify: true, reason: 'notify' };
};

export const BUSY_NOTICE_TEXT =
  "Got it — I'm still finishing your previous message. I'll come back to this one right after.";

/**
 * Which lanes have already been told.
 *
 * Process-local on purpose. A duplicate notice from a second replica is a
 * cosmetic annoyance, and paying for a database round trip on every queued
 * message to prevent one would cost more than the problem.
 */
export class BusyLaneNotices {
  private readonly notified = new Set<string>();

  decide(laneKey: string, input: { laneBusy: boolean; isCommand: boolean }): BusyNoticeDecision {
    const decision = decideBusyNotice({
      laneBusy: input.laneBusy,
      isCommand: input.isCommand,
      alreadyNotified: this.notified.has(laneKey),
    });
    if (decision.notify) this.notified.add(laneKey);
    return decision;
  }

  /** Called when a lane finishes its work, so the next backlog is announced. */
  clear(laneKey: string): void {
    this.notified.delete(laneKey);
  }

  get size(): number {
    return this.notified.size;
  }
}
