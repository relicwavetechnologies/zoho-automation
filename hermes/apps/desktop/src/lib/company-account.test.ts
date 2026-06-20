import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  companyAccountInitials,
  companyAccountHasHomeChannel,
  companyAccountHomeReminder,
  companyAccountMetaLine,
  fetchCompanyAccount,
  logoutCompanyAccount,
  setDesktopHomeChannel,
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

  it('detects whether the Lark home channel has been configured', () => {
    expect(companyAccountHasHomeChannel(profile, 'lark')).toBe(false)
    expect(companyAccountHomeReminder(profile)).toContain('/sethome')

    const withHome: CompanyAccountProfile = {
      ...profile,
      home_channels: [
        {
          id: 'home_1',
          company_id: profile.company_id,
          company_user_id: profile.id,
          platform: 'lark',
          chat_id: 'oc_alice',
          chat_name: 'Alice DM',
          thread_id: null,
          channel_identity_id: null,
          created_at: null,
          updated_at: null
        }
      ]
    }
    expect(companyAccountHasHomeChannel(withHome, 'feishu')).toBe(true)
    expect(companyAccountHomeReminder(withHome)).toBeNull()

    const withDesktopHome: CompanyAccountProfile = {
      ...profile,
      home_channels: [
        {
          id: 'home_desktop',
          company_id: profile.company_id,
          company_user_id: profile.id,
          platform: 'desktop',
          chat_id: 'desktop:device-1',
          chat_name: 'Desktop',
          thread_id: null,
          channel_identity_id: null,
          created_at: null,
          updated_at: null
        }
      ]
    }
    expect(companyAccountHomeReminder(withDesktopHome)).toBeNull()
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

  it('sets the current desktop as a company home channel', async () => {
    const api = vi.fn().mockResolvedValue({
      id: 'home_desktop',
      company_id: profile.company_id,
      company_user_id: profile.id,
      platform: 'desktop',
      chat_id: 'desktop:fixed-device',
      chat_name: 'Desktop',
      thread_id: null,
      channel_identity_id: null,
      created_at: null,
      updated_at: null
    })
    window.localStorage.setItem('hermes.desktop.home_device_id', 'desktop:fixed-device')
    window.hermesDesktop = {
      api,
      oauthLogoutConnectionConfig: vi.fn()
    } as unknown as typeof window.hermesDesktop

    await setDesktopHomeChannel()

    expect(api).toHaveBeenCalledWith({
      path: '/api/company/home-channels/desktop',
      method: 'PUT',
      body: {
        device_id: 'desktop:fixed-device',
        device_name: 'Desktop'
      }
    })
  })
})
