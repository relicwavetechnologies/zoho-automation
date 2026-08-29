/**
 * Scope selector — the one control that narrows every tab at once.
 *
 * Ten numbers is a scope, not ten tabs: one pill in the page header narrows
 * Open, Chats and Broadcast together. The URL `?number=<id>` is the single
 * source of truth — the Lark digest card already writes it, and a second
 * piece of component state would drift.
 *
 * Pure, and separate from the screen because filtering a list and counting
 * what each row represents are easy to get subtly wrong and neither needs
 * rendering to test.
 */
import type { FollowUp, LinkedNumber } from './use-follow-ups'
import { numberState } from './follow-up-summary'
import type { NumberState } from './follow-up-summary'

export type ScopeNumberRow = {
  readonly id: string
  readonly label: string
  readonly phone: string
  readonly state: NumberState
  readonly stateLabel: string
  readonly healthDot: 'ok' | 'warn' | 'err' | 'idle'
  readonly count: number
}

/** What each number state says, and how loudly — mirrors screens-followups. */
const STATE_LABEL: Record<NumberState, string> = {
  healthy: 'Reading',
  quiet: 'No messages lately',
  new: 'Waiting for first message',
  gap: 'Messages missing',
  dark: 'Not connected',
  pending: 'Waiting to be linked',
}

const HEALTH_DOT: Record<NumberState, 'ok' | 'warn' | 'err' | 'idle'> = {
  healthy: 'ok',
  gap: 'err',
  dark: 'err',
  quiet: 'warn',
  // Idle, not warn: a number nobody has messaged yet is working correctly.
  new: 'idle',
  pending: 'idle',
}

/** Pill label. "All N numbers" when unscoped, the number's label when scoped. */
export function scopePillLabel(
  numberId: string | undefined,
  numbers: readonly LinkedNumber[],
): string {
  if (!numberId) return `All ${numbers.length} numbers`
  const found = numbers.find(n => n.id === numberId)
  return found?.label ?? `All ${numbers.length} numbers`
}

/**
 * Filter numbers by label or phone. The menu shows a search field when there
 * are more than ~6 numbers; the filter itself is always available so the
 * 7th number is reachable by typing.
 */
export function filterScopeNumbers(
  numbers: readonly LinkedNumber[],
  query: string,
): readonly LinkedNumber[] {
  const q = query.trim().toLowerCase()
  if (!q) return numbers
  return numbers.filter(n => {
    const label = n.label.toLowerCase()
    const phone = (n.phoneE164 ?? '').toLowerCase()
    return label.includes(q) || phone.includes(q)
  })
}

/** Total open count — what "All numbers" shows. */
export function totalOpenCount(followUps: readonly FollowUp[]): number {
  return followUps.length
}

/** Open count per number. Built from follow-ups' sessionId (what the digest card's link carries). */
export function openCountsByNumber(
  followUps: readonly FollowUp[],
): Map<string, number> {
  const map = new Map<string, number>()
  for (const followUp of followUps) {
    // Optional on the type because a follow-up read before the route carried
    // `sessionId` has none. Skipped rather than bucketed under a placeholder:
    // a count nobody can attribute is worse than a count that is absent.
    if (!followUp.sessionId) continue
    map.set(followUp.sessionId, (map.get(followUp.sessionId) ?? 0) + 1)
  }
  return map
}

export function scopeHealthDot(number: LinkedNumber): 'ok' | 'warn' | 'err' | 'idle' {
  const state = numberState(number)
  return HEALTH_DOT[state]
}

export function scopeStateLabel(number: LinkedNumber): string {
  return STATE_LABEL[numberState(number)]
}

export function scopeState(number: LinkedNumber): NumberState {
  return numberState(number)
}

/** One menu row. Count is open follow-ups for this number (— when none). */
export function scopeRow(
  number: LinkedNumber,
  openCount: number,
): ScopeNumberRow {
  const state = numberState(number)
  return {
    id: number.id,
    label: number.label,
    phone: number.phoneE164 ?? '—',
    state,
    stateLabel: STATE_LABEL[state],
    healthDot: HEALTH_DOT[state],
    count: openCount,
  }
}

/** All menu rows, already filtered by query. Sorted by label for stability. */
export function scopeMenuRows(
  numbers: readonly LinkedNumber[],
  followUps: readonly (FollowUp & { sessionId?: string })[],
  query: string,
): readonly ScopeNumberRow[] {
  const filtered = filterScopeNumbers(numbers, query)
  const counts = openCountsByNumber(followUps)
  return filtered
    .map(n => scopeRow(n, counts.get(n.id) ?? 0))
    .sort((a, b) => a.label.localeCompare(b.label))
}
