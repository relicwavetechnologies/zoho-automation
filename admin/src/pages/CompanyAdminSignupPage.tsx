import { FormEvent, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { AuthCard, AuthError, Field } from "@/components/admin/auth-card"
import { api } from "@/lib/api"

type SignupResponse = {
  token: string
}

export function CompanyAdminSignupPage() {
  const [companyName, setCompanyName] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.post<SignupResponse>("/api/admin/auth/signup/company-admin", { companyName, name, email, password })
      navigate("/login", { replace: true })
    } catch (signupError) {
      setError(signupError instanceof Error ? signupError.message : "Signup failed.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthCard
      title="Create a workspace"
      description="This creates the company and makes you its first admin. You can invite everyone else afterwards."
    >
      <form className="ws-auth-form" onSubmit={submit}>
        <Field label="Company name" hint="Shown to everyone in the company, in the app and in Lark.">
          <input className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} required placeholder="Acme Technologies" />
        </Field>

        <Field label="Your name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
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

        <Field label="Password" hint="At least 8 characters.">
          <input
            className="input"
            type="password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="new-password"
          />
        </Field>

        <AuthError message={error} />

        <button type="submit" className="btn primary" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="ws-spin" /> : null}
          {submitting ? "Creating" : "Create workspace"}
        </button>

        <div className="ws-auth-alt">
          <span className="ws-sub">Already have an account?</span>
          <Link to="/login">Sign in</Link>
        </div>
      </form>
    </AuthCard>
  )
}
