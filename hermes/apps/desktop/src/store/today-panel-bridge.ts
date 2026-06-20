import { atom } from 'nanostores'

import type { FollowUpLifecycleRequestSignal } from '@/app/follow-ups/follow-ups-chrome'
import type { FollowUpTask } from '@/lib/follow-ups/types'
import type { LarkContextRef } from '@/lib/today-panel'

export type TodayPanelComposerBridge = {
  activeQueueSessionKey?: string | null
  busy: boolean
  generateFollowUpCompletionSummary: (task: FollowUpTask) => Promise<string> | string
  insertText: (text: string) => void
  landing: boolean
  messages: ReadonlyArray<{ hidden?: boolean; id: string; parts: unknown[]; role: string }>
  referencedTaskIds: ReadonlySet<string>
  requestMainFocus: () => void
  sessionId?: string | null
}

export const $todayPanelLandingRefs = atom<LarkContextRef[]>([])
export const $todayPanelComposerBridge = atom<TodayPanelComposerBridge | null>(null)
export const $followUpCreateSignal = atom(0)
export const $followUpLifecycleSignal = atom<FollowUpLifecycleRequestSignal | null>(null)

export function toggleTodayPanelLandingRef(ref: LarkContextRef) {
  const prev = $todayPanelLandingRefs.get()
  $todayPanelLandingRefs.set(prev.some(row => row.id === ref.id) ? prev.filter(row => row.id !== ref.id) : [...prev, ref])
}

export function bumpFollowUpCreateSignal() {
  $followUpCreateSignal.set($followUpCreateSignal.get() + 1)
}

export function requestFollowUpLifecycle(action: FollowUpLifecycleRequestSignal['action'], followUpId: string) {
  $followUpLifecycleSignal.set({
    sequence: Date.now(),
    action,
    followUpId
  })
}

export function setTodayPanelComposerBridge(bridge: TodayPanelComposerBridge | null) {
  $todayPanelComposerBridge.set(bridge)
}
