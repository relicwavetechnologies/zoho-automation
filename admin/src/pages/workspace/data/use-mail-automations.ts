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
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

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
 * The rule's conditions as sentence fragments, in the order a person reads
 * them. Every condition must hold — the matcher is AND-only, with no way to
 * express "or", which is worth showing rather than implying.
 */
export function matchClauses(match: Record<string, unknown>): string[] {
  const clauses: string[] = []
  const from = str(match, 'from')
  // A leading @ covers the domain and everything under it: `@acme.com` matches
  // `billing@acme.com` and `receipts@mail.acme.com` alike. This screen said the
  // opposite until the matcher was changed and nobody came back for the
  // sentence — so a member reading their own rule was told it would miss
  // exactly the transactional mail it was written to catch.
  if (from) {
    clauses.push(from.startsWith('@')
      ? `sent from ${from.slice(1)} or any of its subdomains`
      : `sent by ${from}`)
  }
  const to = str(match, 'to')
  if (to) clauses.push(`addressed to ${to}`)
  const subject = str(match, 'subjectContains')
  if (subject) clauses.push(`subject contains "${subject}"`)
  const body = str(match, 'bodyContains')
  if (body) clauses.push(`body contains "${body}"`)
  if (typeof match['hasAttachment'] === 'boolean') {
    clauses.push(match['hasAttachment'] ? 'has an attachment' : 'has no attachment')
  }
  return clauses
}

export type MailDestination =
  | { kind: 'email'; email: string; label: string }
  | { kind: 'lark'; chatId: string; label: string }
  | { kind: 'unknown'; label: string }

export function readDestination(destination: Record<string, unknown>): MailDestination {
  const type = str(destination, 'type')
  if (type === 'email') {
    const email = str(destination, 'email')
    if (email) return { kind: 'email', email, label: email }
  }
  if (type === 'lark_chat') {
    const chatId = str(destination, 'chatId')
    if (chatId) return { kind: 'lark', chatId, label: 'a Lark chat' }
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
