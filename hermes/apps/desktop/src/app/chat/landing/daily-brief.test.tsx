import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMockFollowUpsClient, PLAIN_LARK_LIFECYCLE_ACTIONS } from '@/lib/follow-ups'
import type { FollowUpLifecycleActions, FollowUpRecord } from '@/lib/follow-ups/api-types'

import { DailyBrief } from './daily-brief'

const ACTIVE_ASSIGNEE_ACTIONS: FollowUpLifecycleActions = {
  isFollowUp: true,
  canStart: false,
  canPause: true,
  canUpdateDoc: true,
  canComplete: true,
  canReassign: false,
  canOpenTrackingDoc: true,
  requiresCompletionSummary: true
}

const DIVO_RECORD: FollowUpRecord = {
  id: 'fu_daily',
  title: 'Prepare Q2 renewal notes',
  status: 'active',
  assignedByName: 'Vira',
  assigneeName: 'Anish',
  dueLabel: 'Today EOD',
  dueDate: '2026-06-18',
  group: 'today',
  delegatedTag: 'Divo Follow Up',
  trackingDocUrl: 'https://larksuite.example/doc/doc_token_1',
  lifecycleActions: ACTIVE_ASSIGNEE_ACTIONS
}

const PLAIN_LARK_RECORD: FollowUpRecord = {
  id: 'lark:plain_task',
  title: 'Plain Lark task',
  status: 'assigned',
  assignedByName: 'Lark Tasks',
  assigneeName: 'Anish',
  dueLabel: 'Tomorrow',
  dueDate: '2026-06-19',
  group: 'upcoming',
  larkTaskGuid: 'plain_task',
  larkTaskUrl: 'https://larksuite.example/task/plain_task',
  lifecycleActions: PLAIN_LARK_LIFECYCLE_ACTIONS
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DailyBrief follow-up task seam', () => {
  it('renders merged follow-up client tasks in the Lark-style task groups', async () => {
    const onToggleReference = vi.fn()
    const client = createMockFollowUpsClient({
      initialTasks: [DIVO_RECORD, PLAIN_LARK_RECORD]
    })

    render(
      <DailyBrief
        followUpsClient={client}
        onToggleReference={onToggleReference}
        onUsePrompt={() => undefined}
        referencedIds={new Set()}
        scrollRef={{ current: null }}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Prepare Q2 renewal notes')).toBeTruthy()
      expect(screen.getByText('Plain Lark task')).toBeTruthy()
    })

    expect(screen.getByText('From Vira')).toBeTruthy()
    expect(screen.getByText('Divo Follow Up')).toBeTruthy()

    fireEvent.click(screen.getByText('Prepare Q2 renewal notes'))

    expect(onToggleReference).toHaveBeenCalledWith({
      detail: 'Today EOD',
      id: 'fu_daily',
      kind: 'task',
      label: 'Prepare Q2 renewal notes'
    })
  })

  it('falls back to the original mock tasks when the follow-up client fails', async () => {
    const client = {
      ...createMockFollowUpsClient(),
      listTaskMetadata: vi.fn().mockRejectedValue(new Error('offline'))
    }

    render(
      <DailyBrief
        followUpsClient={client}
        onToggleReference={() => undefined}
        onUsePrompt={() => undefined}
        referencedIds={new Set()}
        scrollRef={{ current: null }}
      />
    )

    expect(screen.getByText('Send Q2 finance report to Aaron')).toBeTruthy()
  })
})
