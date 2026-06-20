/** Divo Follow Ups UI types — mock-backed until Wave 5 read APIs land. */

import type { FollowUpLifecycleActions } from './api-types'

export type FollowUpStatus =
  | 'assigned'
  | 'starting'
  | 'active'
  | 'paused'
  | 'reassigned'
  | 'done'
  | 'deleted'

export type FollowUpPolicyPreset = 'start_pause_done' | 'start_done' | 'only_done'

export type FollowUpTaskGroup = 'overdue' | 'today' | 'upcoming'

/** `plain_lark` = merged Lark open task (`lark:<id>`). `divo_follow_up` = tracked Divo row. */
export type FollowUpTaskKind = 'plain_lark' | 'divo_follow_up'

export interface FollowUpTask {
  id: string
  kind: FollowUpTaskKind
  lifecycleActions: FollowUpLifecycleActions
  title: string
  assignedBy: string
  assigneeName: string
  dueLabel: string
  status: FollowUpStatus
  group: FollowUpTaskGroup
  notes?: string
  larkTaskUrl?: string
  trackingDocUrl?: string
  delegatedTag?: string
}

export interface FollowUpCreateDraft {
  title: string
  assignee: string
  dueDate: string
  notes: string
  policyPreset: FollowUpPolicyPreset
}

export interface FollowUpAssigneeOption {
  id: string
  name: string
  initials: string
}
