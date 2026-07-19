import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PiApprovalRequest } from '@/lib/pi/approval'
import { LarkRequest, larkSurface } from './LarkRequest'
import { LiveApprovalComposer } from './LiveApprovalComposer'

const baseProps = {
  position: 0,
  total: 1,
  now: 1_000,
  onMove: vi.fn(),
  onDecision: vi.fn(),
  onStop: vi.fn(),
}

function larkApprovalRequest(
  kind: string,
  details: Record<string, unknown>
): PiApprovalRequest {
  return {
    requestId: 'request-1',
    threadId: 'thread-1',
    descriptor: {
      version: 1,
      toolCallId: 'tool-call-1',
      source: 'generic',
      kind,
      action: 'create',
      title: 'Review lark doc create',
      presentation: { details },
    },
    receivedAt: 100,
    expiresAt: 10_000,
    status: 'pending',
  }
}

describe('larkSurface', () => {
  it('maps every Lark tool id to its surface', () => {
    expect(larkSurface('generic.larkMessaging.send')).toBe('messaging')
    expect(larkSurface('generic.larkTask.create')).toBe('task')
    expect(larkSurface('generic.larkDoc.create')).toBe('doc')
    expect(larkSurface('generic.larkCalendar.create')).toBe('calendar')
    expect(larkSurface('generic.larkBase.update')).toBe('base')
    expect(larkSurface('generic.larkApproval.create')).toBe('approval')
    expect(larkSurface('generic.larkContacts.read')).toBe('contacts')
  })

  it('folds meetings into the calendar surface', () => {
    expect(larkSurface('generic.larkMeeting.create')).toBe('calendar')
  })

  it('falls back to generic for an unknown Lark surface', () => {
    expect(larkSurface('generic.larkSomethingNew.create')).toBe('generic')
  })
})

describe('LarkRequest', () => {
  it('renders a message as an outgoing bubble with its recipient', () => {
    render(
      <LarkRequest
        identity="generic.larkmessaging.send"
        presentation={{ details: { to: 'Bhavesh Jaiswal', text: 'samjh gya' } }}
      />
    )
    expect(screen.getByText('Lark Messenger')).toBeInTheDocument()
    expect(screen.getByText('To Bhavesh Jaiswal')).toBeInTheDocument()
    expect(screen.getByText('samjh gya')).toBeInTheDocument()
  })

  it('renders a task with its assignee and due date', () => {
    render(
      <LarkRequest
        identity="generic.larktask.create"
        presentation={{
          details: { title: 'Draft follow-ups', assignee: 'Anish', due: 'Jul 20' },
        }}
      />
    )
    expect(screen.getByText('Lark Tasks')).toBeInTheDocument()
    expect(screen.getByText('Draft follow-ups')).toBeInTheDocument()
    expect(screen.getByText('Assignee · Anish')).toBeInTheDocument()
    expect(screen.getByText('Due · Jul 20')).toBeInTheDocument()
  })

  it('shows unconsumed fields rather than hiding them', () => {
    // An approval screen must never omit part of what is being approved.
    render(
      <LarkRequest
        identity="generic.larkdoc.create"
        presentation={{
          details: {
            title: 'My Daily Summary',
            connectionId: '279ecb0c',
            folderToken: 'fldxyz',
          },
        }}
      />
    )
    expect(screen.getByText('My Daily Summary')).toBeInTheDocument()
    expect(screen.getByText('folderToken')).toBeInTheDocument()
    expect(screen.getByText('fldxyz')).toBeInTheDocument()
  })

  it('stays readable when the surface has no recognised fields', () => {
    render(
      <LarkRequest identity="generic.larkbase.update" presentation={{ details: {} }} />
    )
    expect(screen.getByText('Lark Base')).toBeInTheDocument()
    expect(screen.getByText('Untitled item')).toBeInTheDocument()
  })
})

describe('LiveApprovalComposer with a Lark request', () => {
  it('brands the card as Lark and uses the Lark preview instead of raw JSON', () => {
    render(
      <LiveApprovalComposer
        {...baseProps}
        request={larkApprovalRequest('generic.larkDoc.create', {
          op: 'create',
          title: 'My Daily Summary — July 18, 2026',
        })}
      />
    )

    // Header says Lark, not the raw "generic" source.
    expect(screen.getByText(/Lark · create/)).toBeInTheDocument()
    expect(screen.getByText('Lark Docs')).toBeInTheDocument()
    expect(
      screen.getByText('My Daily Summary — July 18, 2026')
    ).toBeInTheDocument()
  })
})
