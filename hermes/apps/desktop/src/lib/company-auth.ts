import { hideCompanyAuth, showCompanyAuth } from '@/store/company-auth'

export async function syncCompanyAuthGate(
  desktop: typeof window.hermesDesktop | undefined,
  fallbackError?: unknown
): Promise<boolean> {
  if (!desktop?.getRemoteAuthStatus) {
    return false
  }

  let status
  try {
    status = await desktop.getRemoteAuthStatus()
  } catch {
    return false
  }

  if (status.authMode !== 'oauth' || !status.needsLogin || !status.baseUrl) {
    hideCompanyAuth()
    return false
  }

  showCompanyAuth(status, fallbackError)
  return true
}
