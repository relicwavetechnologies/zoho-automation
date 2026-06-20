import type { FollowUpRecord } from '@/lib/follow-ups/api-types'

export const TODAY_PANEL_API_PATHS = {
  today: '/api/company/today'
} as const

export interface TodayMeeting {
  id: string
  eventId: string
  time: string
  title: string
  sub: string
  startTime?: string | null
  endTime?: string | null
  vcUrl?: string | null
  durationMin?: number | null
  attendeeCount?: number | null
  soon?: boolean
}

export interface TodayActiveFollowUp {
  id: string
  title: string
  status: string
  assigneeName?: string
  assignedByName?: string
  dueLabel?: string
  trackingDocUrl?: string | null
  lifecycleActions: FollowUpRecord['lifecycleActions']
}

export interface TodayNeedsYouItem {
  id: string
  kind: 'approval' | 'mention'
  title: string
  meta: string
  instanceCode?: string
  approvalCode?: string
  messageId?: string
  chatId?: string
}

export interface TodayDocItem {
  id: string
  kind: 'doc' | 'wiki'
  title: string
  meta: string
  docToken?: string | null
  docUrl?: string | null
  tag?: string
}

export interface TodayPanelResponse {
  company_id: string
  dateLabel: string
  syncedAt: string
  tasks: FollowUpRecord[]
  meetings: TodayMeeting[]
  activeFollowUps: TodayActiveFollowUp[]
  needsYou: TodayNeedsYouItem[]
  docs: TodayDocItem[]
}

export class TodayPanelClientError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'TodayPanelClientError'
  }
}
