import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ invoke: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }))
vi.mock('lucide-react', () => {
  const Icon = () => null
  return { Check: Icon, Clock: Icon, ShieldQuestion: Icon, X: Icon }
})

import { ApprovalInbox } from '../ApprovalInbox'

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'approval-1',
  toolId: 'googleGmail',
  action: 'send',
  status: 'pending',
  requestedAt: '2026-07-26T10:00:00Z',
  expiresAt: null,
  requestedByName: 'Aman Gupta',
  approverName: 'Priya Nair',
  departmentName: 'Finance',
  deliveredVia: 'desktop',
  description: { tool: 'Gmail', title: 'Send email', details: [{ label: 'To', value: 'boss@example.com' }] },
  payload: {},
  ...overrides,
})

beforeEach(() => {
  h.invoke.mockReset()
  h.toastSuccess.mockReset()
  h.toastError.mockReset()
})

describe('ApprovalInbox', () => {
  it('renders nothing at all when there is nothing waiting', async () => {
    h.invoke.mockResolvedValue({ awaitingMe: [], requestedByMe: [] })
    const { container } = render(<ApprovalInbox />)
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
  })

  // The decision has landed on the backend; the row must not linger as if it
  // were still actionable, and must not come back on a refetch.
  it('drops a decided request from the list without refetching it', async () => {
    h.invoke.mockImplementation(async (command: string) =>
      command === 'divo_approval_inbox' ? { awaitingMe: [item()], requestedByMe: [] } : { ok: true })

    render(<ApprovalInbox />)
    await screen.findByText('Send email')

    await userEvent.click(screen.getByRole('button', { name: /approve/i }))

    await waitFor(() => expect(screen.queryByText('Send email')).toBeNull())
    expect(h.invoke).toHaveBeenCalledWith('divo_approval_decide', { approvalId: 'approval-1', decision: 'approved' })
    expect(h.invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps the request visible when the decision could not be recorded', async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === 'divo_approval_inbox') return { awaitingMe: [item()], requestedByMe: [] }
      throw new Error('offline')
    })

    render(<ApprovalInbox />)
    await screen.findByText('Send email')
    await userEvent.click(screen.getByRole('button', { name: /reject/i }))

    await waitFor(() => expect(h.toastError).toHaveBeenCalled())
    expect(screen.getByText('Send email')).toBeTruthy()
  })

  it('offers no decision buttons for a request waiting on someone else', async () => {
    h.invoke.mockResolvedValue({ awaitingMe: [], requestedByMe: [item({ id: 'approval-2' })] })

    render(<ApprovalInbox />)
    await screen.findByText(/Waiting on Priya Nair/)
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull()
  })
})
