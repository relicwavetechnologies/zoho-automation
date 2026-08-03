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
  /** The nonce is gone: ten minutes passed, or it was already used. */
  | { kind: 'expired' }
  /** Signed in as somebody other than the person the card named. */
  | { kind: 'wrong-person' }
  | { kind: 'error'; message: string }

export function LinkLarkPage() {
  const [params] = useSearchParams()
  const { token, session, loading, loginWithLark } = useAdminAuth()
  const state = params.get('state')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' })

  // The nonce is single-use. React 18 mounts effects twice in development, and
  // a second POST would spend a nonce the first one already consumed and report
  // "expired" over a link that actually worked.
  const sent = useRef(false)

  useEffect(() => {
    if (loading || !token || !session || !state || sent.current) return
    sent.current = true
    void (async () => {
      try {
        const result = await api.post<{ linked: boolean; replaying: boolean }>(
          '/api/lark/auth/link', { state }, token, { quiet: true, raw: true },
        )
        setOutcome({ kind: 'linked', replaying: result.replaying })
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const next = `/link/lark?state=${encodeURIComponent(state)}`
          try {
            await loginWithLark(next)
          } catch (oauthError) {
            sent.current = false
            setOutcome({ kind: 'error', message: oauthError instanceof Error ? oauthError.message : 'Could not start Lark sign-in.' })
          }
        }
        else if (e instanceof ApiError && e.status === 403) setOutcome({ kind: 'wrong-person' })
        else if (e instanceof ApiError && e.status === 410) setOutcome({ kind: 'expired' })
        else setOutcome({ kind: 'error', message: e instanceof Error ? e.message : 'Something went wrong.' })
      }
    })()
  }, [loading, loginWithLark, session, state, token])

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
            ? 'Head back to Lark — the message you sent before is being answered now, so there is no need to resend it.'
            : 'Head back to Lark and ask again.'}
        </p>
        <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.55 }}>
          Your Lark connection is ready too, so Divo can use the capabilities you approved without another sign-in.
        </p>
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
      <AuthCard title="That link has expired" description="They last ten minutes.">
        <p className="ws-sub" style={{ lineHeight: 1.55 }}>
          Send Divo a message in Lark — or type <b>/login</b> — and it will give you a new one.
          You are still signed in here.
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="That did not work" description="Nothing was changed.">
      <p className="ws-auth-warn"><TriangleAlert size={15} /> {outcome.message}</p>
      <p className="ws-sub" style={{ marginTop: 10, lineHeight: 1.55 }}>
        Ask Divo in Lark for a new link and try once more.
      </p>
    </AuthCard>
  )
}
