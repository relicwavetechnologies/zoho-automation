import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CompanyAccountMenu } from './company-account-menu'

const api = vi.fn()

function renderMenu() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  })

  return render(
    <QueryClientProvider client={client}>
      <CompanyAccountMenu baseUrl="https://hermes.example.com" />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  api.mockResolvedValue({
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
  })

  window.hermesDesktop = {
    api,
    oauthLogoutConnectionConfig: vi.fn()
  } as unknown as typeof window.hermesDesktop
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CompanyAccountMenu', () => {
  it('renders profile initials on the titlebar trigger after loading', async () => {
    renderMenu()

    await waitFor(() => {
      expect(screen.getByText('AE')).toBeTruthy()
    })
    expect(api).toHaveBeenCalledWith({ path: '/api/company/me' })
  })
})
