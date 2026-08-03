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
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { AuthCard, AuthError, Field } from "@/components/admin/auth-card"
import { useAdminAuth } from "@/auth/AdminAuthProvider"

export function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  /** Which button is busy — so only the one that was pressed shows a spinner. */
  const [busy, setBusy] = useState<"lark" | "password" | null>(null)
  const { loginWithLark, completeLarkLogin, loginWithPassword } = useAdminAuth()
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
  const larkCode = params.get("lark_code")
  const larkState = params.get("lark_state")
  const callbackStarted = useRef(false)

  const attempt = async (kind: "lark" | "password", run: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await run()
      navigate(next, { replace: true })
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "Sign-in failed.")
    } finally {
      setBusy(null)
    }
  }

  const submitPassword = (event: FormEvent) => {
    event.preventDefault()
    void attempt("password", () => loginWithPassword(email, password))
  }

  useEffect(() => {
    if (!larkCode || !larkState || callbackStarted.current) return
    callbackStarted.current = true
    void attempt("lark", () => completeLarkLogin(larkCode, larkState))
  }, [completeLarkLogin, larkCode, larkState])

  return (
    <AuthCard
      title="Sign in to Divo"
      description="One account for the web app and for Divo in Lark."
    >
      <div className="ws-auth-form">
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
            hint="Signing in this way does not connect Lark. You can link it afterwards from Connected apps."
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
      </div>
    </AuthCard>
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
