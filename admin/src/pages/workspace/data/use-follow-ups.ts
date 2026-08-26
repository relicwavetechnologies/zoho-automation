/**
 * WhatsApp follow-ups, as the team reads and acts on them.
 *
 * One shared pool: every member of the department sees every follow-up and may
 * act on any of them. Nothing is assigned to anybody, so there is no "mine"
 * filter here and no owner picker — `ownerLabel` is a *side* ("We owe",
 * "Waiting on Priya"), rendered by the server so one rule decides the wording.
 *
 * `raw: true` throughout. These routes answer `{ ok, ... }` like the sibling
 * member routes rather than `{ success, data }`, and the escape hatch is
 * declared at the call site the way `api.ts` asks.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '@/lib/api'

const BASE = '/api/follow-ups'

export type FollowUp = {
  id: string
  title: string
  detail: string
  kind: string
  /** "We owe" or "Waiting on <name>". Composed server-side, never here. */
  ownerLabel: string
  owner: 'us' | 'them'
  counterparty: string
  dueDate: string | null
  urgency: 'low' | 'medium' | 'high'
  chatId: string
  chatName: string | null
  remindAt: string | null
  updatedAt: string
  /** The handset this follow-up belongs to — what the digest card's link carries. */
  sessionId?: string
}

export type LinkedNumber = {
  id: string
  label: string
  phoneE164: string | null
  status: 'pending' | 'linked' | 'disconnected' | string
  lastSeenAt: string | null
  /** Quiet longer than the alarm allows. */
  stale: boolean
  /**
   * When delivery is believed to have stopped, while the gap is still unfilled.
   *
   * Survives the number reconnecting: messages flowing again says nothing about
   * the ones sent while it was down. Cleared only by a completed re-read.
   */
  darkSince: string | null
}

export type TrackedChat = {
  id: string
  name: string | null
  isGroup: boolean
  muted: boolean
  lastMessageAt: string | null
  lastAnalyzedAt: string | null
  openFollowUps: number
  /** The handset this chat belongs to. */
  sessionId?: string
}

type Loadable = {
  loading: boolean
  error: string | null
  refusal: string | null
  refresh: () => void
}

/**
 * A read that failed must not look like a read that found nothing.
 *
 * An empty follow-ups list means "you are on top of everything", which is the
 * one conclusion this page must never state without evidence.
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

/**
 * What a person can do to a follow-up.
 *
 * Four, and no assignment. `owner` names a side rather than a member, so there
 * is nobody to hand an item to — anyone in the department may close anything.
 */
export type FollowUpAction =
  | { action: 'done'; reason?: string }
  | { action: 'dismiss'; reason?: string }
  | { action: 'snooze'; hours: number }
  | { action: 'reopen' }

export function useFollowUps(
  token?: string,
  /** One handset's conversations only. What the digest card's link carries. */
  numberId?: string,
): Loadable & {
  followUps: FollowUp[]
  truncated: boolean
  act: (id: string, action: FollowUpAction) => Promise<void>
} {
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const query = numberId ? `?number=${encodeURIComponent(numberId)}` : ''
      const data = await api.get<{ followUps: FollowUp[]; truncated: boolean }>(
        `${BASE}${query}`, token, { quiet: true, raw: true },
      )
      setFollowUps(data.followUps ?? [])
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

  const act = useCallback(async (id: string, action: FollowUpAction) => {
    // Optimistic removal, then reconciled by the reload. Closing an item is the
    // one interaction here with a visible result, and a row that lingers for a
    // round trip reads as a button that did not work.
    setFollowUps(prev => prev.filter(item => item.id !== id))
    try {
      await api.patch(`${BASE}/${id}`, action, token, { raw: true })
    } finally {
      await load()
    }
  }, [token, load])

  useEffect(() => { void load() }, [load])
  return { followUps, truncated, loading, error, refusal, refresh: load, act }
}

export function useLinkedNumbers(token?: string): Loadable & {
  numbers: LinkedNumber[]
  /** Register a number and return the id its pairing dialog polls. */
  create: (label: string) => Promise<string>
  /** Re-read one number's missed history. Resolves to what it recovered. */
  reread: (id: string) => Promise<RereadResult>
} {
  const [numbers, setNumbers] = useState<LinkedNumber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const data = await api.get<{ numbers: LinkedNumber[] }>(
        `${BASE}/numbers`, token, { quiet: true, raw: true },
      )
      setNumbers(data.numbers ?? [])
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
  }, [token])

  const reread = useCallback(async (id: string): Promise<RereadResult> => {
    const result = await api.post<RereadResult>(
      `${BASE}/numbers/${id}/reread`, {}, token, { raw: true },
    )
    await load()
    return result
  }, [token, load])

  const create = useCallback(async (label: string): Promise<string> => {
    const data = await api.post<{ number: { id: string; label: string } }>(
      `${BASE}/numbers`, { label }, token, { raw: true },
    )
    await load()
    return data.number.id
  }, [token, load])

  useEffect(() => { void load() }, [load])
  return { numbers, loading, error, refusal, refresh: load, create, reread }
}

