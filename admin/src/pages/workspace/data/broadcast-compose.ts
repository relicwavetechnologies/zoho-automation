/**
 * Composing a broadcast, without a screen.
 *
 * Everything the Broadcast tab decides before it sends — which chats a source
 * offers, what the search narrows to, what one recipient's copy will say, and
 * whether the button may be pressed at all — is here rather than in the
 * component. Not for tidiness: the awkward cases are all data cases (a name with
 * braces in it, a selection that survives a filter change, a list that quietly
 * exceeds the cap) and none of them needs a render to test.
 *
 * The refusal rule is duplicated from the server on purpose, and that duplication
 * is bounded: this copy decides whether a button looks pressable, and the
 * server's copy decides whether anything is sent. The server never trusts this
 * one. If they drift, the screen is wrong for a moment and nothing bad is sent —
 * which is the correct direction for the two to fail in.
 */
import type { Candidate } from './use-broadcast'

/** The gateway's per-request ceiling, and therefore one broadcast's. */
export const MAX_RECIPIENTS = 100

/** WhatsApp's own limit on a text message. */
export const MAX_BODY = 4096

/** Where a recipient list comes from, in ascending order of risk. */
export type Source = 'chats' | 'followups' | 'paste'

/** Which follow-up list builds the audience. */
export type FollowUpList = 'weowe' | 'waiting'

/** The picker's quick filters. */
export type PickerFilter = 'all' | 'dm' | 'group' | 'recent' | 'quiet'

const RECENT_DAYS = 7
const QUIET_DAYS = 14

const daysSince = (iso: string | null, now: number): number =>
  iso === null ? Number.POSITIVE_INFINITY : (now - new Date(iso).getTime()) / 86_400_000

/**
 * The pool a source offers, before search or filters.
 *
 * `followups` is the one worth having. "Everyone we are waiting on" is a real
 * audience a person can describe in one breath, and building it by hand from a
 * chat list means reading fourteen follow-ups and remembering which chats they
 * came from.
 */
export function poolFor(
  candidates: Candidate[],
  source: Source,
  list: FollowUpList,
): Candidate[] {
  if (source !== 'followups') return candidates
  return candidates.filter(c => (list === 'weowe' ? c.weOwe : c.waitingOn))
}

/** What the picker shows, once search and the quick filters are applied. */
export function filterCandidates(
  pool: Candidate[],
  query: string,
  filter: PickerFilter,
  now = Date.now(),
): Candidate[] {
  const q = query.trim().toLowerCase()
  return pool.filter(c => {
    if (q && !c.name.toLowerCase().includes(q) && !c.waChatId.includes(q)) return false
    if (filter === 'dm') return !c.isGroup
    if (filter === 'group') return c.isGroup
    if (filter === 'recent') return daysSince(c.lastMessageAt, now) <= RECENT_DAYS
    if (filter === 'quiet') return daysSince(c.lastMessageAt, now) > QUIET_DAYS
    return true
  })
}

/**
 * Toggle every visible row at once.
 *
 * Scoped to what is *shown*, and selections outside it are preserved. A person
 * who picks four vendors, searches for "Sharma", then clears the search expects
 * their four to still be there — a select-all that silently dropped them would
 * be discovered at the review step, or not at all.
 */
export function toggleAll(
  selected: ReadonlySet<string>,
  visible: Candidate[],
): Set<string> {
  const next = new Set(selected)
  const everyVisibleSelected = visible.length > 0 && visible.every(c => next.has(c.waChatId))
  for (const candidate of visible) {
    if (everyVisibleSelected) next.delete(candidate.waChatId)
    else next.add(candidate.waChatId)
  }
  return next
}

export function toggleOne(selected: ReadonlySet<string>, waChatId: string): Set<string> {
  const next = new Set(selected)
  if (next.has(waChatId)) next.delete(waChatId)
  else next.add(waChatId)
  return next
}

/**
 * Turn typed-in numbers into recipients.
 *
 * Splits on newlines, commas and semicolons, because people paste from all
 * three. Anything that is not a plausible international number is dropped rather
 * than sent — the gateway would accept `98450` and report a successful delivery
 * to nobody.
 *
 * `known` names chats Divo has already spoken to, so a pasted number that is
 * really an existing client is not reported as a cold contact.
 */
