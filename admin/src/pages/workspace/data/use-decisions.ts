/**
 * What Divo is waiting to hear from you.
 *
 * This replaces `use-approvals`, which read a list of tool calls and offered
 * two buttons against each. The rows it reads are the same rows — a manager
 * approval written last month arrives here as a one-question decision with two
 * options — but they arrive as questions now, so a request that needs a choice
 * of three or a sentence typed is expressible instead of being built somewhere
 * else with its own cache and its own card.
 *
 * One endpoint for the whole app. `/api/desktop/approvals` still exists and
 * still answers, and is deliberately left to the installed Desktop clients it
 * was written for.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import type { Decision, DecisionAnswer } from '../decisions/decision'

export type { Decision, DecisionAnswer } from '../decisions/decision'

export type SettleOutcome =
  | { ok: true; verdict: 'approved' | 'rejected'; summary: string }
  | { ok: false; reason: string; message: string }

type Open = { awaitingMe: Decision[]; requestedByMe: Decision[] }

export function useDecisions(options: { poll?: number } = {}) {
  const { token } = useAdminAuth()
  const [open, setOpen] = useState<Open>({ awaitingMe: [], requestedByMe: [] })
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState<string | null>(null)
  const poll = options.poll

  const load = useCallback(async () => {
    if (!token) return
    try {
      const data = await api.get<Open>('/api/web-chat/decisions', token, { quiet: true, raw: true })
      setOpen({ awaitingMe: data.awaitingMe ?? [], requestedByMe: data.requestedByMe ?? [] })
    } catch {
      setOpen({ awaitingMe: [], requestedByMe: [] })
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  /* A decision can also be answered on a Lark card, so a thread left open needs
     to find out that the question it is showing is gone. Off unless a caller
     asks for it: most screens read this once and are done. */
  useEffect(() => {
    if (!poll || !token) return
    const timer = window.setInterval(() => { void load() }, poll)
    return () => window.clearInterval(timer)
  }, [poll, token, load])

  const settle = useCallback(async (
    decisionId: string,
    answer: DecisionAnswer,
  ): Promise<SettleOutcome> => {
    if (!token) return { ok: false, reason: 'no_session', message: 'You are not signed in.' }
    setSending(decisionId)
    try {
      const outcome = await api.post<SettleOutcome>(
        `/api/web-chat/decisions/${encodeURIComponent(decisionId)}`,
        answer,
        token,
        { quiet: true, raw: true },
      )
      // Refetch either way. An answer that lost the race to a Lark card is
      // still a change to what this list should show.
      await load()
      return outcome
    } catch (e) {
      await load()
      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : 'Could not record that.' }
    } finally {
      setSending(null)
    }
  }, [token, load])

  return { ...open, loading, sending, settle, refresh: load }
}
