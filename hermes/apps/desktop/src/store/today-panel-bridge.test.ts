import { afterEach, describe, expect, it } from 'vitest'

import {
  $followUpCreateSignal,
  $followUpLifecycleSignal,
  $todayPanelLandingRefs,
  bumpFollowUpCreateSignal,
  requestFollowUpLifecycle,
  toggleTodayPanelLandingRef
} from './today-panel-bridge'

afterEach(() => {
  $todayPanelLandingRefs.set([])
  $followUpCreateSignal.set(0)
})

describe('today-panel bridge store', () => {
  it('toggles landing refs by id', () => {
    const ref = {
      id: 'lark:t1',
      kind: 'task' as const,
      label: 'Send Q2 finance report',
      detail: 'Overdue',
      larkRef: '@lark-task:t1',
      payload: { taskGuid: 't1' }
    }

    toggleTodayPanelLandingRef(ref)
    expect($todayPanelLandingRefs.get()).toHaveLength(1)

    toggleTodayPanelLandingRef(ref)
    expect($todayPanelLandingRefs.get()).toHaveLength(0)
  })

  it('bumps follow-up create and lifecycle signals', () => {
    bumpFollowUpCreateSignal()
    expect($followUpCreateSignal.get()).toBe(1)

    requestFollowUpLifecycle('pause', 'fu-2')
    expect($followUpLifecycleSignal.get()).toMatchObject({
      action: 'pause',
      followUpId: 'fu-2'
    })
  })
})
