import { FormEvent, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { AuthCard } from "@/components/admin/auth-card"
import { ErrorCallout } from "@/components/admin/error-callout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
    <AuthCard title="Create workspace" description="Start a company admin account and workspace in one step.">
      <form className="space-y-5" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="companyName">Workspace name</Label>
          <Input id="companyName" value={companyName} onChange={(event) => setCompanyName(event.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>
        <ErrorCallout message={error} />
        <Button type="submit" className="w-full rounded-full" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create workspace
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already have access? <Link className="font-semibold text-foreground" to="/login">Sign in</Link>
        </p>
      </form>
    </AuthCard>
  )
}
