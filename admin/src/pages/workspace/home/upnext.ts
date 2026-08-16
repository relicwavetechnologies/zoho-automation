/**
 * One list of what is waiting on you, out of the several places it lives.
 *
 * The home page used to show open Lark tasks under their own heading, and
 * approvals under another, and running work under a third. Three lists is three
 * places to look for the answer to one question — what should I deal with now —
 * and none of them could answer it, because the most urgent thing on the page
 * might be the fourth row of the second list.
 *
 * So the merge happens here, in ordinary code, and the view draws whatever it
 * is handed. That split is the point: ordering by urgency across two different
 * shapes is the part with rules in it, and rules are worth asserting. The card
 * has no logic to test and this has no DOM to render.
 *
 * WHAT IS NOT HERE: meetings. Nothing in this product can see a calendar —
 * `src/http/member/` serves tasks and artifacts, and there is no calendar route
 * behind either. A meeting row would have to be invented, and a dashboard that
 * invents a meeting is worse than one that admits it cannot see them. When a
 * calendar read lands, it becomes a third `kind` and nothing else changes.
 */
import type { ApprovalItem } from '../data/use-approvals'
import type { OpenTask } from '../data/use-my-tasks'

/**
 * How soon this needs a person, as a word rather than a date.
 *
 * The view colours and groups by this and never does date arithmetic of its
 * own — which is what stops "3 days late" being red in one row and grey in the
 * next because two components each decided what "late" meant.
 */
export type Urgency = 'late' | 'today' | 'soon' | 'later'

export type UpNextItem = {
  readonly id: string
  readonly kind: 'task' | 'approval'
  readonly title: string
  /** Who or what it came from — "Lark", a requester's name. Never the status. */
  readonly source: string
  /** "2 days late", "Due today", "Expires in 4h". Absent when nothing says. */
  readonly when: string | null
  readonly urgency: Urgency
  /** The row's own copy of what it came from, for whatever the action needs. */
  readonly task?: OpenTask
  readonly approval?: ApprovalItem
}

const RANK: Record<Urgency, number> = { late: 0, today: 1, soon: 2, later: 3 }

const DAY_MS = 86_400_000

/** Midnight-to-midnight, so "due today" does not depend on the time of day. */
function daysUntil(iso: string, now: Date): number {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - today) / DAY_MS)
}

function taskUrgency(task: OpenTask, now: Date): Urgency {
  /* `overdue` is Lark's own answer and outranks the date we were given: a task
     with no due date can still be overdue there, and one whose date has passed
     may have been reopened. */
  if (task.overdue) return 'late'
  if (!task.dueDate) return 'later'
  const days = daysUntil(task.dueDate, now)
  if (days < 0) return 'late'
  if (days === 0) return 'today'
  return days <= 3 ? 'soon' : 'later'
}

function taskWhen(task: OpenTask, now: Date): string | null {
  if (!task.dueDate) return task.overdue ? 'Overdue' : null
  const days = daysUntil(task.dueDate, now)
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} late`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}

/**
 * An approval's clock is its expiry, and it runs in hours rather than days.
 *
 * A request that lapses in ninety minutes and a task due in three days are not
 * comparable on their own terms, so both are reduced to the same four words
 * before they are ever put in one list.
 */
function approvalWhen(expiresAt: string | null, now: Date): { when: string | null; urgency: Urgency } {
  if (!expiresAt) return { when: null, urgency: 'today' }
  const ms = Date.parse(expiresAt) - now.getTime()
  if (Number.isNaN(ms)) return { when: null, urgency: 'today' }
  if (ms <= 0) return { when: 'Expired', urgency: 'late' }
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return { when: `Expires in ${Math.max(1, Math.round(ms / 60_000))}m`, urgency: 'late' }
  if (hours < 24) return { when: `Expires in ${hours}h`, urgency: 'today' }
  const days = Math.round(hours / 24)
  return { when: `Expires in ${days} day${days === 1 ? '' : 's'}`, urgency: days <= 3 ? 'soon' : 'later' }
}

/**
 * Merge, order, and cut to a length a dashboard can carry.
 *
 * Approvals sort above tasks at equal urgency, deliberately. An approval is
 * somebody else stopped mid-run waiting on this person; a task is this person's
 * own work. Both are "today", only one of them is blocking another human.
 *
 * The tie-break after that is the title, not the input order. Two reads that
 * return the same rows in a different sequence would otherwise reshuffle the
 * list under the reader's eyes on every poll.
 */
export function upNext(
  tasks: readonly OpenTask[],
  approvals: readonly ApprovalItem[],
  limit = 6,
  now = new Date(),
): UpNextItem[] {
  const items: UpNextItem[] = [
    ...approvals.map((approval): UpNextItem => {
      const { when, urgency } = approvalWhen(approval.expiresAt, now)
      return {
        id: `approval:${approval.id}`,
        kind: 'approval',
        title: approval.description?.summary || approval.action || 'Approval requested',
        source: approval.requestedByName,
        when,
        urgency,
        approval,
      }
    }),
    ...tasks.map((task): UpNextItem => ({
      id: `task:${task.taskId}`,
      kind: 'task',
      title: task.title,
      source: 'Lark',
      when: taskWhen(task, now),
      urgency: taskUrgency(task, now),
      task,
    })),
  ]

  return items
    .sort((a, b) =>
      RANK[a.urgency] - RANK[b.urgency]
      || (a.kind === b.kind ? 0 : a.kind === 'approval' ? -1 : 1)
      || a.title.localeCompare(b.title))
    .slice(0, limit)
}

/**
 * How many are past their moment, for the header.
 *
 * Counted over everything rather than over the trimmed list: a header saying
 * "2 late" above six rows that show one of them is still true, and a header
 * that silently agreed with the cut would under-report the day.
 */
export function lateCount(items: readonly UpNextItem[]): number {
  return items.filter((i) => i.urgency === 'late').length
}
