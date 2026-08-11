/**
 * Mail rules for the You scope.
 *
 * Mail Ops ran for a long time with no reachable state at all — its only HTTP
 * surface was the Gmail push webhook — so a rule could stop firing and nobody
 * could find out. These hooks read the three endpoints added for exactly that:
 * `/rules` answers "is it working", `/health` answers "why did everything stop"
 * (a mailbox whose watch never registered takes every rule on it down at once),
 * and `/rules/:id/deliveries` answers "what did it actually do".
 *
 * `/caught` answers the one a member actually arrives with — what has Divo been
 * doing with my mail — across every rule at once, including the messages a
 * rule's AI step read and decided not to act on.
 *
 * No userId anywhere. Every query is pinned server-side to the signed-in
 * member, so there is nothing to pass and nothing to get wrong.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useConnections } from './use-connections'
import { resolveMailboxes, type MailboxResolution } from './mailbox-resolution'

const BASE = '/api/mail-automations'

/** Worst first. `waiting` is a healthy rule that has simply not matched yet. */
export type MailRuleState =
  | 'broken' | 'blocked' | 'mailbox_down' | 'paused' | 'archived' | 'working' | 'waiting'

/**
 * Worst first. `watch_delayed` and `watch_degraded` both still deliver — Divo
 * falls back to an hourly check when instant notifications stop — so they are
 * a latency fault, not an outage, and `rulesCanFire` stays true for them.
 */
export type MailboxState =
  | 'never_started' | 'sync_failing' | 'watch_degraded' | 'watch_delayed'
  | 'paused' | 'healthy'

export type MailRule = {
  ruleId: string
  name: string
  status: string
  state: MailRuleState
  /** Backend's one-line verdict, written for a person rather than an operator. */
  summary: string
  /** Set when the stored rule no longer parses — it can never fire again. */
  invalidReason: string | null
  mailboxEmail: string
  connectionId: string
  match: Record<string, unknown>
  action: Record<string, unknown>
  destination: Record<string, unknown>
  /** The rule's AI step, or null. The edit form seeds from this. */
  judge: { question: string; onFailure?: 'open' | 'closed' } | null
  createdAt: string
  lastDeliveredAt: string | null
  /** Counts over the last 30 days, not all time. */
  deliveredCount: number
  failingCount: number
  abandonedCount: number
  /** Matched the rule, then was refused. Recorded rather than dropped. */
  blockedCount: number
  /**
   * Matched, read by the AI step, and deliberately not acted on.
   *
   * Kept apart from `blockedCount` because it is the rule working rather than
   * the rule being stopped — on a rule with a step this is usually the biggest
   * of the four counts, and folding it into refusals would make a healthy rule
   * read as one that fails constantly.
   */
  heldCount: number
  lastError: string | null
  lastErrorAt: string | null
}

export type MailboxHealth = {
  subscriptionId: string
  mailboxEmail: string
  state: MailboxState
  /** The only field that matters at a glance: can anything fire at all. */
  rulesCanFire: boolean
  summary: string
  /** Present only when there is something the member themselves can do. */
  remedy: string | null
  failureCode: string | null
  activeRuleCount: number
  lastSucceededAt: string | null
  lastSignalAt: string | null
  watchExpirationAt: string | null
}

export type MailDelivery = {
  deliveryId: string
  status: string
  attempts: number
  /** What the rule's AI step decided about this message, if it has one. */
  verdict?: MailJudgeVerdict | null
  /**
   * Where the message actually went, on a rule that chooses per message.
   *
   * Null on every rule with one destination. Screens must prefer this over the
   * rule's own destination, which on a routed rule is a table and would name
   * the wrong person.
   */
  resolvedDestination?: Record<string, unknown> | null
  /**
   * The send was made but could not be confirmed. Gmail does not reliably keep
   * a client-supplied Message-ID, so a retry here risks a duplicate — the
   * worker stops instead, and this flag is the only trace of that choice.
   */
  ambiguous: boolean
  lastError: string | null
  subject: string | null
  from: string | null
  firstAttemptAt: string
  deliveredAt: string | null
  nextAttemptAt: string | null
}

export function useMailAutomations(includeInactive = false) {
  const { token } = useAdminAuth()
  const [rules, setRules] = useState<MailRule[]>([])
  const [mailboxes, setMailboxes] = useState<MailboxHealth[]>([])
  const [anyMailboxBroken, setAnyMailboxBroken] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  // Set on mount, not at declaration: React's dev double-mount tears the first
  // one down, and a flag only ever set to false would leave the second mount's
  // fetch discarded and the page skeletal forever.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async () => {
    if (!token) return
    try {
      const [ruleData, healthData] = await Promise.all([
        api.get<{ rules: MailRule[] }>(
          `${BASE}/rules?includeInactive=${includeInactive ? 'true' : 'false'}`,
          token,
          { quiet: true },
        ),
        api.get<{ mailboxes: MailboxHealth[]; anyMailboxBroken: boolean }>(
          `${BASE}/health`, token, { quiet: true },
        ),
      ])
      if (!alive.current) return
      setRules(ruleData.rules ?? [])
      setMailboxes(healthData.mailboxes ?? [])
      setAnyMailboxBroken(Boolean(healthData.anyMailboxBroken))
      setError(null)
    } catch {
      // A screen about broken automations must not itself fail silently.
      if (alive.current) setError('Could not read your mail rules.')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [token, includeInactive])

  useEffect(() => { void load() }, [load])

  return { rules, mailboxes, anyMailboxBroken, loading, error, refresh: load }
}

