import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getIntegrationPlugins = vi.fn()
const startIntegrationPluginOAuth = vi.fn()
const openExternal = vi.fn()

vi.mock('@/hermes', () => ({
  getIntegrationPlugins: () => getIntegrationPlugins(),
  startIntegrationPluginOAuth: (pluginId: string) => startIntegrationPluginOAuth(pluginId)
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

function googlePlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: 'google-workspace',
    manifest: {
      id: 'google-workspace',
      name: 'Google Workspace',
      description: 'Gmail, Calendar, and Drive',
      category: 'Productivity',
      featured: true,
      logo_key: 'google-workspace',
      auth_model: 'oauth',
      connector_provider: 'google',
      connection_scope: 'user',
      oauth_scopes: [],
      capabilities: [],
      examples: ['Summarize my inbox', 'Find a file in Drive'],
      env_requirements: []
    },
    connection: {
      status: 'not_connected',
      account_email: null,
      granted_scopes: [],
      connected_at: null,
      credential_id: null
    },
    capabilities: [],
    actions: {
      can_connect: true,
      can_disconnect: false,
      can_manage_admin: false
    },
    ...overrides
  }
}

function renderIntegrations() {
  return import('./index').then(({ IntegrationsView }) => render(<IntegrationsView />))
}

beforeEach(() => {
  openExternal.mockResolvedValue(undefined)
  window.hermesDesktop = {
    ...(window.hermesDesktop ?? {}),
    openExternal
  } as typeof window.hermesDesktop

  getIntegrationPlugins.mockResolvedValue({
    company_id: 'company_hermes',
    actor: {
      company_user_id: 'user_alice',
      role: 'MEMBER',
      is_admin: false
    },
    oauth: {
      google_configured: true,
      redirect_configured: false
    },
    plugins: [googlePlugin()]
  })
  startIntegrationPluginOAuth.mockRejectedValue(new Error('501: {"detail":{"error":"redirect_uri_not_configured"}}'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('IntegrationsView', () => {
  it('renders Google Workspace and personal connect copy', async () => {
    await renderIntegrations()

    expect(await screen.findByText('Your plugins')).toBeTruthy()
    expect(screen.getByText('Google Workspace')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect your Google account' })).toBeTruthy()
    expect(screen.getByText(/Signed in as employee/)).toBeTruthy()
    expect(screen.queryByText(/connected user/i)).toBeNull()
    expect(screen.queryByText(/admin_stats/i)).toBeNull()
  })

  it('shows the connected account email for the current user', async () => {
    getIntegrationPlugins.mockResolvedValue({
      company_id: 'company_hermes',
      actor: {
        company_user_id: 'user_alice',
        role: 'MEMBER',
        is_admin: false
      },
      oauth: {
        google_configured: true,
        redirect_configured: true
      },
      plugins: [
        googlePlugin({
          connection: {
            status: 'connected',
            account_email: 'alice@example.com',
            granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            connected_at: '2026-06-17T10:00:00Z',
            credential_id: 'cc_google_alice'
          },
          actions: {
            can_connect: false,
            can_disconnect: true,
            can_manage_admin: false
          }
        })
      ]
    })

    await renderIntegrations()

    expect(await screen.findByText(/Connected as/)).toBeTruthy()
    expect(screen.getByText('alice@example.com')).toBeTruthy()
    expect(screen.queryByText(/connected user count/i)).toBeNull()
  })

  it('polls plugin status after OAuth and updates to connected without reload', async () => {
    const { notify } = await import('@/store/notifications')

    getIntegrationPlugins
      .mockResolvedValueOnce({
        company_id: 'company_hermes',
        actor: { company_user_id: 'user_alice', role: 'MEMBER', is_admin: false },
        oauth: { google_configured: true, redirect_configured: true },
        plugins: [googlePlugin()]
      })
      .mockResolvedValue({
        company_id: 'company_hermes',
        actor: { company_user_id: 'user_alice', role: 'MEMBER', is_admin: false },
        oauth: { google_configured: true, redirect_configured: true },
        plugins: [
          googlePlugin({
            connection: {
              status: 'connected',
              account_email: 'alice@example.com',
              granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
              connected_at: '2026-06-17T10:00:00Z',
              credential_id: 'cc_google_alice'
            },
            actions: {
              can_connect: false,
              can_disconnect: true,
              can_manage_admin: false
            }
          })
        ]
      })

    startIntegrationPluginOAuth.mockResolvedValue({
      authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test'
    })

    await renderIntegrations()
    await screen.findByText('Connect your Google account')

    fireEvent.click(screen.getByRole('button', { name: 'Connect your Google account' }))

    await waitFor(() => expect(openExternal).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reconnect your account' })).toBeTruthy()
    )
    expect(getIntegrationPlugins.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(notify).toHaveBeenCalledWith({
      kind: 'success',
      message: 'Google connected as alice@example.com'
    })
  })

  it('surfaces OAuth errors when Connect is clicked', async () => {
    const { notifyError } = await import('@/store/notifications')

    await renderIntegrations()

    fireEvent.click(await screen.findByRole('button', { name: 'Connect your Google account' }))

    await waitFor(() => expect(startIntegrationPluginOAuth).toHaveBeenCalledWith('google-workspace'))
    await waitFor(() => expect(notifyError).toHaveBeenCalled())
  })
})
