import type { Job } from 'bullmq';

/**
 * Whether BullMQ has genuinely given up on a job, inside a `failed` handler.
 *
 * The count means different things either side of `moveToFailed`. Inside the
 * processor's own catch block `attemptsMade` has not been incremented yet, so
 * `attemptsMade + 1` is the attempt that just failed. By the time the `failed`
 * event fires the increment has happened, so the same expression counts one
 * attempt too many and reports the job as dead while BullMQ is still going to
 * retry it.
 *
 * That gap is user-visible: it marked a Teach session failed on the second
 * OpenAI wobble, showing "Divo could not save what it learned" while a third
 * attempt — often a successful one — was still queued.
 */
export function isFinalFailedAttempt(
  job: Pick<Job, 'attemptsMade' | 'opts'> | undefined,
  error?: unknown,
): boolean {
  if (!job) return false;
  if (isUnrecoverableJobError(error)) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * BullMQ refuses to retry these regardless of the configured attempts, so a
 * count-based check reports "two of three, it will try again" for a job that
 * is already dead. Stalled jobs surface this way, which is how a Teach session
 * came to sit in `ingesting` with nothing left to move it.
 *
 * Matched by name as well as instance because the error crosses a process
 * boundary, arriving deserialised rather than as the original class.
 */
export function isUnrecoverableJobError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name;
  return name === 'UnrecoverableError' || /UnrecoverableError/.test(String(error));
}