/**
 * What one rule actually did, fetched only when a rule is opened.
 *
 * Kept out of the list call on purpose: the list is a page load, this is up to
 * 25 rows per rule and only ever wanted for one at a time.
 */
export function useMailDeliveries(ruleId?: string) {
  const { token } = useAdminAuth()
  const [deliveries, setDeliveries] = useState<MailDelivery[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!token || !ruleId) { setDeliveries([]); return }
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const data = await api.get<{ deliveries: MailDelivery[] }>(
          `${BASE}/rules/${ruleId}/deliveries`, token, { quiet: true },
        )
        if (live) setDeliveries(data.deliveries ?? [])
      } catch {
        if (live) setDeliveries([])
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token, ruleId])

  return { deliveries, loading }
}

/**
 * What the AI step decided about one message.
 *
 * `held` is a working rule doing its job, not a fault, which is why the reason
 * is always present: a member looking at mail that did not arrive is owed the
 * sentence the model actually wrote, not a label.
 */
export type MailJudgeVerdict = {
  /**
   * `routed` is the routing table's answer and is deliberately its own decision
   * rather than a `passed` carrying a key. They are different claims: `passed`
   * says *this rule should act*, `routed` says *this message is that kind of
   * message*, and a screen showing them alike would say "Divo passed it" about
   * a message whose whole outcome was which person got it.
   */
  decision: 'passed' | 'rejected' | 'unavailable' | 'routed'
  reason: string
  /** Absent when the model could not be reached at all. */
  confidence?: number
  /** Which way the rule's own failure setting sent it, when it came to that. */
  appliedFailure?: 'open' | 'closed'
  /** Which branch it named, on a routed rule. `none` means "nothing fits". */
  route?: string
}

export type MailCaught = MailDelivery & {
  ruleId: string
  ruleName: string
  action: Record<string, unknown>
  destination: Record<string, unknown>
  verdict: MailJudgeVerdict | null
}

/**
 * Everything Divo did with this member's mail, across every rule.
 *
 * Failure is carried rather than swallowed. An empty feed and a feed that could
 * not be read look identical, and the first one means "Divo has done nothing",
 * which is the one conclusion this screen must never state without evidence.
 */
export function useCaught(limit = 50) {
  const { token } = useAdminAuth()
  const [caught, setCaught] = useState<MailCaught[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const data = await api.get<{ caught: MailCaught[] }>(
        `${BASE}/caught?limit=${limit}`, token, { quiet: true },
      )
      setCaught(data.caught ?? [])
      setError(null)
    } catch {
      setError('This could not be read, so it is blank rather than empty.')
    } finally {
      setLoading(false)
    }
  }, [token, limit])

  useEffect(() => { void load() }, [load])

  return { caught, loading, error, refresh: load }
}

/**
 * Every message a rule of yours touched in a window, as bare times.
 *
 * Kept apart from `useCaught` because the two answer different questions. The
 * feed answers "what happened to this message" and carries a subject, a sender
 * and a rule, which is why the route caps it at a hundred rows. A calendar
 * answers "when", needs four scalars, and covers a season — and built from the
 * capped feed it drew ordinary empty squares on days the request never reached.
 */
export type MailActivity = {
  status: string
  lastError: string | null
  firstAttemptAt: string
  deliveredAt: string | null
}

export function useCaughtActivity(days: number) {
  const { token } = useAdminAuth()
  const [activity, setActivity] = useState<MailActivity[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const data = await api.get<{ activity: MailActivity[]; truncated: boolean }>(
        `${BASE}/caught/activity?days=${days}`, token, { quiet: true },
      )
      setActivity(data.activity ?? [])
      setTruncated(data.truncated === true)
      setError(null)
    } catch {
      // Carried rather than swallowed: a chart that could not be read and one
      // with nothing in it look identical, and only one of them means "quiet".
      setError('This could not be read, so it is blank rather than empty.')
    } finally {
      setLoading(false)
    }
  }, [token, days])

  useEffect(() => { void load() }, [load])

  return { activity, truncated, loading, error, refresh: load }
}