export type RereadResult = {
  ok: boolean
  chatsRead: number
  messagesRecovered: number
  /**
   * False when some chats could not be read.
   *
   * A partial repair leaves the gap marker in place, and the screen must say so
   * rather than report a success that would retire the only signal that messages
   * are still missing.
   */
  complete: boolean
  failures: { chat: string; error: string }[]
}

export function useTrackedChats(token?: string, numberId?: string): Loadable & {
  chats: TrackedChat[]
  setMuted: (chatId: string, muted: boolean) => Promise<void>
} {
  const [chats, setChats] = useState<TrackedChat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const query = numberId ? `?number=${encodeURIComponent(numberId)}` : ''
      const data = await api.get<{ chats: TrackedChat[] }>(
        `${BASE}/chats${query}`, token, { quiet: true, raw: true },
      )
      setChats(data.chats ?? [])
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

  const setMuted = useCallback(async (chatId: string, muted: boolean) => {
    // Optimistic, then reconciled by the reload. Muting is the privacy control
    // for direct messages, so a switch that lags reads as one that did not work.
    setChats(prev => prev.map(c => (c.id === chatId ? { ...c, muted } : c)))
    try {
      await api.patch(`${BASE}/chats/${chatId}`, { muted }, token, { raw: true })
    } finally {
      await load()
    }
  }, [token, load])

  useEffect(() => { void load() }, [load])
  return { chats, loading, error, refusal, refresh: load, setMuted }
}

/**
 * A QR, labelled with what it actually is.
 *
 * The gateway hands back either a rendered image or the raw payload a QR
 * encodes. The server decides which — an unlabelled `2@…` string in an
 * `<img src>` draws a broken image, and a broken image reads as "linking is
 * broken" rather than "this gateway returns a format this screen cannot draw".
 */
export type PairingQr =
  | { kind: 'image'; src: string }
  | { kind: 'payload'; value: string }

export type Pairing = {
  qr?: PairingQr
  pairingCode?: string
  status: 'pending' | 'linked' | 'disconnected'
}

/** How often the dialog asks. The QR rotates roughly every twenty seconds. */
const PAIRING_POLL_MS = 3000

/**
 * The live pairing state for one number, while its dialog is open.
 *
 * Polls rather than subscribes because the QR rotates and a stale one cannot be
 * scanned; there is nothing to cache. Passing `null` stops the poll, which is
 * how closing the dialog stops the traffic.
 */
export function usePairing(numberId: string | null, token?: string): {
  pairing: Pairing | null
  error: string | null
  /** True once the gateway reports the handset linked. */
  linked: boolean
  requestCode: (phoneE164: string) => Promise<void>
} {
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!numberId || !token) {
      setPairing(null)
      setError(null)
      return
    }
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const data = await api.get<{ pairing: Pairing }>(
          `${BASE}/numbers/${numberId}/pairing`, token, { quiet: true, raw: true },
        )
        if (!live) return
        setPairing(data.pairing)
        setError(null)
        // Stop once it is linked. Polling a paired session produces no QR and
        // nothing else changes, so the only thing left to do is answer.
        if (data.pairing.status === 'linked') return
      } catch {
        if (!live) return
        // Named rather than left blank: an empty dialog is indistinguishable
        // from one still waiting for the first QR to arrive.
        setError('The WhatsApp gateway did not answer, so there is no code to scan.')
      }
      if (live) timer = setTimeout(() => void poll(), PAIRING_POLL_MS)
    }

    void poll()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [numberId, token])

  const requestCode = useCallback(async (phoneE164: string) => {
    if (!numberId) return
    const data = await api.post<{ pairing: Pairing }>(
      `${BASE}/numbers/${numberId}/pairing-code`, { phoneE164 }, token, { raw: true },
    )
    setPairing(data.pairing)
  }, [numberId, token])

  return { pairing, error, linked: pairing?.status === 'linked', requestCode }
}
