import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Check, Loader2 } from "lucide-react"
import { AuthCard, AuthError } from "@/components/admin/auth-card"
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

const labelByProvider: Record<OAuthCallbackPageProps["provider"], string> = {
  zoho: "Zoho",
  lark: "Lark",
  google: "Google Workspace",
}

export function OAuthCallbackPage({ provider }: OAuthCallbackPageProps) {
  const [params] = useSearchParams()
  const { token } = useAdminAuth()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const calledRef = useRef(false)
  const label = labelByProvider[provider]

  useEffect(() => {
    if (!token || calledRef.current) return
    const code = params.get("code")
    const state = params.get("state")
    if (!code) {
      setError("The provider sent us back without an authorisation code, so nothing was connected.")
      return
    }
    calledRef.current = true
    api
      .post(endpointByProvider[provider], { code, state: state ?? undefined }, token)
      .then(() => setDone(true))
      .catch((callbackError: unknown) => setError(callbackError instanceof Error ? callbackError.message : "OAuth callback failed."))
  }, [params, provider, token])

  return (
    <AuthCard
      title={done ? `${label} is connected` : `Connecting ${label}`}
      description={
        done
          ? "The connection is company-wide. Who may use it is a separate decision, made per department."
          : "Finishing the handshake with the provider. This happens once and takes a moment."
      }
    >
      <div className="ws-auth-form">
        {!done && !error ? (
          <div className="ws-auth-wait">
            <Loader2 size={14} className="ws-spin" />
            Exchanging the code for a token…
          </div>
        ) : null}
        {done ? (
          <div className="ws-auth-ok">
            <Check size={14} />
            <span>Connected. The token is held encrypted by the backend and never returned to this page.</span>
          </div>
        ) : null}
        <AuthError message={error} />
        {/* Was /settings — that page is the audit log, and this flow belongs
            with the company's connections. */}
        <Link className="btn primary" to="/connections" style={{ justifyContent: "center" }}>
          {done ? "Go to connections" : "Back to connections"}
        </Link>
      </div>
    </AuthCard>
  )
}
