export interface CompanyAccountProfile {
  id: string
  company_id: string
  company_name: string
  display_name: string
  email: string | null
  avatar_url: string | null
  lark_open_id: string | null
  lark_union_id: string | null
  lark_user_id: string | null
  department_id: string | null
  department_name: string | null
  role: string
  status: string
  provider: string
  first_login_at: string | null
  last_login_at: string | null
}

interface AuthMeResponse {
  user_id: string
  email: string
  display_name: string
  org_id: string
  provider: string
  expires_at: number
}

const FIXTURE_PROFILE: CompanyAccountProfile = {
  id: 'cu_fixture_alice',
  company_id: 'company_fixture',
  company_name: 'Fixture Co',
  display_name: 'Alice Example',
  email: 'alice@example.com',
  avatar_url: null,
  lark_open_id: 'ou_fixture_alice',
  lark_union_id: null,
  lark_user_id: null,
  department_id: 'od_engineering',
  department_name: 'Engineering',
  role: 'MEMBER',
  status: 'active',
  provider: 'lark',
  first_login_at: '2026-01-01T00:00:00+00:00',
  last_login_at: '2026-06-01T00:00:00+00:00'
}

function useFixtureProfile(): boolean {
  return import.meta.env.VITE_DESKTOP_ACCOUNT_FIXTURE === 'true'
}

export function companyAccountDisplayName(profile: CompanyAccountProfile): string {
  return profile.display_name || profile.email || profile.id
}

export function companyAccountInitials(profile: CompanyAccountProfile): string {
  const source = companyAccountDisplayName(profile).replace(/@.*$/, '')
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]?.[0] || ''}${parts[parts.length - 1]?.[0] || ''}`.toUpperCase()
  }
  const compact = parts[0] || source || 'U'
  return compact.slice(0, 2).toUpperCase()
}

function humanizeRole(role: string): string {
  const trimmed = role.trim()
  if (!trimmed) {
    return 'Member'
  }
  return trimmed
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

export function companyAccountMetaLine(profile: CompanyAccountProfile): string {
  const parts = [
    profile.department_name?.trim() || '',
    humanizeRole(profile.role),
    profile.company_name?.trim() || ''
  ].filter(Boolean)
  return parts.join(' · ')
}

export function companyAccountProviderLabel(profile: CompanyAccountProfile): string {
  if (/lark/i.test(profile.provider)) {
    return 'Lark'
  }
  const trimmed = profile.provider.trim()
  if (!trimmed) {
    return 'Company account'
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

async function fetchAuthMeFallback(): Promise<CompanyAccountProfile | null> {
  try {
    const auth = await window.hermesDesktop.api<AuthMeResponse>({ path: '/api/auth/me' })
    return {
      id: auth.user_id,
      company_id: auth.org_id || '',
      company_name: '',
      display_name: auth.display_name || auth.email || auth.user_id,
      email: auth.email?.trim() ? auth.email.trim() : null,
      avatar_url: null,
      lark_open_id: auth.provider === 'lark' ? auth.user_id : null,
      lark_union_id: null,
      lark_user_id: null,
      department_id: null,
      department_name: null,
      role: 'MEMBER',
      status: 'active',
      provider: auth.provider || 'dashboard',
      first_login_at: null,
      last_login_at: null
    }
  } catch {
    return null
  }
}

export async function fetchCompanyAccount(): Promise<CompanyAccountProfile | null> {
  if (useFixtureProfile()) {
    return FIXTURE_PROFILE
  }

  try {
    return await window.hermesDesktop.api<CompanyAccountProfile>({ path: '/api/company/me' })
  } catch {
    return fetchAuthMeFallback()
  }
}

export async function logoutCompanyAccount(baseUrl?: string): Promise<void> {
  await window.hermesDesktop.oauthLogoutConnectionConfig(baseUrl || undefined)
  window.location.reload()
}
