import { atom } from 'nanostores'

import type { DesktopAuthProvider, DesktopRemoteAuthStatus } from '@/global'

export type DesktopCompanyAuthBrand = 'generic' | 'lark'

export interface DesktopCompanyAuthState {
  visible: boolean
  baseUrl: string
  brand: DesktopCompanyAuthBrand
  error: string | null
  providerLabel: string
  providers: DesktopAuthProvider[]
  reachable: boolean
  signingIn: boolean
}

const INITIAL_STATE: DesktopCompanyAuthState = {
  visible: false,
  baseUrl: '',
  brand: 'generic',
  error: null,
  providerLabel: 'your company account',
  providers: [],
  reachable: false,
  signingIn: false
}

function providerLabel(providers: DesktopAuthProvider[]): string {
  if (providers.length === 1) {
    return providers[0].displayName || providers[0].name || 'your company account'
  }

  if (providers.length > 1) {
    return providers.map(provider => provider.displayName || provider.name).join(' / ')
  }

  return 'your company account'
}

function providerBrand(providers: DesktopAuthProvider[]): DesktopCompanyAuthBrand {
  if (providers.length !== 1) {
    return 'generic'
  }

  const provider = providers[0]
  const haystack = `${provider.name || ''} ${provider.displayName || ''}`.trim()
  return /lark/i.test(haystack) ? 'lark' : 'generic'
}

function authErrorMessage(error: unknown): null | string {
  if (!error) {
    return null
  }

  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  return trimmed || null
}

export const $companyAuth = atom<DesktopCompanyAuthState>(INITIAL_STATE)

export function clearCompanyAuthError(): void {
  const current = $companyAuth.get()
  if (!current.error) {
    return
  }
  $companyAuth.set({ ...current, error: null })
}

export function hideCompanyAuth(): void {
  if (!$companyAuth.get().visible) {
    return
  }
  $companyAuth.set(INITIAL_STATE)
}

export function setCompanyAuthError(error: null | string): void {
  const current = $companyAuth.get()
  $companyAuth.set({
    ...current,
    error
  })
}

export function setCompanyAuthSigningIn(signingIn: boolean): void {
  const current = $companyAuth.get()
  if (current.signingIn === signingIn) {
    return
  }
  $companyAuth.set({
    ...current,
    signingIn
  })
}

export function showCompanyAuth(status: DesktopRemoteAuthStatus, error?: unknown): void {
  if (!status.baseUrl) {
    return
  }

  $companyAuth.set({
    visible: true,
    baseUrl: status.baseUrl,
    brand: providerBrand(status.providers),
    error: authErrorMessage(error),
    providerLabel: providerLabel(status.providers),
    providers: status.providers,
    reachable: status.reachable,
    signingIn: false
  })
}