export function parsePasted(
  raw: string,
  known: ReadonlyMap<string, string>,
): { recipients: PickedRecipient[]; rejected: string[] } {
  const recipients: PickedRecipient[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  for (const piece of raw.split(/[\n,;]+/)) {
    const trimmed = piece.trim()
    if (!trimmed) continue
    const digits = trimmed.replace(/[^\d]/g, '')
    // Shortest plausible international number is 8 digits; longest is 15.
    if (digits.length < 8 || digits.length > 15) {
      rejected.push(trimmed)
      continue
    }
    const waChatId = `${digits}@c.us`
    if (seen.has(waChatId)) continue
    seen.add(waChatId)
    recipients.push({
      waChatId,
      name: known.get(waChatId) ?? `+${digits}`,
      isGroup: false,
      cold: !known.has(waChatId),
    })
  }
  return { recipients, rejected }
}

/** One chosen recipient, as the review step and the request both need it. */
export type PickedRecipient = {
  waChatId: string
  name: string
  isGroup: boolean
  /** No prior conversation with this number, anywhere in the company. */
  cold: boolean
}

export function pickedFrom(
  pool: Candidate[],
  selected: ReadonlySet<string>,
  sendingSessionId?: string,
): PickedRecipient[] {
  return pool
    .filter(c => selected.has(c.waChatId))
    .map(c => ({
      waChatId: c.waChatId,
      name: c.name,
      isGroup: c.isGroup,
      cold: Boolean(sendingSessionId && c.sessionId !== sendingSessionId),
    }))
}

export type Reach = {
  recipients: number
  groups: number
  cold: number
}

/**
 * What this send actually costs, socially.
 *
 * There is deliberately no "people reached" total. Group sizes are not something
 * Divo knows — the gateway's group list carries an id and a subject and nothing
 * else — and a plausible-looking guess on the screen where somebody decides
 * whether to message a room they cannot see into is worse than a stated absence.
 */
export function summarizeReach(picked: PickedRecipient[]): Reach {
  return {
    recipients: picked.length,
    groups: picked.filter(r => r.isGroup).length,
    cold: picked.filter(r => r.cold).length,
  }
}

/**
 * Substitute one recipient's copy.
 *
 * Mirrors the server's `renderBody` exactly, including the part that matters:
 * the replacement is a function, so a contact whose own name contains `{{name}}`
 * or `$&` is inserted literally instead of being expanded a second time. A
 * preview that differs from what is sent is worse than no preview.
 */
export function renderBody(template: string, name: string): string {
  const value = firstName(name)
  return template.replace(/\{\{\s*name\s*\}\}/g, () => value)
}

export function firstName(displayName: string): string {
  const trimmed = displayName.trim()
  if (!trimmed) return 'there'
  const beforeDash = trimmed.split(/\s+[—–-]\s+/)[0]?.trim() ?? ''
  if (beforeDash !== trimmed) return beforeDash || 'there'
  return trimmed.split(/\s+/)[0] || 'there'
}

/**
 * Why the send button is not pressable, or `null` when it is.
 *
 * Every branch returns a sentence rather than a code, because this text is what
 * a person reads instead of a disabled button with no explanation.
 */
export function refusalFor(picked: PickedRecipient[], body: string): string | null {
  const trimmed = body.trim()
  if (picked.length === 0) return 'Pick at least one recipient.'
  if (picked.length > MAX_RECIPIENTS) {
    return `${picked.length} recipients is over the limit of ${MAX_RECIPIENTS}. `
      + 'One broadcast is one batch at the gateway, and the gateway takes no more than this.'
  }
  if (!trimmed) return 'Write the message first.'
  if (trimmed.length > MAX_BODY) {
    return `The message is ${trimmed.length} characters; WhatsApp takes ${MAX_BODY}.`
  }
  return null
}

/**
 * How long a paced send takes, as words.
 *
 * The upper end of the range, always. A send that finishes early surprises
 * nobody; one that overruns its own estimate makes a person think it has hung
 * and reach for Cancel.
 */
export function pacingLabel(recipients: number, delayMs = 3000): string {
  if (recipients <= 1) return 'a moment'
  const seconds = Math.round(((recipients - 1) * (delayMs + 2000)) / 1000)
  if (seconds < 60) return `about ${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
}

/** How far along a running broadcast is, as a percentage of recipients settled. */
export function progressPct(sent: number, failed: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round(((sent + failed) / total) * 100))
}

/** Whether a broadcast is over, so the screen can stop polling and offer Cancel no more. */
export function isFinished(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}
