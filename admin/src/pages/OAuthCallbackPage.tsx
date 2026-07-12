import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { AuthCard } from "@/components/admin/auth-card"
import { ErrorCallout } from "@/components/admin/error-callout"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { useAdminAuth } from "@/auth/AdminAuthProvider"

type OAuthCallbackPageProps = {
  provider: "zoho" | "lark" | "google"
}

const endpointByProvider: Record<OAuthCallbackPageProps["provider"], string> = {
  zoho: "/api/admin/company/onboarding/connect",
  lark: "/api/admin/company/onboarding/lark-connect",
  google: "/api/admin/company/onboarding/google-connect",
}

export function OAuthCallbackPage({ provider }: OAuthCallbackPageProps) {
  const [params] = useSearchParams()
  const { token } = useAdminAuth()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const calledRef = useRef(false)

  useEffect(() => {
    if (!token || calledRef.current) return
    const code = params.get("code")
    const state = params.get("state")
    if (!code) {
      setError("OAuth callback is missing a code.")
      return
    }
    calledRef.current = true
    api
      .post(endpointByProvider[provider], { code, state: state ?? undefined }, token)
      .then(() => setDone(true))
      .catch((callbackError: unknown) => setError(callbackError instanceof Error ? callbackError.message : "OAuth callback failed."))
  }, [params, provider, token])

  return (
    <AuthCard title={`${provider.toUpperCase()} callback`} description="Completing the integration connection with the admin backend.">
      <div className="space-y-5">
        {!done && !error ? (
          <div className="flex items-center gap-3 rounded-lg bg-secondary p-4 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Connecting integration...
          </div>
        ) : null}
        {done ? <p className="rounded-lg bg-accent p-4 text-sm font-medium text-accent-foreground">Integration connected.</p> : null}
        <ErrorCallout message={error} />
        <Button asChild className="w-full rounded-full">
          <Link to="/settings">Back to settings</Link>
        </Button>
      </div>
    </AuthCard>
  )
}
