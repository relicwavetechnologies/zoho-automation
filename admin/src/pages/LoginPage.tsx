import { FormEvent, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { AuthCard } from "@/components/admin/auth-card"
import { ErrorCallout } from "@/components/admin/error-callout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
    <AuthCard title="Welcome back" description="Sign in with your admin credentials to continue managing Divo workspaces.">
      <form className="space-y-5" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="mode">Access type</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as LoginMode)}>
            <SelectTrigger id="mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="company">Company admin</SelectItem>
              <SelectItem value="super">Super admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" />
        </div>
        <ErrorCallout message={error} />
        <Button type="submit" className="w-full rounded-full" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Sign in
        </Button>
        <div className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
          <Link className="hover:text-foreground" to="/signup/company-admin">Create workspace</Link>
          <Link className="hover:text-foreground" to="/signup/member-invite">Accept invite</Link>
        </div>
      </form>
    </AuthCard>
  )
}
