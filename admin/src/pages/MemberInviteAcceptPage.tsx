import { FormEvent, useState } from "react"
import { Link } from "react-router-dom"
import { Check, Loader2 } from "lucide-react"
import { AuthCard, AuthError, Field } from "@/components/admin/auth-card"
import { api } from "@/lib/api"

type InviteResult = {
  role: string
  companyId: string
}

export function MemberInviteAcceptPage() {
  const [inviteToken, setInviteToken] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<InviteResult | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const result = await api.post<InviteResult>("/api/admin/auth/signup/member-invite", { inviteToken, name, password })
      setAccepted(result)
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Invite acceptance failed.")
    } finally {
      setSubmitting(false)
    }
  }

  /* The outcome belongs on the page, not in a toast that disappears — this is
     the last screen of the flow, and it has to say what access was granted. */
  if (accepted) {
    return (
      <AuthCard title="You're in" description="Your account is set up and your access has been granted.">
        <div className="ws-auth-form">
          <div className="ws-auth-ok">
            <Check size={14} />
            <span>{accepted.role} access granted.</span>
          </div>
          <p className="ws-sub" style={{ lineHeight: 1.55 }}>
            Divo lives in Lark and in the desktop app — that is where you will actually work with it. Sign in here only
            if you also administer the company.
          </p>
          <Link className="btn primary" to="/login" style={{ justifyContent: "center" }}>Go to sign in</Link>
        </div>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Accept your invite"
      description="Paste the token your admin sent you, then choose a password."
    >
      <form className="ws-auth-form" onSubmit={submit}>
        <Field label="Invite token" hint="A long string from the invite message. It can only be used once.">
          <input className="input" value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} required />
        </Field>

        <Field label="Your name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
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
          {submitting ? "Accepting" : "Accept invite"}
        </button>

        <div className="ws-auth-alt">
          <span className="ws-sub">Already set up?</span>
          <Link to="/login">Sign in</Link>
        </div>
      </form>
    </AuthCard>
  )
}
