/**
 * Who actually writes to you — offered while you type a condition.
 *
 * A mail rule fails silently when it is written from memory. Somebody types
 * `acme.com` because that is the brand they know, and the invoices arrive from
 * `billing@mail.acme-billing.com`; the rule is valid, the page says "Waiting",
 * and nothing ever happens. The fix is not better validation — it is never
 * making them guess.
 *
 * TWO SHAPES, NOT ONE. This is the part worth getting right:
 *
 *  - For **From**, the useful unit is usually the *domain*, because Divo's
 *    matcher treats `@acme.com` as covering `receipts@mail.acme.com` too.
 *    Offering only addresses quietly pushes people into narrow rules that miss
 *    the mail they were written for. Both levels are offered, domains first,
 *    each carrying how many senders it covers.
 *  - For **Addressed to**, the useful set is completely different: it is which
 *    of *your own* addresses mail arrives at — your inbox, plus group aliases
 *    like `sales@` or `support@` that land there via Delivered-To or Cc. Nobody
 *    can type those from memory, and they are what makes a `to` rule work.
 *
 * Ranked by volume in the window, never alphabetically, and the count is shown.
 * The count is the evidence that the rule will catch anything at all — a sender
 * with two messages in ninety days is usually not the one they meant.
 *
 * Served by `GET /api/mail-automations/suggestions`, which summarises the
 * `MailEvent` rows Divo already stores for the mailbox. No Gmail call and no
 * quota — the trade is that a mailbox nobody has watched yet has nothing
 * stored, so a first rule still gets an empty list and the screen says why.
 * Closing that needs a cached Gmail scan, which is a separate job.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

export type MailSuggestion = {
  /** Exactly what goes in the field — `@acme.com` keeps the matcher's syntax. */
  value: string
  kind: 'domain' | 'address'
  /** In the window the backend scanned. Shown, because it is the evidence. */
  messageCount: number
  /** Domains only: how many distinct senders sit under it. */
  senderCount?: number
  /** Addresses only, and only in the `to` set: a group alias rather than you. */
  alias?: boolean
}

export type MailSuggestionSets = {
  /** Senders and their domains. Serves From and Except from. */
  from: MailSuggestion[]
  /** Your own addresses and the aliases that reach you. Serves Addressed to. */
  to: MailSuggestion[]
  /** How far back the counts go, as a sentence. */
  window: string
  /**
   * Whether Divo has ever watched this mailbox. False means there is nothing
   * stored to summarise, which is the ordinary state before a first rule — not
   * an error, and not "this person has no correspondents".
   */
  watched: boolean
  loading: boolean
}

export function useMailSuggestions(connectionId: string | null): MailSuggestionSets {
  const { token } = useAdminAuth()
  const [state, setState] = useState<MailSuggestionSets>({
    from: [], to: [], window: '', watched: false, loading: true,
  })

  useEffect(() => {
    if (!token || !connectionId) {
      setState({ from: [], to: [], window: '', watched: false, loading: false })
      return
    }
    let live = true
    void (async () => {
      try {
        const data = await api.get<Omit<MailSuggestionSets, 'loading'>>(
          `/api/mail-automations/suggestions?connectionId=${encodeURIComponent(connectionId)}`,
          token,
          { quiet: true },
        )
        if (!live) return
        setState({
          from: data.from ?? [],
          to: data.to ?? [],
          window: data.window ?? '',
          watched: data.watched ?? false,
          loading: false,
        })
      } catch {
        // Silent, and empty. A field that cannot offer help still works, and a
        // banner about a failed suggestion read would be louder than the thing
        // it is failing to do.
        if (live) setState({ from: [], to: [], window: '', watched: false, loading: false })
      }
    })()
    return () => { live = false }
  }, [token, connectionId])

  return state
}

/**
 * What to offer for the field being typed into.
 *
 * `notFrom` shares From's list on purpose: an exclusion is almost always for a
 * sender inside the domain the rule already catches — `noreply@` under
 * `@acme.com` — so the set that helps is the same one.
 */
export function suggestionsFor(
  field: string,
  sets: MailSuggestionSets,
): MailSuggestion[] {
  if (field === 'to') return sets.to
  if (field === 'from' || field === 'notFrom') return sets.from
  return []
}

/**
 * Filters as somebody types, on the part that identifies the sender.
 *
 * Matching the raw string would rank `@acme.com` below `noreply@acme.com` for
 * the query "acme", because the leading `@` is not where the word starts. The
 * comparison drops it, so typing a brand surfaces its domain first.
 */
export function filterSuggestions(
  suggestions: MailSuggestion[],
  query: string,
): MailSuggestion[] {
  const needle = query.trim().toLowerCase().replace(/^@/, '')
  if (needle.length === 0) return suggestions
  return suggestions.filter((s) => s.value.toLowerCase().replace(/^@/, '').includes(needle))
}
