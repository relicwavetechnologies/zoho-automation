import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { AlertCircle, Loader2, LogIn } from '@/lib/icons'
import {
  clearCompanyAuthError,
  $companyAuth,
  hideCompanyAuth,
  setCompanyAuthError,
  setCompanyAuthSigningIn
} from '@/store/company-auth'

function larkButtonLabel(providerLabel: string): string {
  return /lark/i.test(providerLabel) ? 'Continue with Lark' : `Continue with ${providerLabel}`
}

function loginFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  const trimmed = message.trim()

  if (!trimmed) {
    return 'Sign-in failed. Try again.'
  }

  if (/closed before authentication completed/i.test(trimmed)) {
    return 'Sign-in window closed before authentication completed.'
  }

  return trimmed
}

function LarkMark({ className = 'size-8' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 48 48">
      <path d="M24 6 34 16 24 26 14 16Z" fill="#00C2FF" />
      <path d="M24 22 36 34 24 42 12 34Z" fill="#3370FF" />
      <path d="M24 26 34 16 42 24 32 34Z" fill="#7A4DFF" />
      <path d="M24 26 16 34 6 24 14 16Z" fill="#00D6B9" />
    </svg>
  )
}

export function CompanyAuthOverlay() {
  const auth = useStore($companyAuth)

  if (!auth.visible) {
    return null
  }

  const isLark = auth.brand === 'lark'
  const title = isLark ? 'Sign in with Lark' : 'Company sign-in required'
  const subtitle = isLark
    ? 'Use your company Lark account to continue to Hermes.'
    : 'Sign in with your company account before using this Hermes workspace.'
  const primaryLabel = isLark ? larkButtonLabel(auth.providerLabel) : `Continue with ${auth.providerLabel}`

  const signIn = async () => {
    clearCompanyAuthError()
    setCompanyAuthSigningIn(true)

    try {
      const result = await window.hermesDesktop.oauthLoginConnectionConfig(auth.baseUrl)
      if (!result.connected) {
        setCompanyAuthError('Sign-in did not complete. Try again.')
        return
      }

      hideCompanyAuth()
      window.location.reload()
    } catch (error) {
      setCompanyAuthError(loginFailureMessage(error))
    } finally {
      setCompanyAuthSigningIn(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-(--ui-chat-surface-background) p-6">
      <div className="w-full max-w-[34rem] overflow-hidden rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-chat-bubble-background) shadow-sm">
        <div className="border-b border-(--ui-stroke-tertiary) px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-(--ui-bg-tertiary)">
              {isLark ? (
                <LarkMark />
              ) : (
                <div className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <LogIn className="size-4" />
                </div>
              )}
            </div>
            <div>
              <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-(--ui-text-tertiary)">
                Hermes company workspace
              </div>
              <h2 className="mt-1 text-[1rem] font-semibold tracking-tight">{title}</h2>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-(--ui-text-tertiary)">{subtitle}</p>
        </div>

        <div className="grid gap-4 px-6 py-5">
          {auth.error ? (
            <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{auth.error}</span>
            </div>
          ) : null}

          {!auth.reachable ? (
            <div className="rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) px-4 py-3 text-sm text-(--ui-text-tertiary)">
              Hermes can’t reach the company backend yet. Keep this screen open and retry once the backend is reachable.
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button className="min-w-56" disabled={auth.signingIn} onClick={() => void signIn()}>
              {auth.signingIn ? (
                <Loader2 className="size-4 animate-spin" />
              ) : isLark ? (
                <LarkMark className="size-4" />
              ) : (
                <LogIn className="size-4" />
              )}
              {auth.signingIn ? 'Waiting for sign-in...' : primaryLabel}
            </Button>
          </div>

          <div className="text-xs text-(--ui-text-tertiary)">
            Connected backend: <span className="font-mono">{auth.baseUrl}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
