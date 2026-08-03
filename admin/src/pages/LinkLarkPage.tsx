/**
 * Where the "Sign in" button in a Lark card lands.
 *
 * The card used to open Lark's own consent screen and the callback minted a
 * second session behind the web one. Sign-in is one thing now: this page needs
 * a signed-in person, so it sends you to the normal login first and comes back
 * here afterwards. All it then does is hand the card's one-time nonce to the
 * backend, which attaches your Lark identity to the session you just created.
 *
 * Deliberately no auto-bounce back into Lark. A redirect out of the browser is
 * unreliable across desktop and mobile Lark, and half-landing somewhere is
 * worse than a sentence telling you it worked. So: a message, and you switch
 * back yourself.
 */
import { useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { Check, Loader2, Lock, TriangleAlert } from 'lucide-react'
import { AuthCard } from '@/components/admin/auth-card'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { ApiError, api } from '@/lib/api'

type Outcome =
  | { kind: 'working' }
  | { kind: 'linked'; replaying: boolean }
  /** Signed in, but the Lark capability still needs an explicit connection. */
  | { kind: 'needs-lark' }
  /** The nonce is gone: ten minutes passed, or it was already used. */
  | { kind: 'expired' }
  /** Signed in as somebody other than the person the card named. */
  | { kind: 'wrong-person' }
  | { kind: 'error'; message: string; retryable?: boolean }

export function LinkLarkPage() {
  const [params] = useSearchParams()
  const { token, session, loading, unreachable, loginWithLark, refresh } = useAdminAuth()
  const state = params.get('state')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' })
  const [attempt, setAttempt] = useState(0)
  const [larkConnecting, setLarkConnecting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // The nonce is single-use. React 18 mounts effects twice in development, and
  // a second POST would spend a nonce the first one already consumed and report
  // "expired" over a link that actually worked.
  const sent = useRef(false)
  const lastState = useRef<string | null>(null)

  useEffect(() => {
    if (lastState.current === state) return
    lastState.current = state
    sent.current = false
    setAttempt(0)
    setLarkConnecting(false)
    setOutcome({ kind: 'working' })
  }, [state])

  useEffect(() => {
    if (loading || !token || !session || !state || sent.current) return
    sent.current = true
    void (async () => {
      try {
        const result = await api.post<{ linked: boolean; replaying: boolean }>(
          '/api/lark/auth/link', { state }, token, { quiet: true, raw: true, timeoutMs: 12_000 },
        )
        setOutcome({ kind: 'linked', replaying: result.replaying })
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setOutcome({ kind: 'needs-lark' })
        }
        else if (e instanceof ApiError && e.status === 403) setOutcome({ kind: 'wrong-person' })
        else if (e instanceof ApiError && e.status === 410) setOutcome({ kind: 'expired' })
        else {
          const retryable = !(e instanceof ApiError) || e.status >= 500
          setOutcome({
            kind: 'error',
            message: retryable
              ? 'Divo could not complete the connection. Try again in a moment.'
              : e instanceof Error ? e.message : 'Something went wrong.',
            retryable,
          })
        }
      }
    })()
  }, [attempt, loading, loginWithLark, session, state, token])

  if (!state) {
    return (
      <AuthCard title="That link is incomplete" description="Ask Divo in Lark to send you a new one.">
        <p className="ws-sub">The address is missing the part that says which account it was for.</p>
      </AuthCard>
    )
  }

  // Sign in first, then come straight back rather than landing on the home page
  // with the card's nonce quietly dropped.
  if (!loading && !token) {
    const next = `/link/lark?state=${encodeURIComponent(state)}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  if (!loading && unreachable && token && !session) {
    const retrySession = () => {
      if (refreshing) return
      setRefreshing(true)
      void refresh().finally(() => setRefreshing(false))
    }
    return (
      <AuthCard title="Divo is temporarily unavailable" description="Your sign-in is safe.">
        <p className="ws-sub" style={{ lineHeight: 1.55 }}>
          Divo could not restore your session right now. Try again in a moment.
        </p>
        <button type="button" className="btn" style={{ marginTop: 14 }} onClick={retrySession} disabled={refreshing}>
          {refreshing ? 'Trying again…' : 'Try again'}
        </button>
      </AuthCard>
    )
  }

  if (loading || outcome.kind === 'working') {
    return (
      <AuthCard title="Connecting Divo to Lark" description="One moment.">
        <p className="ws-sub"><Loader2 size={14} className="ws-spin" /> Attaching your Lark account…</p>
      </AuthCard>
    )
  }

  if (outcome.kind === 'linked') {
    return (
      <AuthCard
        title="You're signed in"
        description={session?.email ?? 'Your Lark account is attached to this session.'}
      >
        <p className="ws-auth-done"><Check size={15} /> Divo can now answer you in Lark.</p>
        <p className="ws-sub" style={{ marginTop: 10, lineHeight: 1.55 }}>
          {outcome.replaying
            ? 'Head back to Lark — Divo will try to answer the message you sent before. If nothing appears, send it again.'
            : 'Head back to Lark and ask again.'}
        </p>
        <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.55 }}>
          Your Lark connection is ready too, so Divo can use the capabilities you approved without another sign-in.
        </p>
      </AuthCard>
    )
  }

  if (outcome.kind === 'needs-lark') {
    const next = `/link/lark?state=${encodeURIComponent(state)}`
    const connectLark = () => {
      if (larkConnecting) return
      setLarkConnecting(true)
      void loginWithLark(next)
        .then(() => setLarkConnecting(false))
        .catch(error => {
          setLarkConnecting(false)
          setOutcome({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Could not start Lark sign-in.',
            retryable: true,
          })
        })
    }
    return (
      <AuthCard title="Connect Lark to continue" description="Your Divo sign-in is complete.">
        <p className="ws-sub" style={{ lineHeight: 1.55 }}>
          Divo still needs permission to use the Lark account that sent this message. Continue to Lark to connect it.
        </p>
        <button type="button" className="btn primary" style={{ marginTop: 14 }} onClick={connectLark} disabled={larkConnecting}>
          {larkConnecting ? <Loader2 size={14} className="ws-spin" /> : null}
          {larkConnecting ? 'Waiting for Lark' : 'Continue with Lark'}
        </button>
      </AuthCard>
    )
  }

  if (outcome.kind === 'wrong-person') {
    return (
      <AuthCard title="That link was for someone else" description="Nothing was changed.">
        <p className="ws-auth-warn"><Lock size={15} /> You are signed in as {session?.email ?? 'a different account'}.</p>
        <p className="ws-sub" style={{ marginTop: 10, lineHeight: 1.55 }}>
          The card was sent to a different Lark account, so Divo did not attach it to this one.
          Sign in as that person, or ask Divo in Lark for a fresh link.
        </p>
      </AuthCard>
    )
  }

  if (outcome.kind === 'expired') {
    return (
      <AuthCard title="That link has expired" description="This link was valid for ten minutes.">
        <p className="ws-sub" style={{ lineHeight: 1.55 }}>
          Send Divo a message in Lark — or type <b>/login</b> — and it will give you a new one.
          You are still signed in here.
        </p>
      </AuthCard>
    )
  }

  const retry = () => {
    sent.current = false
    setOutcome({ kind: 'working' })
    setAttempt(value => value + 1)
  }

  return (
    <AuthCard title="That did not work" description="Nothing was changed.">
      <p className="ws-auth-warn"><TriangleAlert size={15} /> {outcome.message}</p>
      <p className="ws-sub" style={{ marginTop: 10, lineHeight: 1.55 }}>
        {outcome.retryable
          ? 'Your sign-in link may still be valid.'
          : 'Ask Divo in Lark for a new link and try once more.'}
      </p>
      {outcome.retryable ? (
        <button type="button" className="btn" style={{ marginTop: 14 }} onClick={retry}>
          Try again
        </button>
      ) : null}
    </AuthCard>
  )
}
