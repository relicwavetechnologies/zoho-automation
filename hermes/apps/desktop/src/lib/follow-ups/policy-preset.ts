import type { FollowUpPolicyPreset } from './types'

export function policyJsonFromPreset(preset: FollowUpPolicyPreset): Record<string, unknown> {
  const base = {
    doc_update_mode: 'summary_checkpoint',
    completion_summary_required: true
  }

  if (preset === 'start_pause_done') {
    return { ...base, notify_on_start: true, notify_on_pause: true, notify_on_done: true }
  }
  if (preset === 'start_done') {
    return { ...base, notify_on_start: true, notify_on_pause: false, notify_on_done: true }
  }
  return { ...base, notify_on_start: false, notify_on_pause: false, notify_on_done: true }
}
