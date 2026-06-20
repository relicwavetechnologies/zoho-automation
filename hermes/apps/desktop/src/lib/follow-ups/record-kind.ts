import type { FollowUpRecord } from './api-types'
import type { FollowUpTask, FollowUpTaskKind } from './types'

/** Plain Lark open tasks use synthetic `lark:<taskId>` ids from FU-401 merge. */
export function followUpRecordKind(record: FollowUpRecord): FollowUpTaskKind {
  if (record.lifecycleActions) {
    return record.lifecycleActions.isFollowUp ? 'divo_follow_up' : 'plain_lark'
  }
  return record.id.startsWith('lark:') ? 'plain_lark' : 'divo_follow_up'
}

export function isDivoFollowUpRecord(record: FollowUpRecord): boolean {
  return followUpRecordKind(record) === 'divo_follow_up'
}

export function isPlainLarkTaskRecord(record: FollowUpRecord): boolean {
  return followUpRecordKind(record) === 'plain_lark'
}

export function isDivoFollowUpTask(task: FollowUpTask): boolean {
  return task.lifecycleActions.isFollowUp
}

export function isPlainLarkTask(task: FollowUpTask): boolean {
  return !task.lifecycleActions.isFollowUp
}
