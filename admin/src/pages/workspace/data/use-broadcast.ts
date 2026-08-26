/**
 * Bulk send, as the Broadcast tab uses it.
 *
 * Two hooks with different clocks, which is the whole reason they are separate.
 * `useBroadcastCandidates` reads a list that changes when somebody gets a
 * WhatsApp message — rarely, and never while a person is mid-compose.
 * `useBroadcastRun` reads a batch that changes every few seconds while it is
 * sending and never again once it is done, so it polls, and stops polling the
 * moment the broadcast reaches a terminal state.
 *
 * That stop is not an optimisation. The gateway has no webhook for batch
 * progress, so a poll is the only way anything finds out — and a poll loop with
 * no exit condition would keep asking about a broadcast that finished last
 * Tuesday for as long as the tab stayed open.
 *
 * `raw: true` throughout, like the sibling follow-ups routes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '@/lib/api'
import { isFinished } from './broadcast-compose'

const BASE = '/api/broadcasts'

/** How often a running broadcast is re-read. Matches the server's own poller. */
const RUN_POLL_MS = 3000

export type Candidate = {
  waChatId: string
  name: string
  isGroup: boolean
  lastMessageAt: string | null
  sessionId: string
  sessionLabel: string
  openFollowUps: number
  /** There is an open follow-up here that we owe them. */
  weOwe: boolean
  /** There is an open follow-up here we are waiting on. */
  waitingOn: boolean
}

export type Broadcast = {
  id: string
  label: string
  body: string
  status: 'queued' | 'sending' | 'completed' | 'cancelled' | 'failed' | string
  total: number
  sent: number
  failed: number
  pending: number
  sessionId: string
  sessionLabel: string
  requestedByName: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

export type BroadcastRecipient = {
  waChatId: string
  displayName: string
  isGroup: boolean
  status: 'pending' | 'sent' | 'failed' | 'cancelled' | string
  error: string | null
  sentAt: string | null
}

/**
 * A read that failed must not look like a read that found nothing.
 *
 * An empty candidate list reads as "this number has no conversations", which
 * would send somebody to the Numbers tab to debug a link that is working fine.
 */
const READ_FAILED = 'This could not be read, so it is blank rather than empty.'

function refusalMessage(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === 'not_permitted') return error.message
    if (error.status === 503 && error.code === 'permission_unavailable') return error.message
    if (error.status === 409 && error.code === 'no_active_department') return error.message
  }
  return null
}

export function useBroadcastCandidates(token?: string, numberId?: string): {
  candidates: Candidate[]
  /** The server had more than it returned. Never hidden — see the note below. */
  truncated: boolean
  loading: boolean
  error: string | null
  refusal: string | null
  refresh: () => void
} {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const query = numberId ? `?number=${encodeURIComponent(numberId)}` : ''
      const data = await api.get<{ candidates: Candidate[]; truncated?: boolean }>(
        `${BASE}/candidates${query}`, token, { quiet: true, raw: true },
      )
      setCandidates(data.candidates ?? [])
      setTruncated(Boolean(data.truncated))
      setError(null)
      setRefusal(null)
    } catch (e) {
      const msg = refusalMessage(e)
      if (msg) {
        setRefusal(msg)
        setError(null)
      } else {
        setRefusal(null)
        setError(READ_FAILED)
      }
    } finally {
      setLoading(false)
    }
  }, [token, numberId])

  useEffect(() => { void load() }, [load])
  return { candidates, truncated, loading, error, refusal, refresh: load }
}

export function useBroadcastHistory(token?: string, numberId?: string): {
  broadcasts: Broadcast[]
  loading: boolean
  error: string | null
  refusal: string | null
  refresh: () => void
} {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const query = numberId ? `?number=${encodeURIComponent(numberId)}` : ''
      const data = await api.get<{ broadcasts: Broadcast[] }>(
        `${BASE}${query}`, token, { quiet: true, raw: true },
      )
      setBroadcasts(data.broadcasts ?? [])
      setError(null)
      setRefusal(null)
    } catch (e) {
      const msg = refusalMessage(e)
      if (msg) {
        setRefusal(msg)
        setError(null)
      } else {
        setRefusal(null)
        setError(READ_FAILED)
      }
    } finally {
      setLoading(false)
    }
  }, [token, numberId])

  useEffect(() => { void load() }, [load])
  return { broadcasts, loading, error, refusal, refresh: load }
}

/** What the review step is told before anything is sent. */
export type Preview = {
  reach: { recipients: number; groups: number; cold: number }
  estimatedSeconds: number
  refusal: string | null
}

export type SendInput = {
  sessionId: string
  label: string
  body: string
  recipients: { waChatId: string; displayName: string; isGroup: boolean }[]
}

export function useBroadcastSend(token?: string): {
  send: (input: SendInput) => Promise<{
    broadcastId: string
    skipped: string[]
    unverified: string[]
  }>
  sending: boolean
} {
  const [sending, setSending] = useState(false)

  const send = useCallback(async (input: SendInput) => {
    setSending(true)
    try {
      return await api.post<{
        broadcastId: string; skipped: string[]; unverified: string[]
      }>(BASE, input, token, { raw: true })
    } finally {
      setSending(false)
    }
  }, [token])

  return { send, sending }
}

/**
 * One broadcast, kept fresh while it is running.
 *
 * The poll stops on a terminal status rather than on unmount alone, because the
 * common case is a person watching a send finish and then leaving the tab
 * open — at which point there is nothing left to ask and asking anyway is a
 * request every three seconds forever.
 */
export function useBroadcastRun(broadcastId: string | null, token?: string): {
  broadcast: Broadcast | null
  recipients: BroadcastRecipient[]
  error: string | null
  cancel: () => Promise<void>
  cancelling: boolean
} {
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null)
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  // Read by the interval without re-arming it. Keeping the finished flag in
  // state alone would restart the timer on every tick it caused.
  const finished = useRef(false)

  const load = useCallback(async () => {
    if (!broadcastId || !token) return
    try {
      const data = await api.get<{ broadcast: Broadcast; recipients: BroadcastRecipient[] }>(
        `${BASE}/${broadcastId}`, token, { quiet: true, raw: true },
      )
      setBroadcast(data.broadcast)
      setRecipients(data.recipients ?? [])
      finished.current = isFinished(data.broadcast.status)
      setError(null)
    } catch {
      // Deliberately not cleared. A send in progress with a momentarily
      // unreachable server should show a slightly stale progress bar, not an
      // empty screen — the numbers already on it were true a moment ago.
      setError('The progress could not be refreshed just now.')
    }
  }, [broadcastId, token])

  useEffect(() => {
    if (!broadcastId) return
    finished.current = false
    void load()
    const timer = setInterval(() => {
      if (finished.current) return
      void load()
    }, RUN_POLL_MS)
    return () => clearInterval(timer)
  }, [broadcastId, load])

  const cancel = useCallback(async () => {
    if (!broadcastId) return
    setCancelling(true)
    try {
      await api.post(`${BASE}/${broadcastId}/cancel`, {}, token, { raw: true })
    } finally {
      setCancelling(false)
      await load()
    }
  }, [broadcastId, token, load])

  return { broadcast, recipients, error, cancel, cancelling }
}
