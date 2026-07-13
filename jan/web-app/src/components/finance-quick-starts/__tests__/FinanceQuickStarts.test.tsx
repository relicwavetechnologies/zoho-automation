import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FinanceQuickStarts } from '../FinanceQuickStarts'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const runtimeContext = {
  capabilityBootstrap: {
    departmentFunction: 'finance',
    preferredSkills: [
      { id: 'skill-bill', slug: 'zoho-books-bill' },
    ],
    preferredTools: [
      { toolId: 'zohoBooks', actions: ['read', 'create'] },
    ],
  },
}

const zohoStatus = {
  success: true,
  data: {
    connected: true,
    connections: [
      {
        connectionId: 'books-branch',
        label: 'Branch Books',
        accountEmail: 'branch@example.com',
        accountName: 'Branch',
        access: 'read_only',
      },
      {
        connectionId: 'books-hq',
        label: 'HQ Books',
        accountEmail: 'hq@example.com',
        accountName: 'HQ',
        access: 'read_write',
      },
    ],
  },
}

describe('FinanceQuickStarts', () => {
  beforeEach(() => {
    invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === 'divo_get_runtime_context' ? runtimeContext : zohoStatus
      )
    )
  })

  it('only renders for a Finance capability bootstrap', async () => {
    const { rerender } = render(<FinanceQuickStarts onSubmit={vi.fn()} />)
    expect(await screen.findByText('Finance quick starts')).toBeInTheDocument()

    invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === 'divo_get_runtime_context'
          ? {
              capabilityBootstrap: {
                ...runtimeContext.capabilityBootstrap,
                departmentFunction: 'sales',
              },
            }
          : zohoStatus
      )
    )
    rerender(<FinanceQuickStarts key="sales" onSubmit={vi.fn()} />)
    await waitFor(() =>
      expect(screen.queryByText('Finance quick starts')).not.toBeInTheDocument()
    )
  })

  it('pins the selected accessible Zoho account into the compiled request', async () => {
    const onSubmit = vi.fn()
    render(<FinanceQuickStarts onSubmit={onSubmit} />)
    await screen.findByText('Finance quick starts')

    expect(screen.getByRole('button', { name: /Branch Books/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Receivables/i }))
    fireEvent.change(screen.getByLabelText(/As of/i), {
      target: { value: '2026-07-13' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Run in Divo/i }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          account: {
            connectionId: 'books-branch',
            label: 'Branch Books',
          },
        }),
      })
    )
  })
})
