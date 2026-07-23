import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PiApprovalRequest } from '@/lib/pi/approval'
import type { PiMemoryReviewRequest } from '@/lib/pi/memory-review'
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

function memoryRequest(
  requestId: string,
  proposalId: string,
  bullets: PiMemoryReviewRequest['descriptor']['bullets'],
  allowedTargets: PiMemoryReviewRequest['descriptor']['allowedTargets']
): PiMemoryReviewRequest {
  return {
    protocol: 'memory-review',
    requestId,
    threadId: 'thread-1',
    descriptor: {
      version: 1,
      proposalId,
      bullets,
      allowedTargets,
    },
    status: 'pending',
  }
}

describe('LiveApprovalComposer', () => {
  it('remounts memory review form state when the active request changes', () => {
    const proposalA = memoryRequest(
      'review-a',
      'proposal-a',
      [
        { id: 'shared-id', text: 'Proposal A shared fact' },
        { id: 'a-only', text: 'Proposal A only fact' },
      ],
      [
        { scope: 'personal', label: 'Personal' },
        { scope: 'company', label: 'Company' },
      ]
    )
    const proposalB = memoryRequest(
      'review-b',
      'proposal-b',
      [
        { id: 'shared-id', text: 'Proposal B shared fact' },
        { id: 'b-only', text: 'Proposal B only fact' },
      ],
      [
        {
          scope: 'department',
          label: 'Finance',
          departmentId: 'dept-finance',
        },
        { scope: 'personal', label: 'Personal' },
      ]
    )

    const { rerender } = render(
      <LiveApprovalComposer {...baseProps} request={proposalA} />
    )
    fireEvent.change(screen.getByLabelText('Memory target'), {
      target: { value: 'company:' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove memory: Proposal A shared fact',
      })
    )
    fireEvent.change(screen.getByLabelText('Memory revision'), {
      target: { value: 'State that must not leak' },
    })

    rerender(<LiveApprovalComposer {...baseProps} request={proposalB} />)

    expect(screen.getByLabelText('Memory target')).toHaveValue(
      'department:dept-finance'
    )
    expect(screen.getByLabelText('Memory revision')).toHaveValue('')
    expect(
      screen.getByRole('button', { name: 'Remember 2 facts' })
    ).toBeEnabled()
    expect(screen.getByText('Proposal B shared fact')).toBeInTheDocument()
    expect(screen.queryByText('Proposal A only fact')).not.toBeInTheDocument()
  })

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

    fireEvent.click(screen.getByRole('button', { name: 'Allow only this time' }))
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

    expect(screen.getByRole('button', { name: 'Allow only this time' })).toBeDisabled()
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

  it('offers chat-scoped Bash approval only for Bash requests', () => {
    const onAllowBashForChat = vi.fn()
    const onAllowFullAccessForChat = vi.fn()
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
        onAllowBashForChat={onAllowBashForChat}
        onAllowFullAccessForChat={onAllowFullAccessForChat}
        request={bashRequest}
      />
    )

    expect(
      screen.getByText(/run later Bash commands in this chat/i)
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Always allow commands in this chat',
      })
    )
    expect(onAllowBashForChat).toHaveBeenCalledOnce()
    expect(
      screen.getByRole('button', { name: 'Give Divo full access to this chat' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Allow only this time' })
    ).toBeInTheDocument()

    rerender(
      <LiveApprovalComposer
        {...baseProps}
        onAllowBashForChat={onAllowBashForChat}
        onAllowFullAccessForChat={onAllowFullAccessForChat}
        request={request('gmail.send', { subject: 'Still gated' })}
      />
    )
    expect(
      screen.queryByRole('button', {
        name: 'Always allow commands in this chat',
      })
    ).not.toBeInTheDocument()
  })

  it('offers full chat access without weakening backend policy', () => {
    const onAllowFullAccessForChat = vi.fn()

    render(
      <LiveApprovalComposer
        {...baseProps}
        onAllowFullAccessForChat={onAllowFullAccessForChat}
        request={request('gmail.send', { subject: 'Still backend-gated' })}
      />
    )

    expect(
      screen.getByText(/backend permissions, rate limits, shared-connection rules/i)
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Give Divo full access to this chat' })
    )
    expect(onAllowFullAccessForChat).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'Always allow commands in this chat' })
    ).not.toBeInTheDocument()
  })

  it('offers only stop after an approval delivery failure', () => {
    const bashRequest = request(
      'bash.execute',
      { command: 'pwd' },
      {
        status: 'error',
        error:
          'The local Divo runtime could not deliver this approval. Stop the run and send the request again.',
        descriptor: {
          version: 1,
          toolCallId: 'tool-call-bash',
          source: 'bash',
          kind: 'bash.execute',
          action: 'execute',
          title: 'Run terminal command',
          presentation: { command: 'pwd' },
        },
      }
    )

    render(
      <LiveApprovalComposer
        {...baseProps}
        onAllowBashForChat={vi.fn()}
        onAllowFullAccessForChat={vi.fn()}
        request={bashRequest}
      />
    )

    expect(screen.getByText(/stop this run, then send the request again/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Always allow commands in this chat' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Give Divo full access to this chat' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Allow only this time' })).toBeDisabled()
  })

  function scheduleRequest(
    operation: string,
    action: string,
    details: Record<string, unknown>
  ): PiApprovalRequest {
    return {
      requestId: 'schedule-1',
      threadId: 'thread-1',
      descriptor: {
        version: 1,
        toolCallId: 'tool-call-1',
        source: 'generic',
        kind: `generic.scheduledWorkflows.${operation}`,
        action,
        title: `Review scheduled workflows ${operation}`,
        presentation: { details: { operation, ...details } },
      },
      receivedAt: 100,
      expiresAt: 10_000,
      status: 'pending',
    }
  }

  it('routes scheduler requests to the schedule card, not the JSON fallback', () => {
    render(
      <LiveApprovalComposer
        {...baseProps}
        request={scheduleRequest('create', 'create', {
          name: 'Daily Email Summary to Lark DM',
          intent: 'Summarise the last 24 hours of mail.',
          scheduleType: 'daily',
          timezone: 'Asia/Kolkata',
          hour: 3,
          timeMinute: 10,
        })}
      />
    )

    expect(screen.getByTestId('schedule-cadence')).toHaveTextContent(
      'Every day at 3:10 AM'
    )
    expect(screen.getByText('New scheduled work')).toBeInTheDocument()
    // The generic fallback dumps the whole presentation as JSON; the schedule
    // card replacing it is the point of this wiring.
    expect(screen.queryByText(/"scheduleType"/)).not.toBeInTheDocument()
  })

  it('names the schedule in the approve button instead of the CRUD verb', () => {
    render(
      <LiveApprovalComposer
        {...baseProps}
        request={scheduleRequest('create', 'create', {
          name: 'Daily summary',
          scheduleType: 'daily',
          hour: 3,
          timeMinute: 10,
        })}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Approve schedule' })
    ).toBeInTheDocument()
  })

  it('separates pause from resume, which share one descriptor action', () => {
    const { unmount } = render(
      <LiveApprovalComposer
        {...baseProps}
        request={scheduleRequest('pause', 'update', { scheduleId: 'abc' })}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Approve pause' })
    ).toBeInTheDocument()
    unmount()

    render(
      <LiveApprovalComposer
        {...baseProps}
        request={scheduleRequest('resume', 'update', { scheduleId: 'abc' })}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Approve resume' })
    ).toBeInTheDocument()
  })

  it('keeps a schedule whose intent mentions Gmail on the schedule card', () => {
    // appKind checks vendor substrings against the whole identity, so an intent
    // that names Gmail must not pull the request onto the Gmail card.
    render(
      <LiveApprovalComposer
        {...baseProps}
        request={scheduleRequest('create', 'create', {
          name: 'Gmail digest',
          intent: 'Read Gmail every morning.',
          scheduleType: 'daily',
          hour: 8,
          timeMinute: 0,
        })}
      />
    )
    expect(screen.getByTestId('schedule-cadence')).toBeInTheDocument()
    expect(screen.queryByText('Subject')).not.toBeInTheDocument()
  })
})
