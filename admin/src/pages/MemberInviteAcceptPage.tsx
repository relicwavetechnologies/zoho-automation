import { FormEvent, useState } from "react"
import { Link } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { AuthCard } from "@/components/admin/auth-card"
import { ErrorCallout } from "@/components/admin/error-callout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const result = await api.post<InviteResult>("/api/admin/auth/signup/member-invite", { inviteToken, name, password })
      toast.success("Invite accepted", { description: `${result.role} access granted for ${result.companyId}` })
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Invite acceptance failed.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthCard title="Accept invite" description="Use the invite token from your workspace admin to finish account setup.">
      <form className="space-y-5" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="inviteToken">Invite token</Label>
          <Input id="inviteToken" value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>
        <ErrorCallout message={error} />
        <Button type="submit" className="w-full rounded-full" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Accept invite
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Ready to sign in? <Link className="font-semibold text-foreground" to="/login">Go to login</Link>
        </p>
      </form>
    </AuthCard>
  )
}
