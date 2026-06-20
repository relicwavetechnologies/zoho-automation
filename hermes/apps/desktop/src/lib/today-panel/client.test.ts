import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMockTodayPanelClient,
  resolveTodayPanelClientMode,
  setTodayPanelClientForTests
} from './client'
import { TODAY_PANEL_API_PATHS } from './api-types'
import { buildLarkContextBlock, contextRefFromTask, parseLarkContextBlock } from './context-ref'
import { inferLifecycleActions } from '@/lib/follow-ups/lifecycle-actions'

afterEach(() => {
  setTodayPanelClientForTests(null)
})

describe('TodayPanelClient', () => {
  it('defaults to mock mode without desktop bridge', () => {
    const previous = (window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop
    // @ts-expect-error simulate non-Electron test runtime
    delete (window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop
    try {
      expect(resolveTodayPanelClientMode()).toBe('mock')
    } finally {
      ;(window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop = previous
    }
  })

  it('defaults to http mode when the desktop API bridge exists', () => {
    const previous = (window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop
    ;(window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop = {
      api: vi.fn()
    } as unknown as Window['hermesDesktop']
    try {
      expect(resolveTodayPanelClientMode()).toBe('http')
    } finally {
      ;(window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop = previous
    }
  })

  it('mock client returns today sections', async () => {
    const client = createMockTodayPanelClient()
    const response = await client.getTodayPanel()

    expect(response.tasks.length).toBeGreaterThan(0)
    expect(response.meetings.length).toBeGreaterThan(0)
    expect(response.needsYou.length).toBeGreaterThan(0)
    expect(response.docs.length).toBeGreaterThan(0)
  })

  it('declares today API path for http mode', () => {
    expect(TODAY_PANEL_API_PATHS.today).toBe('/api/company/today')
    expect(createMockTodayPanelClient().getTodayPanel).toBeTypeOf('function')
  })
})

describe('Lark context refs', () => {
  it('builds structured context block for submit', () => {
    const ref = contextRefFromTask({
      id: 'lark:abc',
      title: 'Review vendor contract',
      status: 'assigned',
      assignedByName: 'Lark Tasks',
      assigneeName: 'You',
      dueLabel: 'Today',
      group: 'today',
      larkTaskGuid: 'abc',
      lifecycleActions: inferLifecycleActions({ id: 'lark:abc', status: 'assigned' })
    })

    const block = buildLarkContextBlock([ref])
    expect(block).toContain('[LARK CONTEXT]')
    expect(block).toContain('task: Review vendor contract')
    expect(block).toContain('taskGuid=abc')
  })

  it('round-trips context block into display refs and user text', () => {
    const ref = contextRefFromTask({
      id: 'lark:abc',
      title: 'AirNote — Settings UI cleanup & simplification',
      status: 'assigned',
      assignedByName: 'Lark Tasks',
      assigneeName: 'You',
      dueLabel: 'Today',
      group: 'today',
      larkTaskGuid: '63cb64d2-86c8-4547-97db-64935b49a9eb',
      lifecycleActions: inferLifecycleActions({ id: 'lark:abc', status: 'assigned' })
    })

    const submitted = `${buildLarkContextBlock([ref])}check these too`
    const parsed = parseLarkContextBlock(submitted)

    expect(parsed.refs).toEqual([
      {
        kind: 'task',
        label: 'AirNote — Settings UI cleanup & simplification'
      }
    ])
    expect(parsed.body).toBe('check these too')
  })
})
