import type { FollowUpLifecycleActions, FollowUpRecord } from './api-types'
import type { FollowUpTask } from './types'

export const PLAIN_LARK_LIFECYCLE_ACTIONS: FollowUpLifecycleActions = {
  isFollowUp: false,
  canStart: false,
  canPause: false,
  canUpdateDoc: false,
  canComplete: false,
  canReassign: false,
  canOpenTrackingDoc: false,
  requiresCompletionSummary: false
}

/** Fallback when mock rows omit server affordance metadata. */
export function inferLifecycleActions(
  record: Pick<
    FollowUpRecord,
    'id' | 'status' | 'trackingDocUrl' | 'trackingDocToken' | 'lifecycleActions' | 'followUpPolicyJson'
  >
): FollowUpLifecycleActions {
  if (record.lifecycleActions) {
    return record.lifecycleActions
  }

  if (record.id.startsWith('lark:')) {
    return PLAIN_LARK_LIFECYCLE_ACTIONS
  }

  const hasDoc = Boolean(record.trackingDocUrl || record.trackingDocToken)
  const status = record.status

  return {
    isFollowUp: true,
    canStart: status === 'assigned' || status === 'starting' || status === 'paused',
    canPause: status === 'active',
    canUpdateDoc: status === 'active' && hasDoc,
    canComplete: status === 'active',
    canReassign: false,
    canOpenTrackingDoc: hasDoc,
    requiresCompletionSummary: Boolean(record.followUpPolicyJson?.completion_summary_required ?? true)
  }
}

export function taskLifecycleActions(task: FollowUpTask): FollowUpLifecycleActions {
  return task.lifecycleActions
}

export function canRunFollowUpLifecycle(task: FollowUpTask): boolean {
  return task.lifecycleActions.isFollowUp
}
