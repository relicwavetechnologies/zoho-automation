// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { inferLifecycleActions } from '@/lib/follow-ups/lifecycle-actions'
import type { FollowUpRecord } from '@/lib/follow-ups/api-types'
import { createMockTodayPanelResponse } from '@/lib/today-panel/mock-data'

import { TodayPanel } from './today-panel'

const mockData = createMockTodayPanelResponse()

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TodayPanel', () => {
  it('renders today sections and pins context on row click', () => {
    const onToggleReference = vi.fn()
    const taskRecordsById = new Map(mockData.tasks.map(record => [record.id, record]))
    const meetingsById = new Map(mockData.meetings.map(meeting => [meeting.id, meeting]))

    render(
      <TodayPanel
        activeFollowUps={mockData.activeFollowUps}
        counts={{ overdue: 2, today: 3, meetings: 4 }}
        dateLabel={mockData.dateLabel}
        docs={mockData.docs}
        meetings={mockData.meetings.map(meeting => ({
          id: meeting.id,
          time: meeting.time,
          title: meeting.title,
          sub: meeting.sub,
          soon: meeting.soon
        }))}
        meetingsById={meetingsById}
        needsYou={mockData.needsYou}
        nextMeeting={mockData.meetings[0] ?? null}
        onSummarizeDay={() => undefined}
        onToggleReference={onToggleReference}
        onUsePrompt={() => undefined}
        referencedIds={new Set()}
        syncedAt={mockData.syncedAt}
        taskRecordsById={taskRecordsById}
        tasks={mockData.tasks.map(record => ({
          id: record.id,
          title: record.title,
          meta: record.dueLabel,
          group: record.group,
          tag: record.delegatedTag
        }))}
      />
    )

    expect(screen.getByText('Your day')).toBeTruthy()
    expect(screen.getByText('Needs you')).toBeTruthy()
    expect(screen.getByText('Wiki & docs')).toBeTruthy()
    expect(screen.getByText('Plan my day')).toBeTruthy()

    fireEvent.click(screen.getByText('Send Q2 finance report to Aaron'))

    expect(onToggleReference).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'lark:t1',
        kind: 'task',
        larkRef: '@lark-task:t1'
      })
    )
  })
})
