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
 * No userId anywhere. Every query is pinned server-side to the signed-in
 * member, so there is nothing to pass and nothing to get wrong.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useConnections, type LiveConnection } from './use-connections'

const BASE = '/api/mail-automations'

/** Worst first. `waiting` is a healthy rule that has simply not matched yet. */
export type MailRuleState =
  | 'broken' | 'blocked' | 'paused' | 'archived' | 'working' | 'waiting'

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
  createdAt: string
  lastDeliveredAt: string | null
  /** Counts over the last 30 days, not all time. */
  deliveredCount: number
  failingCount: number
  abandonedCount: number
  /** Matched the rule, then was refused. Recorded rather than dropped. */
  blockedCount: number
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

export type MailboxOption = {
  connectionId: string
  /** The address, or the connection's label when Google gave us no email. */
  accountEmail: string
  accountName: string | null
  access: string
  /** A subscription already exists, i.e. Divo is watching this inbox today. */
  watched: boolean
  activeRuleCount: number
}

export type MailboxResolution =
  | { status: 'loading' }
  /** No Google account you own. `none_accessible`. */
  | { status: 'none' }
  /** Owned, but shared read-only or missing Gmail scopes. `insufficient_access`. */
  | { status: 'insufficient'; options: MailboxOption[] }
  | { status: 'one'; option: MailboxOption }
  /** `google_workspace_connection_selection_required`. */
  | { status: 'choose'; options: MailboxOption[] }

/**
 * Read, watch and send. A connection shared with this person read-only can be
 * used to look at mail and not to forward any, which is a different problem
 * from having no account and has a different remedy — so it is not filtered
 * away silently, it is reported as its own state.
 */
const canRunMail = (connection: LiveConnection): boolean =>
  connection.ownerType === 'user' && connection.access !== 'read_only'

export function useMailboxOptions(): MailboxResolution {
  const { byProvider, loading: connectionsLoading } = useConnections()
  const { mailboxes, loading: mailLoading } = useMailAutomations()

  return useMemo<MailboxResolution>(() => {
    if (connectionsLoading || mailLoading) return { status: 'loading' }

    const google = byProvider.get('google_workspace')
    const owned = (google?.connections ?? []).filter((c) => c.ownerType === 'user')
    const usable = owned.filter(canRunMail)

    if (usable.length === 0) {
      return owned.length > 0
        ? { status: 'insufficient', options: owned.map((c) => toOption(c, mailboxes)) }
        : { status: 'none' }
    }

    const options = usable.map((c) => toOption(c, mailboxes))
    // Watched inboxes first: somebody with two accounts almost always means the
    // one Divo is already working on, and it is the only ordering here that
    // carries information rather than reproducing whatever Google returned.
    options.sort((a, b) => Number(b.watched) - Number(a.watched))

    return options.length === 1 ? { status: 'one', option: options[0]! } : { status: 'choose', options }
  }, [byProvider, connectionsLoading, mailboxes, mailLoading])
}

function toOption(connection: LiveConnection, mailboxes: MailboxHealth[]): MailboxOption {
  const email = connection.accountEmail ?? connection.label
  const health = mailboxes.find(
    (m) => m.mailboxEmail.toLowerCase() === email.toLowerCase(),
  )
  return {
    connectionId: connection.connectionId,
    accountEmail: email,
    accountName: connection.accountName,
    access: connection.access,
    watched: health !== undefined,
    activeRuleCount: health?.activeRuleCount ?? 0,
  }
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

export type MailDestination =
  | { kind: 'email'; email: string; label: string }
  | { kind: 'lark'; chatId: string; label: string }
  | { kind: 'lark_dm'; label: string }
  | { kind: 'organize'; label: string }
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
  const destination = readDestination(rule.destination)
  if (destination.kind !== 'email') return false
  const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() ?? ''
  const to = domainOf(destination.email)
  const mailbox = domainOf(rule.mailboxEmail)
  return to.length > 0 && mailbox.length > 0 && to !== mailbox
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
  rateLimitPerHour?: number
}

export type MailRuleCreateState = {
  saving: boolean
  /** The server's own sentence. Null until something is refused. */
  error: string | null
  /** Which check refused, for the rare case the UI should act rather than tell. */
  code: string | null
}

export function useCreateMailRule() {
  const { token } = useAdminAuth()
  const [state, setState] = useState<MailRuleCreateState>({
    saving: false, error: null, code: null,
  })

  const create = useCallback(async (draft: MailRuleDraft): Promise<string | null> => {
    if (!token) return null
    setState({ saving: true, error: null, code: null })
    try {
      const data = await api.post<{ ruleId: string; mailboxEmail: string }>(
        `${BASE}/rules`, draft, token, { quiet: true },
      )
      setState({ saving: false, error: null, code: null })
      return data.ruleId
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
      setState({ saving: false, error: message, code })
      return null
    }
  }, [token])

  return { ...state, create }
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
