/** API contract DTOs for Dex Divo Follow Ups (Wave 5 bridge prep). */

import type { FollowUpPolicyPreset, FollowUpStatus, FollowUpTaskGroup } from './types'

export interface FollowUpLifecycleActions {
  isFollowUp: boolean
  canStart: boolean
  canPause: boolean
  canUpdateDoc: boolean
  canComplete: boolean
  canReassign: boolean
  canOpenTrackingDoc: boolean
  requiresCompletionSummary: boolean
}

export const FOLLOW_UP_API_PATHS = {
  create: '/api/company/follow-ups',
  list: '/api/company/follow-ups',
  detail: (followUpId: string) => `/api/company/follow-ups/${encodeURIComponent(followUpId)}`,
  startIntent: (followUpId: string) =>
    `/api/company/follow-ups/${encodeURIComponent(followUpId)}/start-intent`,
  pause: (followUpId: string) => `/api/company/follow-ups/${encodeURIComponent(followUpId)}/pause`,
  updateDoc: (followUpId: string) =>
    `/api/company/follow-ups/${encodeURIComponent(followUpId)}/update-doc`,
  complete: (followUpId: string) => `/api/company/follow-ups/${encodeURIComponent(followUpId)}/complete`
} as const

export interface CreateFollowUpRequest {
  title: string
  assigneeId: string
  assigneeQuery?: string
  dueDate: string
  notes?: string
  policyPreset: FollowUpPolicyPreset
  sourceSessionId?: string
}

export interface FollowUpRecord {
  id: string
  title: string
  status: FollowUpStatus
  assignedByName: string
  assigneeName: string
  dueLabel: string
  dueDate?: string
  group: FollowUpTaskGroup
  notes?: string
  larkTaskGuid?: string
  larkTaskUrl?: string
  trackingDocToken?: string
  trackingDocUrl?: string
  delegatedTag?: string
  followUpPolicyJson?: Record<string, unknown>
  lifecycleActions?: FollowUpLifecycleActions
}

export interface CreateFollowUpResponse {
  followUp: FollowUpRecord
}

export interface ListFollowUpTasksResponse {
  /** Present on Hermes list route; ignored by UI today. */
  company_id?: string
  tasks: FollowUpRecord[]
}

export interface FollowUpDetailResponse {
  followUp: FollowUpRecord
}

export interface StartFollowUpIntentRequest {
  followUpId: string
  activeSessionId?: string
}

export interface FollowUpActionRequest {
  followUpId: string
  reason?: string
}

export interface CompleteFollowUpRequest {
  followUpId: string
  summary?: string
}

export interface UpdateFollowUpDocRequest {
  followUpId: string
  note: string
}

export interface FollowUpActionResponse {
  followUp: FollowUpRecord
}

export class FollowUpsClientError extends Error {
  constructor(
    message: string,
    readonly code = 'follow_up_client_error'
  ) {
    super(message)
    this.name = 'FollowUpsClientError'
  }
}
