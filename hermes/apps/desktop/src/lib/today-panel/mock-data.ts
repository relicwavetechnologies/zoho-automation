import { inferLifecycleActions } from '@/lib/follow-ups/lifecycle-actions'
import type { FollowUpRecord } from '@/lib/follow-ups/api-types'

import type { TodayDocItem, TodayMeeting, TodayNeedsYouItem, TodayPanelResponse } from './api-types'

const MOCK_TASKS: FollowUpRecord[] = [
  {
    id: 'lark:t1',
    title: 'Send Q2 finance report to Aaron',
    status: 'assigned',
    assignedByName: 'Lark Tasks',
    assigneeName: 'You',
    dueLabel: '2 days late',
    group: 'overdue',
    larkTaskGuid: 't1',
    lifecycleActions: inferLifecycleActions({ id: 'lark:t1', status: 'assigned' })
  },
  {
    id: 'fu-2',
    title: 'Review vendor contract — Zoho renewal',
    status: 'active',
    assignedByName: 'Vira',
    assigneeName: 'You',
    dueLabel: 'Yesterday',
    group: 'overdue',
    larkTaskGuid: 'fu-2-task',
    larkTaskUrl: 'https://example.larksuite.com/task/fu-2',
    trackingDocUrl: 'https://example.larksuite.com/doc/fu-2',
    delegatedTag: 'Divo Follow Up',
    followUpPolicyJson: { completion_summary_required: true },
    lifecycleActions: inferLifecycleActions({
      id: 'fu-2',
      status: 'active',
      trackingDocUrl: 'https://example.larksuite.com/doc/fu-2'
    })
  },
  {
    id: 'lark:t3',
    title: 'Finalize Divo memory design doc',
    status: 'assigned',
    assignedByName: 'Lark Tasks',
    assigneeName: 'You',
    dueLabel: '5:00 PM',
    group: 'today',
    larkTaskGuid: 't3',
    lifecycleActions: inferLifecycleActions({ id: 'lark:t3', status: 'assigned' })
  },
  {
    id: 'lark:t4',
    title: 'Reply to Aaron re: gateway rollout',
    status: 'assigned',
    assignedByName: 'Lark Tasks',
    assigneeName: 'You',
    dueLabel: 'EOD',
    group: 'today',
    larkTaskGuid: 't4',
    lifecycleActions: inferLifecycleActions({ id: 'lark:t4', status: 'assigned' })
  },
  {
    id: 'lark:t5',
    title: 'Approve design tokens PR',
    status: 'assigned',
    assignedByName: 'Lark Tasks',
    assigneeName: 'You',
    dueLabel: 'EOD',
    group: 'today',
    larkTaskGuid: 't5',
    lifecycleActions: inferLifecycleActions({ id: 'lark:t5', status: 'assigned' })
  }
]

const MOCK_MEETINGS: TodayMeeting[] = [
  {
    id: 'cal:m1',
    eventId: 'm1',
    time: '10:00',
    title: 'Product sync',
    sub: '30m · Lark VC',
    startTime: new Date().toISOString(),
    soon: true,
    vcUrl: 'https://vc.larksuite.com/meet/1',
    durationMin: 30,
    attendeeCount: 6
  },
  {
    id: 'cal:m2',
    eventId: 'm2',
    time: '14:00',
    title: 'Design review',
    sub: '45m · 4 guests',
    durationMin: 45,
    attendeeCount: 4
  },
  {
    id: 'cal:m3',
    eventId: 'm3',
    time: '16:30',
    title: '1:1 with Aaron',
    sub: '30m',
    durationMin: 30
  },
  {
    id: 'cal:m4',
    eventId: 'm4',
    time: '18:00',
    title: 'Client demo — Acme',
    sub: '45m · 6 guests',
    durationMin: 45,
    attendeeCount: 6
  }
]

const MOCK_NEEDS_YOU: TodayNeedsYouItem[] = [
  {
    id: 'mention:n1',
    kind: 'mention',
    title: '@you in #eng-platform',
    meta: 'Aaron asked for Q2 numbers · 1h ago',
    messageId: 'msg1',
    chatId: 'chat1'
  },
  {
    id: 'approval:a1',
    kind: 'approval',
    title: 'Approve: Zoho Books renewal',
    meta: 'Procurement · Waiting 2 days',
    instanceCode: 'inst1',
    approvalCode: 'appr1'
  }
]

const MOCK_DOCS: TodayDocItem[] = [
  {
    id: 'wiki:d1',
    kind: 'wiki',
    title: 'Divo Follow Ups / Updates',
    meta: 'Wiki · Edited 2h ago',
    tag: 'Wiki'
  },
  {
    id: 'doc:d2',
    kind: 'doc',
    title: 'Q3 enterprise rollout — tracking doc',
    meta: 'Active follow-up',
    docUrl: 'https://example.larksuite.com/doc/fu-2',
    tag: 'Tracking doc'
  }
]

export function createMockTodayPanelResponse(): TodayPanelResponse {
  const activeFollowUps = MOCK_TASKS.filter(
    record =>
      record.lifecycleActions?.isFollowUp && ['active', 'starting'].includes(record.status)
  ).map(record => ({
    id: record.id,
    title: record.title,
    status: record.status,
    assigneeName: record.assigneeName,
    assignedByName: record.assignedByName,
    dueLabel: record.dueLabel,
    trackingDocUrl: record.trackingDocUrl,
    lifecycleActions: record.lifecycleActions
  }))

  return {
    company_id: 'mock-company',
    dateLabel: new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    syncedAt: new Date().toISOString(),
    tasks: MOCK_TASKS,
    meetings: MOCK_MEETINGS,
    activeFollowUps,
    needsYou: MOCK_NEEDS_YOU,
    docs: MOCK_DOCS
  }
}

export function createEmptyTodayPanelResponse(): TodayPanelResponse {
  return {
    company_id: '',
    dateLabel: new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    syncedAt: new Date().toISOString(),
    tasks: [],
    meetings: [],
    activeFollowUps: [],
    needsYou: [],
    docs: []
  }
}
