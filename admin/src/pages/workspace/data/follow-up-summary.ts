/**
 * What the follow-ups page counts, and what a number's state actually is.
 *
 * Pure, and separate from the screen because both answers are easy to get
 * subtly wrong and neither needs rendering to test. The number-state one in
 * particular: "linked" and "has an unfilled gap" are independent, and the
 * combination is the state that matters most.
 */
import type { FollowUp, LinkedNumber } from './use-follow-ups'

export type FollowUpSummary = {
  total: number
  /** Ours to do. */
  weOwe: number
  /** Someone else's, and we are waiting. */
  waiting: number
  high: number
  /** Past a stated due date. */
  overdue: number
}

export function summarizeFollowUps(items: FollowUp[], now = new Date()): FollowUpSummary {
  const today = now.getTime()
  return {
    total: items.length,
    weOwe: items.filter(i => i.owner === 'us').length,
    waiting: items.filter(i => i.owner === 'them').length,
    high: items.filter(i => i.urgency === 'high').length,
    overdue: items.filter(i => i.dueDate !== null && new Date(i.dueDate).getTime() < today).length,
  }
}

/**
 * What a linked number is really doing.
 *
 * `gap` is the one worth the extra state. A number can be connected *and* still
 * be missing messages — it went dark, came back, and nobody has re-read what it
 * missed. Collapsing that into `healthy` would hide the exact hole the re-read
 * button exists to close, and the number would look fine while a client's
 * messages were still absent.
 */
export type NumberState = 'pending' | 'dark' | 'gap' | 'quiet' | 'new' | 'healthy'

export function numberState(number: LinkedNumber): NumberState {
  if (number.status === 'pending') return 'pending'
  if (number.status === 'disconnected') return 'dark'
  // Connected again, but the messages sent while it was down are still missing.
  if (number.darkSince !== null) return 'gap'
  if (number.stale) return 'quiet'
  /*
   * Linked, and simply has not been messaged yet.
   *
   * Checked after `stale` so it can only describe a number still inside its
   * grace. Before this existed, a handset scanned a minute ago was reported as
   * "no messages lately" and raised the banner that tells the team their counts
   * are an undercount — the alarm meant for a number that died, shown for one
   * that is working perfectly and merely new.
   */
  if (number.awaitingFirstMessage) return 'new'
  return 'healthy'
}

/**
 * Whether this number has something a person should act on.
 *
 * `new` is deliberately absent: nothing is wrong and there is nothing to do but
 * wait for somebody to message it.
 */
export function needsAttention(number: LinkedNumber): boolean {
  const state = numberState(number)
  return state === 'dark' || state === 'gap' || state === 'quiet'
}

/** Rough, human-sized. "3 days" beats "76 hours" on a card somebody skims. */
export function sinceLabel(iso: string | null, now = new Date()): string {
  if (!iso) return 'never'
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
