import type { CreateFollowUpRequest, FollowUpRecord } from './api-types'
import { inferLifecycleActions } from './lifecycle-actions'
import { followUpRecordKind } from './record-kind'
import type { FollowUpCreateDraft, FollowUpTask } from './types'
import { MOCK_FOLLOW_UP_ASSIGNEES } from './mock-data'

export function dueLabelFromChip(chip: string): string {
  if (chip === 'today') {
    return 'Today EOD'
  }
  if (chip === 'tomorrow') {
    return 'Tomorrow EOD'
  }
  return 'Custom date'
}

export function taskGroupFromDueChip(chip: string): FollowUpTask['group'] {
  if (chip === 'today' || chip === 'tomorrow') {
    return 'today'
  }
  return 'upcoming'
}

export function createRequestFromDraft(
  draft: FollowUpCreateDraft,
  options?: { sourceSessionId?: string }
): CreateFollowUpRequest {
  const assignee = MOCK_FOLLOW_UP_ASSIGNEES.find(option => option.id === draft.assignee)

  return {
    title: draft.title.trim(),
    assigneeId: draft.assignee,
    assigneeQuery: assignee?.name,
    dueDate: draft.dueDate,
    notes: draft.notes.trim() || undefined,
    policyPreset: draft.policyPreset,
    sourceSessionId: options?.sourceSessionId
  }
}

export function followUpRecordToTask(record: FollowUpRecord): FollowUpTask {
  const lifecycleActions = inferLifecycleActions(record)
  const kind = followUpRecordKind(record)
  return {
    id: record.id,
    kind,
    lifecycleActions,
    title: record.title,
    assignedBy: record.assignedByName,
    assigneeName: record.assigneeName,
    dueLabel: record.dueLabel,
    status: record.status,
    group: record.group,
    notes: record.notes,
    larkTaskUrl: record.larkTaskUrl,
    trackingDocUrl: record.trackingDocUrl,
    delegatedTag: kind === 'divo_follow_up' ? record.delegatedTag ?? 'Divo Follow Up' : undefined
  }
}

export function followUpTaskToRecord(task: FollowUpTask): FollowUpRecord {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignedByName: task.assignedBy,
    assigneeName: task.assigneeName,
    dueLabel: task.dueLabel,
    group: task.group,
    notes: task.notes,
    larkTaskUrl: task.larkTaskUrl,
    trackingDocUrl: task.trackingDocUrl,
    delegatedTag: task.kind === 'divo_follow_up' ? task.delegatedTag ?? 'Divo Follow Up' : undefined,
    lifecycleActions: task.lifecycleActions
  }
}
