/**
 * Whose mail leaves the company, and where it goes.
 *
 * The one question about Mail Ops nobody could ask. Every member can see their
 * own rules, and their own Mail page marks the ones pointing outside their
 * domain — but a forward is a standing export of whatever matches it, created
 * by asking Divo in a sentence, and there was no way to find out how many exist
 * across a company or where they point. Somebody changes team, or leaves, and
 * their rules keep forwarding to an address nobody has looked at since it was
 * approved.
 *
 * Admin-guarded on the server: this crosses every member, so it is not on the
 * member-auth router the personal reads live on.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

const BASE = '/api/admin/mail-governance'

export type CompanyForward = {
  ruleId: string
  name: string
  status: string
  mailboxEmail: string
  ownerUserId: string
  ownerName: string | null
  ownerEmail: string | null
  destinationEmail: string
  /** Decided on the server, by the same function that gates a create. */
  external: boolean
  match: Record<string, unknown>
  createdAt: string
  /** Delivered messages over the rule's whole life, not a 30-day window. */
  deliveredCount: number
  lastDeliveredAt: string | null
}

export type MailGovernance = {
  forwards: CompanyForward[]
  /** Every email forward, external or not. */
  totalForwards: number
  externalCount: number
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useCompanyForwards(
  token?: string,
  options: { includeInactive?: boolean; scope?: 'external' | 'all' } = {},
): MailGovernance {
  const [forwards, setForwards] = useState<CompanyForward[]>([])
  const [totalForwards, setTotalForwards] = useState(0)
  const [externalCount, setExternalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { includeInactive = false, scope = 'external' } = options

  const load = useCallback(async () => {
    if (!token) return
    try {
      const query = new URLSearchParams({
        scope,
        ...(includeInactive ? { includeInactive: 'true' } : {}),
      })
      const data = await api.get<{
        forwards: CompanyForward[]
        totalForwards: number
        externalCount: number
      }>(`${BASE}/forwards?${query}`, token, { quiet: true })
      setForwards(data.forwards ?? [])
      setTotalForwards(data.totalForwards ?? 0)
      setExternalCount(data.externalCount ?? 0)
      setError(null)
    } catch {
      // An audit view that fails silently is worse than one that is absent: an
      // empty list here reads as "nothing leaves the company", which is the one
      // conclusion this page must never state without evidence.
      setError('These rules could not be read, so this list is blank rather than empty.')
    } finally {
      setLoading(false)
    }
  }, [token, includeInactive, scope])

  useEffect(() => { void load() }, [load])

  return { forwards, totalForwards, externalCount, loading, error, refresh: load }
}

/* ── The brief ────────────────────────────────────────
   A member's standing summary of their own mailbox. Lives in this file rather
   than beside the rule hooks because it is not about rules — it reports on the
   mailbox as a whole, and a member can have one with no rules running. */

export type MailBrief = {
  briefId: string
  mailboxEmail: string
  /** Local `HH:MM`, in `timeZone`. */
  times: string[]
  days: string[]
  timeZone: string
  status: string
  nextRunAt: string | null
  lastRunAt: string | null
}

const MAIL_BASE = '/api/mail-automations'

/**
 * `brief` is `null` for a member who has no watched mailbox yet.
 *
 * That is an ordinary state — Divo starts watching at the first rule — so it is
 * kept apart from `error`, which means the read itself failed. Showing "you have
 * no brief" because a request timed out would send somebody to set up a thing
 * they already have.
 */
export function useMailBrief(token?: string) {
  const [brief, setBrief] = useState<MailBrief | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const data = await api.get<{ brief: MailBrief | null }>(
        `${MAIL_BASE}/brief`, token, { quiet: true },
      )
      setBrief(data.brief ?? null)
      setError(null)
    } catch {
      setError('Your brief settings could not be read.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async (next: {
    times: string[]; days: string[]; timeZone: string; paused: boolean
  }): Promise<boolean> => {
    if (!token) return false
    try {
      await api.patch(`${MAIL_BASE}/brief`, next, token, { quiet: true })
      await load()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change could not be saved.')
      return false
    }
  }, [token, load])

  return { brief, loading, error, refresh: load, save }
}
