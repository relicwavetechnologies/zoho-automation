import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  companyAccountInitials,
  companyAccountMetaLine,
  fetchCompanyAccount,
  logoutCompanyAccount,
  type CompanyAccountProfile
} from './company-account'

const profile: CompanyAccountProfile = {
  id: 'cu_alice',
  company_id: 'company_hermes',
  company_name: 'Hermes Co',
  display_name: 'Alice Example',
  email: 'alice@example.com',
  avatar_url: null,
  lark_open_id: 'ou_alice',
  lark_union_id: null,
  lark_user_id: null,
  department_id: 'od_eng',
  department_name: 'Engineering',
  role: 'MEMBER',
  status: 'active',
  provider: 'lark',
  first_login_at: null,
  last_login_at: null
}

beforeEach(() => {
  window.hermesDesktop = {
    api: vi.fn().mockResolvedValue(profile),
    oauthLogoutConnectionConfig: vi.fn().mockResolvedValue({ ok: true, connected: false })
  } as unknown as typeof window.hermesDesktop
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('company-account helpers', () => {
  it('builds initials and meta line from profile fields', () => {
    expect(companyAccountInitials(profile)).toBe('AE')
    expect(companyAccountMetaLine(profile)).toBe('Engineering · Member · Hermes Co')
  })

  it('fetches the native company profile endpoint', async () => {
    const result = await fetchCompanyAccount()
    expect(result?.display_name).toBe('Alice Example')
    expect(window.hermesDesktop.api).toHaveBeenCalledWith({ path: '/api/company/me' })
  })

  it('logs out through the OAuth IPC bridge and reloads', async () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload }
    })

    await logoutCompanyAccount('https://hermes.example.com')

    expect(window.hermesDesktop.oauthLogoutConnectionConfig).toHaveBeenCalledWith(
      'https://hermes.example.com'
    )
    expect(reload).toHaveBeenCalled()
  })
})