/* ── Which mailbox a rule can watch ───────────────────
   Mirrors `MailAutomationConnectionResolution` on the tool side, which is the
   authority on this and already got it right: a rule needs a Google account
   **you own** with read, watch and send access; `connectionId` may be omitted
   only when exactly one such account exists; and several is a normal step
   rather than a failure.

   The mistake this replaces was reading `MailboxSubscription` rows instead. A
   subscription is created *by* the first rule, so gating rule creation on one
   meant the first rule could never be made — the page told somebody with Gmail
   connected that they had no mailbox. */

export type { MailboxOption, MailboxResolution } from './mailbox-resolution'

export function useMailboxOptions(): MailboxResolution {
  const { byProvider, loading: connectionsLoading } = useConnections()
  const { mailboxes, loading: mailLoading } = useMailAutomations()

  return useMemo<MailboxResolution>(() => {
    if (connectionsLoading || mailLoading) return { status: 'loading' }
    return resolveMailboxes(byProvider.get('google_workspace')?.connections ?? [], mailboxes)
  }, [byProvider, connectionsLoading, mailboxes, mailLoading])
}

export type MailRuleDryRun = {
  ruleId: string
  name: string
  valid: boolean
  invalidReason?: string | null
  mailboxEmail?: string
  /** How many stored messages were actually readable and judged. */
  consideredCount?: number
  matchedCount?: number
  /**
   * Matched, but older than the rule. The runtime never goes back for these,
   * so they are reported apart from `matchedCount` — folding them in would
   * read as a promise to deliver mail that will never be delivered.
   */
  predatingCount?: number
  /**
   * Needed a body to judge and the body has since been discarded by retention.
   * Neither a match nor a non-match; counting it as either states a certainty
   * nobody has.
   */
  bodyUnavailableCount?: number
  matched?: Array<{
    eventId: string
    occurredAt: string
    from: string | null
    subject: string | null
    predatesRule: boolean
  }>
}

/**
 * "Would this rule have caught anything?"
 *
 * A mail rule is written in a sentence and then waits, and until it fires
 * there is nothing to tell its owner whether they described the mail they
 * meant. This replays the rule over messages already recorded for the mailbox
 * and answers that without sending anything.
 *
 * Triggered rather than fetched on open: it is a question somebody asks, and a
 * dry run that ran on every drawer open would be doing work nobody wanted and
 * showing an answer nobody had asked for.
 */
