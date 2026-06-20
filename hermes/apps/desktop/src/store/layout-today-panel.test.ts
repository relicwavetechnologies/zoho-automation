import { beforeEach, describe, expect, it } from 'vitest'

import {
  $todayPanelOpen,
  $todayPanelWidth,
  setTodayPanelOpen,
  setTodayPanelWidth,
  TODAY_PANEL_MAX_WIDTH,
  TODAY_PANEL_MIN_WIDTH,
  TODAY_PANEL_PANE_ID,
  toggleTodayPanelOpen
} from './layout'
import { $paneStates, ensurePaneRegistered } from './panes'

describe('today panel layout', () => {
  beforeEach(() => {
    $paneStates.set({})
    ensurePaneRegistered(TODAY_PANEL_PANE_ID, { open: true })
  })

  it('defaults open and exposes width', () => {
    expect($todayPanelOpen.get()).toBe(true)
    expect($todayPanelWidth.get()).toBeGreaterThan(0)
  })

  it('clamps resize width between min and max', () => {
    setTodayPanelWidth(120)
    expect($todayPanelWidth.get()).toBe(TODAY_PANEL_MIN_WIDTH)

    setTodayPanelWidth(2000)
    expect($todayPanelWidth.get()).toBe(TODAY_PANEL_MAX_WIDTH)
  })

  it('toggles open state', () => {
    setTodayPanelOpen(true)
    toggleTodayPanelOpen()
    expect($todayPanelOpen.get()).toBe(false)
  })
})
