/**
 * The approval inbox — the same decisions the Lark card carries.
 *
 * A card in a chat app used to be the only way an approval could be seen or
 * answered, which quietly made a Lark account part of being a manager. The
 * RuntimeApproval row is the request; the card and this list are two views of
 * it, and either can resolve it.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

/** What `describeToolAction` produced for this call, in plain words. */
export type ToolActionDescription = {
  summary: string
  detail?: string
  [key: string]: unknown
}

export type ApprovalItem = {
  id: string
  toolId: string
  action: string
  status: string
  requestedAt: string
  expiresAt: string | null
  requestedByName: string
  approverName: string
  departmentName: string | null
  deliveredVia: string
  description: ToolActionDescription
  payload: unknown
}

type Inbox = { awaitingMe: ApprovalItem[]; requestedByMe: ApprovalItem[] }

export type DecisionOutcome =
  | { ok: true; decision: 'approved' | 'rejected' }
  | { ok: false; reason: string; message: string }

export function useApprovals() {
  const { token } = useAdminAuth()
  const [inbox, setInbox] = useState<Inbox>({ awaitingMe: [], requestedByMe: [] })
  const [loading, setLoading] = useState(true)
  const [deciding, setDeciding] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      // `raw`: this router answers with the inbox itself, not the usual
      // { success, data } envelope.
      const data = await api.get<Inbox>('/api/desktop/approvals', token, { quiet: true, raw: true })
      setInbox({ awaitingMe: data.awaitingMe ?? [], requestedByMe: data.requestedByMe ?? [] })
    } catch {
      setInbox({ awaitingMe: [], requestedByMe: [] })
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  const decide = useCallback(async (
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<DecisionOutcome> => {
    if (!token) return { ok: false, reason: 'no_session', message: 'You are not signed in.' }
    setDeciding(approvalId)
    try {
      const outcome = await api.post<DecisionOutcome>(
        `/api/desktop/approvals/${approvalId}/decision`,
        { decision },
        token,
        { quiet: true, raw: true },
      )
      // Refetch either way. A decision that lost the race to a Lark card is
      // still a change to what this list should show.
      await load()
      return outcome
    } catch (e) {
      await load()
      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : 'Could not record that.' }
    } finally {
      setDeciding(null)
    }
  }, [token, load])

  return { ...inbox, loading, deciding, decide, refresh: load }
}

/** "in 51 min", "expired", or nothing when the approval has no deadline. */
export function expiryLabel(expiresAt: string | null): { text: string; expired: boolean } | null {
  if (!expiresAt) return null
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return { text: 'Expired', expired: true }
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return { text: `in ${mins} min`, expired: false }
  const hours = Math.round(mins / 60)
  return { text: `in ${hours} hour${hours === 1 ? '' : 's'}`, expired: false }
}

/** "9 minutes ago" from an ISO timestamp. */
export function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
