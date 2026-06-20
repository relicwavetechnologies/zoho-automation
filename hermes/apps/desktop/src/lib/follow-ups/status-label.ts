import type { FollowUpStatus } from './types'

const STATUS_LABEL: Record<FollowUpStatus, string> = {
  assigned: 'Assigned',
  starting: 'Starting',
  active: 'Active',
  paused: 'Paused',
  reassigned: 'Reassigned',
  done: 'Done',
  deleted: 'Deleted'
}

const STATUS_TONE: Record<FollowUpStatus, string> = {
  assigned: 'text-[#7fa9cf]',
  starting: 'text-[#eab064]',
  active: 'text-[#6fc08a]',
  paused: 'text-[#eab064]',
  reassigned: 'text-[#7fa9cf]',
  done: 'text-(--ui-text-tertiary)',
  deleted: 'text-(--ui-text-tertiary)'
}

export function followUpStatusLabel(status: FollowUpStatus): string {
  return STATUS_LABEL[status] ?? status
}

export function followUpStatusTone(status: FollowUpStatus): string {
  return STATUS_TONE[status] ?? 'text-(--ui-text-tertiary)'
}