export function useMailRuleDryRun() {
  const { token } = useAdminAuth()
  const [result, setResult] = useState<MailRuleDryRun | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (ruleId: string) => {
    if (!token) return
    setRunning(true)
    setError(null)
    try {
      const data = await api.post<MailRuleDryRun>(
        `${BASE}/rules/${ruleId}/test`, {}, token, { quiet: true },
      )
      setResult(data)
    } catch {
      // Distinct from "nothing matched". A test that could not run tells you
      // nothing about the rule, and reporting it as zero matches would send
      // somebody rewriting a rule that was never the problem.
      setError('The test could not run. This says nothing about the rule itself.')
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [token])

  const reset = useCallback(() => { setResult(null); setError(null) }, [])

  return { result, running, error, run, reset }
}

/* ── Reading the stored rule ──────────────────────────
   `match`, `action` and `destination` arrive as opaque JSON because that is
   how they are stored. Everything below reads them defensively: a rule written
   by an older build, or one that no longer parses at all, must still render as
   a row saying so rather than blanking the page. */

const str = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * A phrase field is one string, or a list of them any one of which counts.
 *
 * `MailRulePhrase = string | readonly string[]`, and this screen read only the
 * string half — so a rule written as `subjectContains: ["invoice", "receipt"]`
 * rendered no subject line at all, and its owner was shown a rule that matched
 * on strictly less than the one they had asked for.
 */
function phrase(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** `["a"]` → `"a"` · `["a","b","c"]` → `"a", "b" or "c"`. */
function anyOf(values: string[]): string {
  const quoted = values.map((value) => `"${value}"`)
  if (quoted.length === 1) return quoted[0]!
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`
}

const WEEKDAY_LABEL: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
}
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const

/**
 * "on weekdays between 09:00 and 18:00 (Asia/Kolkata)".
 *
 * The window is half-open and an `end` at or before `start` wraps past
 * midnight, which is the only way to say "outside office hours" — so a wrapped
 * window has to say so, or it reads as an empty range that could never match.
 */
function windowClause(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const window = raw as Record<string, unknown>
  const start = str(window, 'start')
  const end = str(window, 'end')
  const zone = str(window, 'timeZone')
  if (!start || !end || !zone) return null

  const days = Array.isArray(window['days'])
    ? window['days'].filter((d): d is string => typeof d === 'string' && d in WEEKDAY_LABEL)
    : []
  const weekdaysOnly = days.length === 5 && WEEKDAYS.every((d) => days.includes(d))
  const when = days.length === 0 || days.length === 7
    ? 'any day'
    : weekdaysOnly
      ? 'on weekdays'
      : days.length === 2 && days.includes('sat') && days.includes('sun')
        ? 'at weekends'
        : `on ${days.map((d) => WEEKDAY_LABEL[d]).join(', ')}`

  // Half-open, and the string comparison is safe because both sides are HH:MM.
  const wraps = end <= start
  return wraps
    ? `arrives ${when} after ${start} or before ${end} (${zone})`
    : `arrives ${when} between ${start} and ${end} (${zone})`
}

/**
 * The rule's conditions as sentence fragments, in the order a person reads
 * them. Every condition must hold — the matcher is AND-only, with no way to
 * express "or" between clauses, which is worth showing rather than implying.
 *
 * All eight stored conditions are rendered. Four of them used to be dropped
 * silently, which is worse than showing nothing: a rule carrying `notFrom` and
 * a rate limit was displayed as an unrestricted forward of everything from the
 * domain, so the screen stated a rule its owner had never written.
 */
export function matchClauses(match: Record<string, unknown>): string[] {
  const clauses: string[] = []

  // A leading @ covers the domain and everything under it: `@acme.com` matches
  // `billing@acme.com` and `receipts@mail.acme.com` alike. This screen said the
  // opposite until the matcher was changed and nobody came back for the
  // sentence — so a member reading their own rule was told it would miss
  // exactly the transactional mail it was written to catch.
  const from = str(match, 'from')
  if (from) {
    clauses.push(from.startsWith('@')
      ? `sent from ${from.slice(1)} or any of its subdomains`
      : `sent by ${from}`)
  }

  // Matches the union of To, Cc, Bcc and Delivered-To as whole mailboxes.
  // Rules stored before that change carry `to` alone and degrade to it.
  const to = str(match, 'to')
  if (to) clauses.push(`addressed to ${to}`)

  const subject = phrase(match, 'subjectContains')
  if (subject.length > 0) clauses.push(`subject contains ${anyOf(subject)}`)

  const body = phrase(match, 'bodyContains')
  if (body.length > 0) clauses.push(`body contains ${anyOf(body)}`)

  if (typeof match['hasAttachment'] === 'boolean') {
    clauses.push(match['hasAttachment'] ? 'has an attachment' : 'has no attachment')
  }

  const window = windowClause(match['activeWindow'])
  if (window) clauses.push(window)

  // Exclusions last, and phrased as exceptions rather than conditions. They can
  // only ever narrow what a rule catches, and an unreadable `From` header fails
  // the exclusion rather than passing it.
  const notFrom = str(match, 'notFrom')
  if (notFrom) {
    clauses.push(notFrom.startsWith('@')
      ? `not from ${notFrom.slice(1)} or any of its subdomains`
      : `not from ${notFrom}`)
  }

  const notSubject = phrase(match, 'notSubjectContains')
  if (notSubject.length > 0) clauses.push(`subject does not contain ${anyOf(notSubject)}`)

  return clauses
}

/**
 * What the rule does once something matches.
 *
 * `organize` is an action rather than a destination — it acts on the message
 * where it already is, and its destination is stored as `{ type: 'none' }`.
 * Reading the destination alone therefore reported every organize rule as
 * pointing "somewhere Divo can no longer read", which is the sentence reserved
 * for genuine corruption.
 */
export type MailAction =
  | { kind: 'forward'; rateLimitPerHour: number | null }
  | { kind: 'deliver'; rateLimitPerHour: number | null }
  | { kind: 'organize'; label: string | null; archive: boolean; markRead: boolean }
  | { kind: 'unknown' }

export function readAction(action: Record<string, unknown>): MailAction {
  const type = str(action, 'type')
  const ceiling = typeof action['rateLimitPerHour'] === 'number' && action['rateLimitPerHour'] > 0
    ? action['rateLimitPerHour']
    : null

  if (type === 'forward') return { kind: 'forward', rateLimitPerHour: ceiling }
  if (type === 'deliver') return { kind: 'deliver', rateLimitPerHour: ceiling }
  if (type === 'organize') {
    return {
      kind: 'organize',
      label: str(action, 'label'),
      archive: action['archive'] === true,
      markRead: action['markRead'] === true,
    }
  }
  return { kind: 'unknown' }
}

/**
 * The ceiling, stated with its consequence.
 *
 * Over the limit a message is **dropped**, not held — so "at most 5 an hour"
 * on its own would be read as a queue, and somebody would go looking for the
 * sixth message that was never coming. `organize` carries no ceiling: it sends
 * nothing, so a burst is the correct response to a burst.
 */
export function rateLimitClause(action: Record<string, unknown>): string | null {
  const read = readAction(action)
  if (read.kind === 'organize' || read.kind === 'unknown') return null
  if (read.rateLimitPerHour === null) return null
  return `at most ${read.rateLimitPerHour} an hour — over that, mail is dropped rather than queued`
}

export type MailRouteBranch = {
  key: string
  when: string
  destination: MailDestination
}

export type MailDestination =
  | { kind: 'email'; email: string; label: string }
  | { kind: 'lark'; chatId: string; label: string }
  | { kind: 'lark_dm'; label: string }
  | { kind: 'organize'; label: string }
  /**
   * Several recipients, one of which Divo picks per message.
   *
   * `label` is the one-line form every existing caller already prints; the
   * branches are beside it for the screens that show the whole table. Callers
   * that only know the four shapes above therefore keep working and say
   * something true, rather than falling to `unknown` and telling a member their
   * rule points "somewhere Divo can no longer read".
   */
  | {
      kind: 'routed'
      routes: MailRouteBranch[]
      otherwise: MailDestination | null
      label: string
    }
  | { kind: 'unknown'; label: string }

/**
 * Where a match ends up, read from the destination and the action together.
 * Neither is sufficient alone — an organize rule's destination says `none`,
 * and a forward's action says nothing about the address.
 */
export function readDestination(
  destination: Record<string, unknown>,
  action?: Record<string, unknown>,
): MailDestination {
  const type = str(destination, 'type')
  if (type === 'email') {
    const email = str(destination, 'email')
    if (email) return { kind: 'email', email, label: email }
  }
  if (type === 'lark_chat') {
    const chatId = str(destination, 'chatId')
    if (chatId) return { kind: 'lark', chatId, label: 'a Lark chat' }
  }
  // Said as "you", not as an id. The open id is meaningless to read and the
  // only fact that matters about this destination is that nobody else sees it.
  if (type === 'lark_dm') return { kind: 'lark_dm', label: 'you, on Lark' }

  if (type === 'routed') {
    const raw = Array.isArray(destination['routes']) ? destination['routes'] : []
    const routes: MailRouteBranch[] = raw.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const row = entry as Record<string, unknown>
      const leaf = row['destination']
      if (!leaf || typeof leaf !== 'object') return []
      return [{
        // A branch with no description is a branch nothing can be sorted into,
        // so it reads as empty rather than being dropped — a table that renders
        // five rows where six were saved is worse than one that shows a blank.
        key: str(row, 'key') ?? '',
        when: str(row, 'when') ?? '',
        destination: readDestination(leaf as Record<string, unknown>),
      }]
    })
    const rest = destination['otherwise']
    const otherwise = rest && typeof rest === 'object'
      ? readDestination(rest as Record<string, unknown>)
      : null
    return {
      kind: 'routed',
      routes,
      otherwise,
      // Counted rather than listed. This string is printed in table rows and
      // summary lines built for one recipient, and six addresses in one of them
      // would push everything else off the screen.
      label: routes.length === 1
        ? 'one of 1 person Divo picks'
        : `one of ${routes.length} people Divo picks`,
    }
  }

  if (type === 'none' && action) {
    const read = readAction(action)
    if (read.kind === 'organize') {
      const done: string[] = []
      if (read.label) done.push(`labelled “${read.label}”`)
      if (read.archive) done.push('archived')
      if (read.markRead) done.push('marked read')
      return {
        kind: 'organize',
        // An organize rule with nothing switched on is a real stored shape and
        // it does nothing at all, which is worth saying outright.
        label: done.length === 0
          ? 'kept in your inbox, untouched'
          : `${done.join(' and ')} in your Gmail`,
      }
    }
  }

  return { kind: 'unknown', label: 'somewhere Divo can no longer read' }
}

/**
 * Whether a rule sends mail out of the mailbox's own domain.
 *
 * This is the one property of a mail rule worth surfacing before anything
 * else. A forward carries the whole message — headers, body and attachments,
 * unchanged — so a rule pointing outside the company is a standing export of
 * whatever matches it, and it was created by asking Divo in a sentence. The
 * comparison is domain-to-domain rather than a company address book because
 * the mailbox domain is the only thing this screen can actually know.
 */
export function leavesOrganisation(rule: MailRule): boolean {
  const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() ?? ''
  const mailbox = domainOf(rule.mailboxEmail)
  if (mailbox.length === 0) return false
  // Every branch, not the first. A routed rule sends to several people, and one
  // external branch among five makes the whole rule a standing export — which
  // is the single thing this flag exists to surface.
  return destinationEmails(readDestination(rule.destination))
    .some((email) => {
      const to = domainOf(email)
      return to.length > 0 && to !== mailbox
    })
}

/** Every address a destination reaches, flattening a routing table. */
export function destinationEmails(destination: MailDestination): string[] {
  if (destination.kind === 'email') return [destination.email]
  if (destination.kind !== 'routed') return []
  return [
    ...destination.routes.flatMap((route) => destinationEmails(route.destination)),
    ...(destination.otherwise ? destinationEmails(destination.otherwise) : []),
  ]
}

/* ── Creating a rule ──────────────────────────────────
   `POST /rules` runs the same sequence the agent's tool runs — it is literally
   the same function — so every refusal below is one the agent would also give,
   worded the same way. The server's sentence is preferred over anything this
   file could invent, because it is the one that knows which check failed. */

export type MailRuleDraft = {
  connectionId?: string
  name: string
  match: Record<string, unknown>
  destination:
    | { type: 'email'; email: string }
    | { type: 'lark_chat'; chatId: string }
    /* No id. The server substitutes the signed-in member's own open id, so a
       browser cannot name somebody else's DM. */
    | { type: 'lark_dm' }
    | { type: 'organize'; label?: string; archive?: boolean; markRead?: boolean }
    /**
     * Several recipients and what kind of message each one gets.
     *
     * `otherwise` absent means hold — nothing is sent and the member sees it in
     * What Divo caught. There is deliberately no value that drops a message
     * silently.
     */
    | {
        type: 'routed'
        routes: Array<{ key: string; when: string; destination: { type: 'email'; email: string } }>
        otherwise?: 'hold' | { type: 'email'; email: string }
      }
  rateLimitPerHour?: number
  /**
   * The rule's AI step. Absent means it has none — and on an edit that means
   * *remove* it, because both routes take the whole rule rather than a patch.
   * The form always sends what is on screen, so this is only ever wrong if the
   * form forgets to seed it from the stored rule.
   */
  judge?: { question: string; onFailure?: 'open' | 'closed' }
}

export type MailRuleCreateState = {
  saving: boolean
  /** The server's own sentence. Null until something is refused. */
  error: string | null
  /** Which check refused, for the rare case the UI should act rather than tell. */
  code: string | null
  /**
   * A forward that leaves the company, now waiting on a named person.
   *
   * Not an error, and kept apart from one for that reason: nothing the member
   * typed is wrong, no rule exists yet, and the only thing left to do is wait.
   */
  pending: MailRulePending | null
}

/**
 * A forward waiting on a named person, and where they will find it.
 *
 * `deliveredVia` is the server's answer, not a guess: whether a Lark card went
 * out depends on the approver having a Lark account and on the deployment
 * having card delivery switched on, and this screen can see neither. Telling
 * someone their manager was asked in Lark when no card was sent sends them to
 * look somewhere empty, which is how a working approval gets reported as a
 * broken one.
 */
export type MailRulePending = {
  approverName: string
  destination: string
  reused: boolean
  deliveredVia: 'lark' | 'desktop'
}

/** The pending payload as it arrives, with the server's own wording preserved. */
const readPending = (
  data: { approverName?: string; destination?: string; reused?: boolean; deliveredVia?: string },
  fallbackDestination: string,
): MailRulePending => ({
  approverName: data.approverName ?? 'your manager',
  destination: data.destination ?? fallbackDestination,
  reused: data.reused === true,
  // Anything unrecognised reads as the inbox: that is the surface every
  // approver has, so it is the answer that stays true.
  deliveredVia: data.deliveredVia === 'lark' ? 'lark' : 'desktop',
})

/**
 * Turning a rule on has three endings, not two.
 *
 * The third — asked, and waiting — reads as success on the wire (202) and as
 * failure to anybody looking only for a rule id. Naming it here is what stops
 * the wizard navigating to a rule that was never created.
 */
export type MailRuleCreateOutcome =
  /**
   * `existing` is what the member could not otherwise know.
   *
   * Creating is an upsert on a key derived from the rule's own content, so
   * asking for a rule that already exists returns it, and asking for one that
   * was archived brings it back. Both are the right behaviour and neither used
   * to be said — so somebody who archived a rule in March and built the same
   * one in August landed on a "new" rule already carrying five months of
   * deliveries.
   */
  | { kind: 'created'; ruleId: string; existing: 'active' | 'paused' | 'archived' | null }
  | ({ kind: 'pending_approval' } & MailRulePending)
  | { kind: 'refused' }

export function useCreateMailRule() {
  const { token } = useAdminAuth()
  const [state, setState] = useState<MailRuleCreateState>({
    saving: false, error: null, code: null, pending: null,
  })

  const create = useCallback(async (draft: MailRuleDraft): Promise<MailRuleCreateOutcome> => {
    if (!token) return { kind: 'refused' }
    setState({ saving: true, error: null, code: null, pending: null })
    try {
      const data = await api.post<{
        ruleId?: string
        mailboxEmail?: string
        status?: string
        approverName?: string
        destination?: string
        reused?: boolean
        deliveredVia?: string
        existing?: 'active' | 'paused' | 'archived' | null
      }>(`${BASE}/rules`, draft, token, { quiet: true })

      // Read from the body rather than the status code: `api.post` hands back
      // the payload and nothing else, and the payload already says which of the
      // two endings this is.
      if (data.status === 'pending_approval') {
        const pending = readPending(
          data,
          draft.destination.type === 'email' ? draft.destination.email : '',
        )
        setState({ saving: false, error: null, code: 'pending_approval', pending })
        return { kind: 'pending_approval', ...pending }
      }

      setState({ saving: false, error: null, code: null, pending: null })
      return data.ruleId
        ? { kind: 'created', ruleId: data.ruleId, existing: data.existing ?? null }
        : { kind: 'refused' }
    } catch (error) {
      // Six refusals with six different remedies, and the remedy is the only
      // part a member can act on — so the server's message is shown verbatim
      // rather than replaced with a generic failure.
      const message = error instanceof Error && error.message.length > 0
        ? error.message
        : 'That rule could not be created.'
      const code = typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : null
      setState({ saving: false, error: message, code, pending: null })
      return { kind: 'refused' }
    }
  }, [token])

  return { ...state, create }
}

/* ── Changing a rule that already exists ──────────────
   The same form that creates a rule edits one, so the same draft shape goes up.
   What differs is the ending: an edit can land on top of another rule watching
   the same mailbox, and that collision has two shapes worth telling apart —
   the rule it collides with may be live, or it may be sitting archived where
   nobody would think to look for it. */

export type MailRuleUpdateOutcome =
  /**
   * `resumed` because editing a paused rule starts it again.
   *
   * That is deliberate and it is documented in the tool's own instructions, but
   * it was done in silence here: somebody who paused a rule because it was
   * misbehaving, then corrected it, got "Saved" and no hint their mail was
   * moving again. The server has said which of the two happened since the
   * permission fix; this screen was still throwing the answer away.
   */
  | { kind: 'saved'; ruleId: string; resumed: boolean }
  /** The edit changed the destination to somewhere outside the company. */
  | ({ kind: 'pending_approval' } & MailRulePending)
  /**
   * These conditions already belong to another rule on this mailbox.
   *
   * `archived` is not a detail. A collision with a live rule is something the
   * member can see and reason about; a collision with an archived one is a
   * rule they cannot see from here at all, and "that already exists" without
   * the word archived reads as Divo being wrong.
   */
  | {
      kind: 'duplicate'
      ruleId: string
      name: string
      archived: boolean
      /** What the server said. It knows which of the two collisions this is. */
      message: string
    }
  | { kind: 'refused' }

export type MailRuleUpdateState = {
  saving: boolean
  error: string | null
  pending: MailRulePending | null
  duplicate: { ruleId: string; name: string; archived: boolean; message: string } | null
}

export function useUpdateMailRule() {
  const { token } = useAdminAuth()
  const [state, setState] = useState<MailRuleUpdateState>({
    saving: false, error: null, pending: null, duplicate: null,
  })

  const update = useCallback(async (
    ruleId: string, draft: MailRuleDraft,
  ): Promise<MailRuleUpdateOutcome> => {
    if (!token) return { kind: 'refused' }
    setState({ saving: true, error: null, pending: null, duplicate: null })
    try {
      const data = await api.put<{
        ruleId?: string
        status?: string
        /** True when this edit took the rule off pause. See the outcome type. */
        resumed?: boolean
        approverName?: string
        destination?: string
        reused?: boolean
        deliveredVia?: string
        conflictRuleId?: string
        conflictRuleName?: string
        conflictArchived?: boolean
      }>(`${BASE}/rules/${ruleId}`, draft, token, { quiet: true })

      if (data.status === 'pending_approval') {
        const pending = readPending(
          data,
          draft.destination.type === 'email' ? draft.destination.email : '',
        )
        setState({ saving: false, error: null, pending, duplicate: null })
        return { kind: 'pending_approval', ...pending }
      }

      setState({ saving: false, error: null, pending: null, duplicate: null })
      return { kind: 'saved', ruleId: data.ruleId ?? ruleId, resumed: data.resumed === true }
    } catch (error) {
      /*
       * The duplicate arrives here, not above.
       *
       * A collision is answered with a 409, and `api.put` throws on any
       * non-2xx — so the `data.status === 'duplicate'` test that used to sit
       * inside the `try` could never run, and the one refusal this screen has
       * a real remedy for was reported as "that change could not be saved".
       *
       * Matched on the server's own code rather than on the status, because
       * `rule_archived` is a 409 too and its remedy is the opposite one.
       */
      if (error instanceof ApiError
        && (error.code === 'duplicate' || error.code === 'duplicate_archived')) {
        const duplicate = {
          // The server names neither, so neither is invented. The message it
          // sent says what to do, and that is what the screen shows.
          ruleId: '',
          name: 'another rule',
          archived: error.code === 'duplicate_archived',
          message: error.message,
        }
        setState({ saving: false, error: null, pending: null, duplicate })
        return { kind: 'duplicate', ...duplicate }
      }
      const message = error instanceof Error && error.message.length > 0
        ? error.message
        : 'That change could not be saved.'
      setState({ saving: false, error: message, pending: null, duplicate: null })
      return { kind: 'refused' }
    }
  }, [token])

  return { ...state, update }
}

/**
 * Pause, resume, archive.
 *
 * Archive rather than delete, and the word is the honest one: an archived rule
 * keeps its identity, so re-creating the identical rule brings that row back
 * rather than making a second one beside it. Calling it "delete" would promise
 * a disappearance that does not happen — the rule is still there under All.
 */
export type MailRuleChange = 'pause' | 'resume' | 'archive'

export function useMailRuleStatus() {
  const { token } = useAdminAuth()
  const [pending, setPending] = useState<MailRuleChange | null>(null)
  const [error, setError] = useState<string | null>(null)

  const change = useCallback(async (ruleId: string, next: MailRuleChange): Promise<boolean> => {
    if (!token) return false
    setPending(next)
    setError(null)
    try {
      if (next === 'archive') {
        await api.delete(`${BASE}/rules/${ruleId}`, {}, token, { quiet: true })
      } else {
        await api.post(`${BASE}/rules/${ruleId}/${next}`, {}, token, { quiet: true })
      }
      return true
    } catch (e) {
      // The server distinguishes "not yours", "not real" and "nothing would
      // poll this mailbox anyway", and only its sentence knows which.
      setError(e instanceof Error && e.message.length > 0
        ? e.message
        : 'That change could not be saved.')
      return false
    } finally {
      setPending(null)
    }
  }, [token])

  return { pending, error, change }
}

/* ── Describing a rule, and testing it before it exists ── */

export type MailRuleCompiled = {
  status: 'compiled'
  name: string
  match: Record<string, unknown>
  destination:
    | { type: 'email'; email: string }
    | { type: 'lark_dm' }
    | { type: 'organize'; label?: string; archive?: boolean; markRead?: boolean }
    /** Different people for different kinds of the same mail. */
    | {
        type: 'routed'
        routes: Array<{ key: string; when: string; destination: { type: 'email'; email: string } }>
        otherwise?: 'hold' | { type: 'email'; email: string }
      }
  rateLimitPerHour?: number
  /**
   * The part of the sentence no filter could express, kept as a question the
   * rule asks about each matched message. Present only when the sentence asked
   * for a judgement — carry it onto the draft, because dropping it turns "only
   * the ones that actually need me" into "all of them".
   */
  judge?: { question: string; onFailure?: 'open' | 'closed' }
  /** What Divo deliberately dropped from the sentence. */
  notes?: string[]
} | { status: 'unclear'; reason: string } | { status: 'unavailable'; reason: string }

/**
 * One sentence in, a draft out — and never a guess.
 *
 * `unclear` is a first-class answer, not a failure: Divo names the piece it
 * needs ("say the domain, e.g. @amazon.in") rather than inventing one. A
 * guessed rule is wrong while being reported as right, which is the one thing
 * this whole screen exists to avoid.
 */
export function useCompileMailRule() {
  const { token } = useAdminAuth()
  const [result, setResult] = useState<MailRuleCompiled | null>(null)
  const [running, setRunning] = useState(false)

  const compile = useCallback(async (sentence: string, connectionId?: string) => {
    if (!token) return
    setRunning(true)
    try {
      const data = await api.post<MailRuleCompiled>(
        `${BASE}/compile`,
        { sentence, ...(connectionId ? { connectionId } : {}) },
        token,
        { quiet: true },
      )
      setResult(data)
    } catch {
      setResult({ status: 'unavailable', reason: 'Divo could not read that just now.' })
    } finally {
      setRunning(false)
    }
  }, [token])

  return { result, running, compile, reset: useCallback(() => setResult(null), []) }
}

export type MailRulePreview = {
  /** False when Divo has never watched this inbox — no evidence either way. */
  watched: boolean
  consideredCount: number
  matchedCount: number
  bodyUnavailableCount: number
  /**
   * The oldest message the replay reached, so a count can be read as a span.
   *
   * "Read 11 · none matched" is true and reads as a broken rule. Eleven may be
   * every message Divo has ever recorded here — the conditions could be perfect
   * and there is simply nothing to catch yet.
   */
  coversSince?: string
  /** At the ceiling, "none matched" is about the recent past, not the mailbox. */
  truncated?: boolean
  matched: Array<{ eventId: string; occurredAt: string; from: string; subject: string }>
}

/** Replays unsaved conditions over mail Divo has already seen. Sends nothing. */
export function usePreviewMailRule() {
  const { token } = useAdminAuth()
  const [result, setResult] = useState<MailRulePreview | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview = useCallback(async (match: Record<string, unknown>, connectionId?: string) => {
    if (!token) return
    setRunning(true)
    setError(null)
    try {
      const data = await api.post<MailRulePreview>(
        `${BASE}/preview`,
        { match, ...(connectionId ? { connectionId } : {}) },
        token,
        { quiet: true },
      )
      setResult(data)
    } catch (e) {
      // A test that could not run says nothing about the conditions, and
      // reporting it as zero matches would send somebody rewriting a rule that
      // was never the problem.
      setError(e instanceof Error && e.message ? e.message : 'The check could not run.')
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [token])

  return { result, running, error, preview }
}
