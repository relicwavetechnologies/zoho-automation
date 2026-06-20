import { followUpRecordToTask } from '@/lib/follow-ups/map-task'
import type { FollowUpTask } from '@/lib/follow-ups/types'
import { followUpStatusLabel } from '@/lib/follow-ups/status-label'

import type { TodayMeeting, TodayPanelResponse } from './api-types'

export type TaskGroup = 'overdue' | 'today' | 'upcoming'

export interface BriefTask {
  id: string
  title: string
  meta: string
  late?: boolean
  ownerLabel?: string
  tag?: string
  group: TaskGroup
}

export interface BriefMeeting {
  id: string
  time: string
  title: string
  sub: string
  soon?: boolean
}

export function briefTaskFromFollowUpTask(task: FollowUpTask): BriefTask {
  const isFollowUp = task.lifecycleActions.isFollowUp
  const status = followUpStatusLabel(task.status)

  return {
    id: task.id,
    title: task.title,
    meta: task.dueLabel,
    late: task.group === 'overdue',
    ownerLabel: isFollowUp ? task.assignedBy : undefined,
    tag: isFollowUp ? task.delegatedTag ?? 'Divo Follow Up' : status,
    group: task.group
  }
}

export function briefMeetingFromTodayMeeting(meeting: TodayMeeting): BriefMeeting {
  return {
    id: meeting.id,
    time: meeting.time,
    title: meeting.title,
    sub: meeting.sub,
    soon: meeting.soon
  }
}

export function mapTodayPanelToBrief(data: TodayPanelResponse) {
  const tasks = data.tasks.map(record => briefTaskFromFollowUpTask(followUpRecordToTask(record)))
  const meetings = data.meetings.map(briefMeetingFromTodayMeeting)

  const counts = {
    overdue: tasks.filter(task => task.group === 'overdue').length,
    today: tasks.filter(task => task.group === 'today').length,
    meetings: meetings.length
  }

  const nextMeeting = data.meetings[0] ?? null

  return {
    dateLabel: data.dateLabel,
    syncedAt: data.syncedAt,
    tasks,
    meetings,
    counts,
    nextMeeting,
    activeFollowUps: data.activeFollowUps,
    needsYou: data.needsYou,
    docs: data.docs
  }
}

export function buildDayPrompt(
  data: Pick<TodayPanelResponse, 'tasks' | 'meetings'>,
  scope: 'all' | 'overdue'
): string {
  const brief = mapTodayPanelToBrief({
    ...data,
    company_id: '',
    dateLabel: '',
    syncedAt: '',
    activeFollowUps: [],
    needsYou: [],
    docs: []
  })

  const byGroup = (group: TaskGroup) => brief.tasks.filter(task => task.group === group)
  const lines: string[] = []

  if (scope === 'overdue') {
    lines.push('I have overdue Lark tasks — help me clear them fast.', '')
    lines.push('[OVERDUE]')
    byGroup('overdue').forEach(task => lines.push(`- ${task.title} — ${task.meta}`))
    lines.push('', 'For each: the single fastest next action, and draft any message I need to send.')
    return lines.join('\n')
  }

  lines.push("Here's my day from Lark — help me run it.", '')
  const overdue = byGroup('overdue')
  if (overdue.length) {
    lines.push(`[OVERDUE · ${overdue.length}]`)
    overdue.forEach(task => lines.push(`- ${task.title} — ${task.meta}`))
    lines.push('')
  }

  const today = byGroup('today')
  if (today.length) {
    lines.push(`[DUE TODAY · ${today.length}]`)
    today.forEach(task => lines.push(`- ${task.title} — ${task.meta}`))
    lines.push('')
  }

  if (brief.meetings.length) {
    lines.push(`[MEETINGS · ${brief.meetings.length}]`)
    brief.meetings.forEach(meeting => lines.push(`- ${meeting.time} ${meeting.title} (${meeting.sub})`))
    lines.push('')
  }

  lines.push(
    'Please:',
    '1. Order what I should tackle first, around the meetings.',
    '2. Flag anything I can delegate or defer.',
    '3. Draft any messages I need to send.'
  )

  return lines.join('\n')
}
