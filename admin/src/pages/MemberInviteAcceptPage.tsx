import { FormEvent, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Check, Loader2 } from "lucide-react"
import { AuthCard, AuthError, Field } from "@/components/admin/auth-card"
import { api } from "@/lib/api"

type InviteResult = {
  role: string
  companyId: string
}

export function MemberInviteAcceptPage() {
  /*
   * The token arrives in the link, or it is pasted.
   *
   * Both, because both happen. An administrator copies a link out of the invite
   * drawer and sends it, and somebody else forwards the token alone out of a
   * chat message — asking that second person to reconstruct a URL is how an
   * invite goes unused. Prefilled rather than hidden, so what is about to be
   * submitted is visible and correctable.
   */
  const [params] = useSearchParams()
  const [inviteToken, setInviteToken] = useState(params.get("token") ?? "")
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
            Your access is ready — sign in to continue to your workspace.
          </p>
          <Link className="btn primary" to="/login" style={{ justifyContent: "center" }}>Go to sign in</Link>
        </div>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Accept your invite"
      description="Choose a password to finish setting up your account."
    >
      <form className="ws-auth-form" onSubmit={submit}>
        <Field label="Invite token" hint="Filled in from your invite link. It can only be used once.">
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
