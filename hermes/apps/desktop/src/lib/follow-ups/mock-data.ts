import type { FollowUpAssigneeOption, FollowUpPolicyPreset, FollowUpTask } from './types'
import { inferLifecycleActions } from './lifecycle-actions'

export const FOLLOW_UP_POLICY_PRESETS: ReadonlyArray<{
  id: FollowUpPolicyPreset
  label: string
}> = [
  { id: 'start_pause_done', label: 'Start + Pause + Done' },
  { id: 'start_done', label: 'Start + Done' },
  { id: 'only_done', label: 'Only Done' }
]

export const MOCK_FOLLOW_UP_ASSIGNEES: FollowUpAssigneeOption[] = [
  { id: 'anish', name: 'Anish', initials: 'AN' },
  { id: 'suman', name: 'Suman', initials: 'SU' },
  { id: 'rahul', name: 'Rahul Sharma', initials: 'RS' }
]

export const MOCK_FOLLOW_UP_TASKS: FollowUpTask[] = [
  {
    id: 'fu-1',
    kind: 'divo_follow_up',
    lifecycleActions: inferLifecycleActions({ id: 'fu-1', status: 'assigned' }),
    title: 'Prepare Q3 enterprise rollout brief',
    assignedBy: 'Vira',
    assigneeName: 'Anish',
    dueLabel: 'Tomorrow EOD',
    status: 'assigned',
    group: 'today',
    notes: 'Use the source chat and prior rollout notes.',
    larkTaskUrl: 'https://example.larksuite.com/task/fu-1',
    delegatedTag: 'Divo Follow Up'
  },
  {
    id: 'fu-2',
    kind: 'divo_follow_up',
    lifecycleActions: inferLifecycleActions({
      id: 'fu-2',
      status: 'active',
      trackingDocUrl: 'https://example.larksuite.com/doc/fu-2'
    }),
    title: 'Review vendor contract — Zoho renewal',
    assignedBy: 'Abhishek',
    assigneeName: 'Anish',
    dueLabel: 'Yesterday',
    status: 'active',
    group: 'overdue',
    larkTaskUrl: 'https://example.larksuite.com/task/fu-2',
    trackingDocUrl: 'https://example.larksuite.com/doc/fu-2',
    delegatedTag: 'From Vira'
  },
  {
    id: 'fu-3',
    kind: 'divo_follow_up',
    lifecycleActions: inferLifecycleActions({
      id: 'fu-3',
      status: 'paused',
      trackingDocUrl: 'https://example.larksuite.com/doc/fu-3'
    }),
    title: 'Draft client demo talking points',
    assignedBy: 'Vira',
    assigneeName: 'Anish',
    dueLabel: 'Fri',
    status: 'paused',
    group: 'upcoming',
    larkTaskUrl: 'https://example.larksuite.com/task/fu-3',
    trackingDocUrl: 'https://example.larksuite.com/doc/fu-3',
    delegatedTag: 'Divo Follow Up'
  }
]

export function defaultFollowUpCreateDraft(): {
  title: string
  assignee: string
  dueDate: string
  notes: string
  policyPreset: FollowUpPolicyPreset
} {
  return {
    title: '',
    assignee: MOCK_FOLLOW_UP_ASSIGNEES[0]?.id ?? '',
    dueDate: 'tomorrow',
    notes: '',
    policyPreset: 'start_pause_done'
  }
}
