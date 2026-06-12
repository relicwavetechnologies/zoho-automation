import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CompanyAuthOverlay } from './company-auth-overlay'
import { hideCompanyAuth, showCompanyAuth } from '@/store/company-auth'

const oauthLoginConnectionConfig = vi.fn()

beforeEach(() => {
  window.hermesDesktop = {
    oauthLoginConnectionConfig
  } as unknown as typeof window.hermesDesktop
  oauthLoginConnectionConfig.mockReset()
})

afterEach(() => {
  cleanup()
  hideCompanyAuth()
  vi.restoreAllMocks()
})

describe('CompanyAuthOverlay', () => {
  it('renders Lark-branded copy for a Lark-gated company workspace', () => {
    showCompanyAuth({
      authMode: 'oauth',
      baseUrl: 'https://hermes.example.com',
      connected: false,
      needsLogin: true,
      providers: [{ name: 'lark', displayName: 'Lark' }],
      reachable: true,
      source: 'default'
    })

    render(<CompanyAuthOverlay />)

    expect(screen.getByText('Sign in with Lark')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Continue with Lark/i })).toBeTruthy()
  })

  it('stays blocked and surfaces an inline retry error when the auth window closes early', async () => {
    oauthLoginConnectionConfig.mockRejectedValue(new Error('Login window closed before authentication completed.'))
    showCompanyAuth({
      authMode: 'oauth',
      baseUrl: 'https://hermes.example.com',
      connected: false,
      needsLogin: true,
      providers: [{ name: 'lark', displayName: 'Lark' }],
      reachable: true,
      source: 'settings'
    })

    render(<CompanyAuthOverlay />)
    fireEvent.click(screen.getByRole('button', { name: /Continue with Lark/i }))

    expect(await screen.findByText('Sign-in window closed before authentication completed.')).toBeTruthy()
    expect(oauthLoginConnectionConfig).toHaveBeenCalledWith('https://hermes.example.com')
    expect(screen.getByRole('button', { name: /Continue with Lark/i })).toBeTruthy()
  })
})
