import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PiApprovalRequest } from '@/lib/pi/approval'
import { LiveApprovalComposer } from './LiveApprovalComposer'

function request(
  kind: string,
  presentation: Record<string, unknown>,
  overrides: Partial<PiApprovalRequest> = {}
): PiApprovalRequest {
  return {
    requestId: 'request-1',
    threadId: 'thread-1',
    descriptor: {
      version: 1,
      toolCallId: 'tool-call-1',
      source: 'divo',
      kind,
      action: kind.includes('send') ? 'send' : 'update',
      title: kind.includes('gmail')
        ? 'Review email before sending'
        : 'Review deal update',
      presentation,
    },
    receivedAt: 100,
    expiresAt: 10_000,
    status: 'pending',
    ...overrides,
  }
}

const baseProps = {
  position: 0,
  total: 1,
  now: 1_000,
  onMove: vi.fn(),
  onDecision: vi.fn(),
  onStop: vi.fn(),
}

describe('LiveApprovalComposer', () => {
  it('renders Gmail fields from the validated presentation', () => {
    const onDecision = vi.fn()
    render(
      <LiveApprovalComposer
        {...baseProps}
        onDecision={onDecision}
        request={request('gmail.send', {
          provider: 'gmail',
          details: {
            from: { name: 'Abhishek', email: 'abhishek@example.com' },
            to: [{ name: 'Maya', email: 'maya@example.com' }],
            subject: 'Q3 rollout',
            body: 'Hi Maya,\nHere is the plan.',
            attachments: [{ name: 'plan.pdf' }],
          },
        })}
      />
    )

    expect(screen.getByText('Abhishek · abhishek@example.com')).toBeInTheDocument()
    expect(screen.getByText('Maya · maya@example.com')).toBeInTheDocument()
    expect(screen.getByText('Q3 rollout')).toBeInTheDocument()
    expect(screen.getByText(/Here is the plan/)).toBeInTheDocument()
    expect(screen.getByText('plan.pdf')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Approve & send' }))
    expect(onDecision).toHaveBeenCalledWith(true)
  })

  it('renders Zoho field changes and queue navigation', () => {
    const onMove = vi.fn()
    render(
      <LiveApprovalComposer
        {...baseProps}
        total={2}
        onMove={onMove}
        request={request('zoho.crm.update', {
          provider: 'zoho',
          details: {
            module: 'Deal',
            recordId: 'D-1842',
            recordName: 'Atlas Expansion',
            changes: [
              { field: 'Stage', before: 'Proposal', after: 'Closed Won' },
            ],
          },
        })}
      />
    )

    expect(screen.getByText('Atlas Expansion')).toBeInTheDocument()
    expect(screen.getByText('Proposal')).toBeInTheDocument()
    expect(screen.getByText('Closed Won')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next pending approval' }))
    expect(onMove).toHaveBeenCalledWith(1)
  })

  it('disables approval for stale requests but retains safe denial', () => {
    const onDecision = vi.fn()
    render(
      <LiveApprovalComposer
        {...baseProps}
        now={20_000}
        onDecision={onDecision}
        request={request('gmail.send', {}, { expiresAt: 10_000 })}
      />
    )

    expect(screen.getByRole('button', { name: 'Approve & send' })).toBeDisabled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Deny expired request' })
    )
    expect(onDecision).toHaveBeenCalledWith(false)
  })

  it('retains an explicit stop action while the composer is transformed', () => {
    const onStop = vi.fn()
    render(
      <LiveApprovalComposer
        {...baseProps}
        onStop={onStop}
        request={request('gmail.send', { subject: 'Pending email' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('offers task-scoped always allow only for Bash requests', () => {
    const onAlwaysAllowBash = vi.fn()
    const bashRequest = request(
      'bash.execute',
      { command: 'npm test' },
      {
        descriptor: {
          version: 1,
          toolCallId: 'tool-call-bash',
          source: 'bash',
          kind: 'bash.execute',
          action: 'execute',
          title: 'Run terminal command',
          presentation: { command: 'npm test' },
        },
      }
    )

    const { rerender } = render(
      <LiveApprovalComposer
        {...baseProps}
        onAlwaysAllowBash={onAlwaysAllowBash}
        request={bashRequest}
      />
    )

    expect(
      screen.getByText(/future terminal commands in this task/i)
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Always allow Bash for this task',
      })
    )
    expect(onAlwaysAllowBash).toHaveBeenCalledOnce()

    rerender(
      <LiveApprovalComposer
        {...baseProps}
        onAlwaysAllowBash={onAlwaysAllowBash}
        request={request('gmail.send', { subject: 'Still gated' })}
      />
    )
    expect(
      screen.queryByRole('button', {
        name: 'Always allow Bash for this task',
      })
    ).not.toBeInTheDocument()
  })
})
