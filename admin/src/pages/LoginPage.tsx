import { FormEvent, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowRight, Loader2 } from "lucide-react"
import { AuthCard, AuthError, Field } from "@/components/admin/auth-card"
import { useAdminAuth } from "@/auth/AdminAuthProvider"

type LoginMode = "company" | "super"

export function LoginPage() {
  const [mode, setMode] = useState<LoginMode>("company")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { loginCompanyAdmin, loginSuperAdmin } = useAdminAuth()
  const navigate = useNavigate()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      if (mode === "super") {
        await loginSuperAdmin(email, password)
      } else {
        await loginCompanyAdmin(email, password)
      }
      navigate("/", { replace: true })
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login failed.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthCard title="Sign in" description="Company admin and super admin accounts. Members sign in from Lark or the desktop app.">
      <form className="ws-auth-form" onSubmit={submit}>
        <Field
          label="Account type"
          hint={mode === "super" ? "Super admin sees every company and the platform-scoped provider keys." : undefined}
        >
          <select className="select" value={mode} onChange={(event) => setMode(event.target.value as LoginMode)}>
            <option value="company">Company admin</option>
            <option value="super">Super admin</option>
          </select>
        </Field>

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

        <Field label="Password">
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

        <button type="submit" className="btn primary" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="ws-spin" /> : null}
          {submitting ? "Signing in" : "Sign in"}
        </button>

        <Link className="btn" to="/mock-dashboard" style={{ justifyContent: "center" }}>
          Look around first <ArrowRight size={14} />
        </Link>

        <div className="ws-auth-alt">
          <Link to="/signup/company-admin">Create a workspace</Link>
          <Link to="/signup/member-invite">Accept an invite</Link>
        </div>
      </form>
    </AuthCard>
  )
}
