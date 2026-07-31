import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PiMemoryReviewRequest } from '@/lib/pi/memory-review'
import { MemoryReviewCard } from './MemoryReviewCard'

function request(
  overrides: Partial<PiMemoryReviewRequest> = {}
): PiMemoryReviewRequest {
  return {
    protocol: 'memory-review',
    requestId: 'review-1',
    threadId: 'thread-1',
    descriptor: {
      version: 1,
      proposalId: 'proposal-1',
      bullets: [
        { id: 'fact-1', text: 'Finance reviews refunds over ₹10K.' },
        { id: 'fact-2', text: 'Acme uses net-60 payment terms.' },
      ],
      allowedTargets: [
        { scope: 'personal', label: 'Personal' },
        {
          scope: 'department',
          label: 'Finance',
          departmentId: 'dept-1',
        },
      ],
    },
    status: 'pending',
    ...overrides,
  }
}

const baseProps = {
  position: 0,
  total: 1,
  onMove: vi.fn(),
}

describe('MemoryReviewCard', () => {
  it('removes bullets, selects only provided targets, and approves exact choices', () => {
    const onSubmit = vi.fn()
    render(
      <MemoryReviewCard
        {...baseProps}
        request={request()}
        onSubmit={onSubmit}
      />
    )

    expect(screen.getByText('Finance reviews refunds over ₹10K.')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Personal' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Finance' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Memory target'), {
      target: { value: 'department:dept-1' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove memory: Finance reviews refunds over ₹10K.',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remember 1 fact' }))

    expect(onSubmit).toHaveBeenCalledWith({
      version: 1,
      proposalId: 'proposal-1',
      decision: 'approve',
      selectedTarget: { scope: 'department', departmentId: 'dept-1' },
      selectedBulletIds: ['fact-2'],
    })
  })

  it('supports revision and cancellation without approval', () => {
    const onSubmit = vi.fn()
    render(
      <MemoryReviewCard
        {...baseProps}
        request={request()}
        onSubmit={onSubmit}
      />
    )

    const revise = screen.getByRole('button', {
      name: 'Propose a different memory',
    })
    expect(revise).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Memory revision'), {
      target: { value: 'Remember the escalation threshold instead.' },
    })
    fireEvent.click(revise)
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'revise',
        revision: 'Remember the escalation threshold instead.',
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSubmit).toHaveBeenLastCalledWith({
      version: 1,
      proposalId: 'proposal-1',
      decision: 'cancel',
      selectedTarget: null,
      selectedBulletIds: [],
    })
  })

  it('disables approval after every bullet is removed', () => {
    render(
      <MemoryReviewCard
        {...baseProps}
        request={request()}
        onSubmit={vi.fn()}
      />
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove memory: Finance reviews refunds over ₹10K.',
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove memory: Acme uses net-60 payment terms.',
      })
    )
    expect(screen.getByRole('button', { name: 'Remember 0 facts' })).toBeDisabled()
  })
})
