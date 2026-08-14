/**
 * The one sign-in page. Everyone lands here — member, manager, admin.
 *
 * Lark is the primary button and deliberately the larger one: it is the only
 * route that produces a session Lark chat can also use, because the handshake
 * stamps the Lark identity onto the session it creates. Password sign-in is the
 * fallback for super admins outside the customer's Lark tenant and for anyone
 * who set a password when accepting an email invite — it works fully in the web
 * app, and the page says plainly what it does not do.
 */
import { FormEvent, useEffect, useRef, useState } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { CheckCircle2, Loader2, Mail, ShieldCheck, Sparkles } from "lucide-react"
import { AuthCard, AuthError, Field } from "@/components/admin/auth-card"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { api } from "@/lib/api"
import { GmailMark } from "@/pages/workspace/brand"
import { hasUsableMailerConnection, type MailerGoogleConnection } from "@/pages/mailer-onboarding"

export function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  /** Which button is busy — so only the one that was pressed shows a spinner. */
  const [busy, setBusy] = useState<"lark" | "password" | null>(null)
  const [mailerStep, setMailerStep] = useState<"signin" | "gmail" | "done">("signin")
  const [gmailBusy, setGmailBusy] = useState(false)
  const { token, session, loading, unreachable, refresh, loginWithLark, completeLarkLogin, loginWithPassword } = useAdminAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  /**
   * Where to go once signed in.
   *
   * Only a path on this site, and never a protocol-relative one — `//evil.example`
   * is a valid URL to a different origin, and an open redirect on a login page is
   * how a convincing phishing link gets built.
   */
  const requested = params.get("next")
  const next = requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/"
  const signedInTarget = next === "/login" ? "/" : next
  const isLarkLinkFlow = next.startsWith("/link/lark")
  const larkCode = params.get("lark_code")
  const larkState = params.get("lark_state")
  const callbackStarted = useRef(false)
  const attemptInFlight = useRef(false)

  const attempt = async (
    kind: "lark" | "password",
    run: () => Promise<void>,
    options: { navigateAfter?: boolean } = {},
  ) => {
    if (attemptInFlight.current) return
    attemptInFlight.current = true
    setBusy(kind)
    setError(null)
    try {
      await run()
      if (options.navigateAfter !== false) navigate(next, { replace: true })
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "Sign-in failed.")
    } finally {
      setBusy(null)
      attemptInFlight.current = false
    }
  }

  const completeLark = async () => {
    if (!larkCode || !larkState) return
    await attempt("lark", async () => {
      const issuedToken = await completeLarkLogin(larkCode, larkState)
      const cleanParams = new URLSearchParams(window.location.search)
      cleanParams.delete("lark_code")
      cleanParams.delete("lark_state")
      cleanParams.delete("error")
      const cleanQuery = cleanParams.toString()
      window.history.replaceState(null, "", `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}${window.location.hash}`)
      let status: { connections?: MailerGoogleConnection[] }
      try {
        status = await api.get<{ connections?: MailerGoogleConnection[] }>(
          "/api/desktop/auth/google/status",
          issuedToken,
          { quiet: true, timeoutMs: 12_000 },
        )
      } catch {
        // The member is already signed in. A transient connection-status read
        // must not turn into another OAuth demand or block access to Divo.
        navigate(signedInTarget, { replace: true })
        return
      }
      if (hasUsableMailerConnection(status.connections)) {
        navigate(signedInTarget, { replace: true })
        return
      }
      setMailerStep("gmail")
    }, { navigateAfter: false })
  }

  const connectGmail = async () => {
    if (!token || gmailBusy) return
    setGmailBusy(true)
    setError(null)
    try {
      const { authorizeUrl } = await api.get<{ authorizeUrl: string }>(
        "/api/desktop/auth/google/authorize-url?for=mailAutomations",
        token,
        { quiet: true, timeoutMs: 12_000 },
      )
      const popup = window.open(authorizeUrl, "divo-connect-google-mailer", "width=520,height=720")
      if (!popup) throw new Error("Your browser blocked the Gmail connect window. Allow pop-ups and try again.")

      await new Promise<void>((resolve) => {
        const done = () => {
          window.clearInterval(timer)
          window.removeEventListener("message", onMessage)
          resolve()
        }
        const onMessage = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return
          const data = event.data as { source?: string; provider?: string; ok?: boolean } | null
          if (data?.source === "divo-connection" && data.ok && data.provider === "google_workspace") done()
        }
        const timer = window.setInterval(() => {
          if (popup.closed) done()
        }, 500)
        window.addEventListener("message", onMessage)
      })

      const status = await api.get<{ connections?: MailerGoogleConnection[] }>(
        "/api/desktop/auth/google/status",
        token,
        { quiet: true, timeoutMs: 12_000 },
      )
      if (!hasUsableMailerConnection(status.connections)) {
        throw new Error("Gmail was not connected. Try the Google step again.")
      }
      setMailerStep("done")
    } catch (gmailError) {
      setError(gmailError instanceof Error ? gmailError.message : "Gmail connection failed.")
    } finally {
      setGmailBusy(false)
    }
  }

  const submitPassword = (event: FormEvent) => {
    event.preventDefault()
    void attempt("password", () => loginWithPassword(email, password))
  }

  useEffect(() => {
    if (!larkCode || !larkState || callbackStarted.current) return
    callbackStarted.current = true
    void completeLark()
  }, [completeLarkLogin, larkCode, larkState])

  const larkCallbackActive = Boolean(larkCode && larkState) || callbackStarted.current
  if (!larkCallbackActive && mailerStep === "signin") {
    if (session) return <Navigate to={signedInTarget} replace />
    if (token && loading) return <LoginNotice message="Restoring your session…" />
    if (token && unreachable) {
      return (
        <LoginNotice
          message="Cannot reach Divo right now."
          detail="You are still signed in — this is the connection, not your account."
          actionLabel="Try again"
          onAction={() => void refresh()}
        />
      )
    }
  }

  return (
    <AuthCard
      title={mailerStep === "signin" ? "Sign in to Divo" : mailerStep === "gmail" ? "Connect Gmail for Divo Mailer" : "Divo Mailer is on"}
      description={
        mailerStep === "signin"
          ? "One account for the web app and for Divo in Lark."
          : mailerStep === "gmail"
            ? "Give Divo access to your work mail so it can deliver your brief in Lark."
            : "Your mailbox is connected. Divo is checking it now and will send your first brief in Lark."
      }
    >
      {mailerStep === "signin" ? <div className="ws-auth-form">
        <button
          type="button"
          className="btn primary"
          disabled={busy !== null}
          onClick={() => void attempt("lark", () => loginWithLark(next))}
        >
          {busy === "lark" ? <Loader2 size={14} className="ws-spin" /> : <LarkGlyph />}
          {busy === "lark" ? "Waiting for Lark" : "Continue with Lark"}
        </button>

        <div className="ws-auth-or"><span>or</span></div>

        <form className="ws-auth-form" style={{ gap: 14 }} onSubmit={submitPassword}>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="you@company.com"
            />
          </Field>

          <Field
            label="Password"
            hint={isLarkLinkFlow
              ? "This signs you into Divo first; you’ll connect Lark next so Divo can answer the message you sent."
              : "Signing in this way does not connect Lark. You can link it afterwards from Connected apps."}
          >
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>

          <AuthError message={error} />

          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === "password" ? <Loader2 size={14} className="ws-spin" /> : null}
            {busy === "password" ? "Signing in" : "Sign in with a password"}
          </button>
        </form>

        <div className="ws-auth-alt">
          <Link to="/signup/company-admin">Create a workspace</Link>
          <Link to="/signup/member-invite">Accept an invite</Link>
        </div>
      </div> : (
        <div className="ws-auth-form">
          <div className="ws-auth-mailer">
            <div className="ws-auth-mailer-head">
              <span className="ws-auth-mailer-mark"><GmailMark size={28} /></span>
              <div>
                <b>Divo Mailer</b>
                <p>Mail brief, follow-ups, and handled work delivered where you already talk to Divo.</p>
              </div>
            </div>
            <ul className="ws-auth-mailer-list">
              <li><Mail size={14} /><span>Summarizes what arrived and what needs you.</span></li>
              <li><Sparkles size={14} /><span>Finds follow-ups, blockers, and useful replies.</span></li>
              <li><ShieldCheck size={14} /><span>Keeps Gmail as the source of truth.</span></li>
            </ul>
          </div>

          <AuthError message={error} />

          {mailerStep === "gmail" ? (
            <button type="button" className="btn primary" disabled={!token || gmailBusy} onClick={() => void connectGmail()}>
              {gmailBusy ? <Loader2 size={14} className="ws-spin" /> : <GmailMark size={14} />}
              {gmailBusy ? "Waiting for Google" : "Connect Gmail"}
            </button>
          ) : (
            <>
              <div className="ws-auth-ok">
                <CheckCircle2 size={14} />
                <span>Divo Mailer will send your first brief in Lark.</span>
              </div>
              <button type="button" className="btn primary" onClick={() => navigate(next, { replace: true })}>
                Continue to Divo
              </button>
            </>
          )}
        </div>
      )}
    </AuthCard>
  )
}

function LoginNotice({
  message,
  detail,
  actionLabel,
  onAction,
}: {
  message: string
  detail?: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="cur">
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--cur-canvas)" }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <div className="ws-auth-wait">{message}</div>
          {detail ? (
            <p className="ws-sub" style={{ marginTop: 10, lineHeight: 1.5 }}>
              {detail}
            </p>
          ) : null}
          {actionLabel && onAction ? (
            <button type="button" className="btn" style={{ marginTop: 16 }} onClick={onAction}>
              {actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* Lark's mark, drawn rather than fetched — the auth page must render before any
   network call resolves, and a broken logo is a bad first impression. */
const LarkGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M4 5.5h9.4c1.2 0 1.8 1.4 1 2.3l-1.7 1.8c-2 2.2-4.7 3.5-7.6 3.7A.9.9 0 0 1 4 12.4V5.5Z" opacity=".55" />
    <path d="M9.6 16.6c3.4-.6 6.4-2.5 8.4-5.3l1.4-2c.5-.8 1.8-.4 1.8.6v7.6c0 1.4-1.1 2.5-2.5 2.5H5.4c-.9 0-1.2-1.2-.4-1.6l4.6-1.8Z" />
  </svg>
)
