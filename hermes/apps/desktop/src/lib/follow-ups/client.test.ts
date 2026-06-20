import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createMockFollowUpsClient,
  getFollowUpsClient,
  resolveFollowUpsClientMode,
  setFollowUpsClientForTests
} from './client'
import { createHttpFollowUpsClient } from './http-client'
import { FOLLOW_UP_API_PATHS } from './api-types'
import { createRequestFromDraft, followUpRecordToTask } from './map-task'
import { PLAIN_LARK_LIFECYCLE_ACTIONS } from './lifecycle-actions'
import { defaultFollowUpCreateDraft } from './mock-data'
import { policyJsonFromPreset } from './policy-preset'
import type { FollowUpRecord } from './api-types'

/** Backend-shaped record from Hermes `_serialize_follow_up_record` (no mock-only ids). */
const BACKEND_FOLLOW_UP_RECORD: FollowUpRecord = {
  id: 'fu_1',
  title: 'Prepare Q2 renewal notes',
  status: 'assigned',
  assignedByName: 'Vira',
  assigneeName: 'Rahul',
  dueLabel: 'Tomorrow EOD',
  dueDate: '2026-06-18',
  group: 'today',
  notes: 'Use CRM context',
  larkTaskGuid: 'task_1',
  larkTaskUrl: 'https://larksuite.example/task/t1',
  delegatedTag: 'Divo Follow Up',
  followUpPolicyJson: policyJsonFromPreset('start_pause_done'),
  lifecycleActions: {
    isFollowUp: true,
    canStart: true,
    canPause: false,
    canUpdateDoc: false,
    canComplete: false,
    canReassign: false,
    canOpenTrackingDoc: false,
    requiresCompletionSummary: true
  }
}

describe('resolveFollowUpsClientMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to mock when env is unset and desktop bridge is unavailable', () => {
    vi.stubEnv('VITE_DESKTOP_FOLLOW_UPS_CLIENT', '')
    const previous = window.hermesDesktop
    // @ts-expect-error simulate non-Electron test runtime
    delete window.hermesDesktop
    try {
      expect(resolveFollowUpsClientMode()).toBe('mock')
    } finally {
      window.hermesDesktop = previous
    }
  })

  it('defaults to http when desktop bridge exists', () => {
    vi.stubEnv('VITE_DESKTOP_FOLLOW_UPS_CLIENT', '')
    ;(window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop = {
      api: vi.fn()
    } as unknown as Window['hermesDesktop']
    expect(resolveFollowUpsClientMode()).toBe('http')
  })

  it('selects http when env is exactly http', () => {
    vi.stubEnv('VITE_DESKTOP_FOLLOW_UPS_CLIENT', 'http')
    expect(resolveFollowUpsClientMode()).toBe('http')
  })
})

describe('getFollowUpsClient', () => {
  const api = vi.fn()

  beforeEach(() => {
    setFollowUpsClientForTests(null)
    api.mockReset()
    window.hermesDesktop = {
      ...(window.hermesDesktop ?? {}),
      api
    } as typeof window.hermesDesktop
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    setFollowUpsClientForTests(null)
  })

  it('returns mock client when mock mode is explicit', async () => {
    vi.stubEnv('VITE_DESKTOP_FOLLOW_UPS_CLIENT', 'mock')
    const client = getFollowUpsClient()
    const response = await client.createFollowUp(
      createRequestFromDraft({
        ...defaultFollowUpCreateDraft(),
        title: 'Mock default path',
        assignee: 'anish'
      })
    )
    expect(response.followUp.id).toMatch(/^fu-mock-/)
    expect(api).not.toHaveBeenCalled()
  })

  it('uses HTTP client when desktop bridge exists', async () => {
    vi.stubEnv('VITE_DESKTOP_FOLLOW_UPS_CLIENT', '')
    api.mockResolvedValue({ followUp: BACKEND_FOLLOW_UP_RECORD })

    const client = getFollowUpsClient()
    const response = await client.createFollowUp(
      createRequestFromDraft({
        ...defaultFollowUpCreateDraft(),
        title: 'Prepare Q2 renewal notes',
        assignee: 'anish',
        dueDate: '2026-06-18',
        notes: 'Use CRM context',
        policyPreset: 'start_done'
      })
    )

    expect(api).toHaveBeenCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.create,
      body: expect.objectContaining({
        title: 'Prepare Q2 renewal notes',
        assigneeId: 'anish',
        dueDate: '2026-06-18',
        notes: 'Use CRM context',
        policyPreset: 'start_done'
      })
    })
    expect(response.followUp).toEqual(BACKEND_FOLLOW_UP_RECORD)
  })
})

describe('createMockFollowUpsClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a follow-up with policy preset and assignee metadata', async () => {
    const onCreate = vi.fn()
    const client = createMockFollowUpsClient({ onCreate })

    const draft = {
      ...defaultFollowUpCreateDraft(),
      title: 'Prepare rollout brief',
      assignee: 'anish',
      dueDate: 'tomorrow',
      notes: 'Use prior chat',
      policyPreset: 'start_done' as const
    }

    const response = await client.createFollowUp(createRequestFromDraft(draft))

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Prepare rollout brief',
        assigneeId: 'anish',
        assigneeQuery: 'Anish',
        dueDate: 'tomorrow',
        notes: 'Use prior chat',
        policyPreset: 'start_done'
      })
    )
    expect(response.followUp.status).toBe('assigned')
    expect(response.followUp.followUpPolicyJson).toEqual(policyJsonFromPreset('start_done'))
  })

  it('lists created follow-ups', async () => {
    const client = createMockFollowUpsClient({ initialTasks: [] })
    await client.createFollowUp(
      createRequestFromDraft({
        ...defaultFollowUpCreateDraft(),
        title: 'List me',
        assignee: 'anish'
      })
    )

    const listed = await client.listTaskMetadata()
    expect(listed.tasks).toHaveLength(1)
    expect(listed.tasks[0]?.title).toBe('List me')
  })

  it('surfaces validation errors', async () => {
    const client = createMockFollowUpsClient()
    await expect(
      client.createFollowUp({
        title: ' ',
        assigneeId: 'anish',
        dueDate: 'today',
        policyPreset: 'only_done'
      })
    ).rejects.toThrow('Title is required')
  })

  it('accepts backend-shaped records without mock-only fields', async () => {
    const client = createMockFollowUpsClient({ initialTasks: [BACKEND_FOLLOW_UP_RECORD] })
    const listed = await client.listTaskMetadata()
    expect(listed.tasks[0]).toMatchObject({
      id: 'fu_1',
      larkTaskGuid: 'task_1',
      followUpPolicyJson: expect.objectContaining({ notify_on_start: true })
    })
    expect(listed.tasks[0]?.id).not.toMatch(/^fu-mock-/)
  })
})

describe('createHttpFollowUpsClient', () => {
  const api = vi.fn()

  beforeEach(() => {
    api.mockReset()
    window.hermesDesktop = {
      ...(window.hermesDesktop ?? {}),
      api
    } as typeof window.hermesDesktop
  })

  it('calls create, list, detail, start, pause, and complete with expected paths', async () => {
    const client = createHttpFollowUpsClient()
    const followUp = { ...BACKEND_FOLLOW_UP_RECORD, status: 'active' as const }

    api.mockResolvedValueOnce({ company_id: 'company_test', tasks: [BACKEND_FOLLOW_UP_RECORD] })
    await client.listTaskMetadata()
    expect(api).toHaveBeenLastCalledWith({ path: FOLLOW_UP_API_PATHS.list })

    api.mockResolvedValueOnce({ followUp: BACKEND_FOLLOW_UP_RECORD })
    await client.getFollowUpDetail('fu_1')
    expect(api).toHaveBeenLastCalledWith({ path: FOLLOW_UP_API_PATHS.detail('fu_1') })

    api.mockResolvedValueOnce({ followUp: BACKEND_FOLLOW_UP_RECORD })
    await client.createFollowUp({
      title: 'Prepare Q2 renewal notes',
      assigneeId: 'user_assignee',
      dueDate: '2026-06-18',
      notes: 'Use CRM context',
      policyPreset: 'start_pause_done',
      sourceSessionId: 'session_source'
    })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.create,
      body: {
        title: 'Prepare Q2 renewal notes',
        assigneeId: 'user_assignee',
        dueDate: '2026-06-18',
        notes: 'Use CRM context',
        policyPreset: 'start_pause_done',
        sourceSessionId: 'session_source'
      }
    })

    api.mockResolvedValueOnce({ followUp })
    await client.startFollowUpIntent({ followUpId: 'fu_1', activeSessionId: 'session_active' })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.startIntent('fu_1'),
      body: { activeSessionId: 'session_active' }
    })

    api.mockResolvedValueOnce({ followUp: { ...followUp, status: 'paused' } })
    await client.pauseFollowUp({ followUpId: 'fu_1', reason: 'Waiting on finance' })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.pause('fu_1'),
      body: { reason: 'Waiting on finance' }
    })

    api.mockResolvedValueOnce({ followUp })
    await client.updateFollowUpDoc({
      followUpId: 'fu_1',
      note: 'Drafted the first pass.'
    })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.updateDoc('fu_1'),
      body: { note: 'Drafted the first pass.' }
    })

    api.mockResolvedValueOnce({ followUp: { ...followUp, status: 'done' } })
    await client.completeFollowUp({
      followUpId: 'fu_1',
      summary: 'Finished the renewal notes and linked the doc.'
    })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.complete('fu_1'),
      body: { summary: 'Finished the renewal notes and linked the doc.' }
    })
  })

  it('sends empty bodies when optional lifecycle fields are omitted', async () => {
    const client = createHttpFollowUpsClient()
    api.mockResolvedValue({ followUp: BACKEND_FOLLOW_UP_RECORD })

    await client.startFollowUpIntent({ followUpId: 'fu_1' })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.startIntent('fu_1'),
      body: {}
    })

    await client.pauseFollowUp({ followUpId: 'fu_1' })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.pause('fu_1'),
      body: {}
    })

    await client.completeFollowUp({ followUpId: 'fu_1' })
    expect(api).toHaveBeenLastCalledWith({
      method: 'POST',
      path: FOLLOW_UP_API_PATHS.complete('fu_1'),
      body: {}
    })
  })
})

describe('createMockFollowUpsClient updateFollowUpDoc', () => {
  it('rejects blank notes', async () => {
    const client = createMockFollowUpsClient({
      initialTasks: [
        {
          ...BACKEND_FOLLOW_UP_RECORD,
          status: 'active',
          trackingDocUrl: 'https://larksuite.example/doc/doc_token_1',
          lifecycleActions: {
            ...BACKEND_FOLLOW_UP_RECORD.lifecycleActions!,
            canStart: false,
            canPause: true,
            canUpdateDoc: true,
            canComplete: true,
            canOpenTrackingDoc: true
          }
        }
      ]
    })

    await expect(client.updateFollowUpDoc({ followUpId: 'fu_1', note: '  ' })).rejects.toThrow(
      'Note is required'
    )
  })

  it('keeps active status and appends the note in mock storage', async () => {
    const client = createMockFollowUpsClient({
      initialTasks: [
        {
          ...BACKEND_FOLLOW_UP_RECORD,
          status: 'active',
          notes: 'Existing context',
          trackingDocUrl: 'https://larksuite.example/doc/doc_token_1',
          lifecycleActions: {
            ...BACKEND_FOLLOW_UP_RECORD.lifecycleActions!,
            canStart: false,
            canPause: true,
            canUpdateDoc: true,
            canComplete: true,
            canOpenTrackingDoc: true
          }
        }
      ]
    })

    const response = await client.updateFollowUpDoc({
      followUpId: 'fu_1',
      note: 'Drafted the first pass.'
    })

    expect(response.followUp.status).toBe('active')
    expect(response.followUp.notes).toContain('Drafted the first pass.')
  })
})

describe('followUpRecordToTask mixed records', () => {
  it('maps plain Lark rows without delegated tag', () => {
    const task = followUpRecordToTask({
      id: 'lark:task_plain',
      title: 'Plain Lark task',
      status: 'assigned',
      assignedByName: 'Lark Tasks',
      assigneeName: 'Anish',
      dueLabel: '2026-06-19',
      group: 'upcoming',
      larkTaskGuid: 'task_plain',
      larkTaskUrl: 'https://larksuite.example/task/task_plain',
      lifecycleActions: PLAIN_LARK_LIFECYCLE_ACTIONS
    })

    expect(task.kind).toBe('plain_lark')
    expect(task.delegatedTag).toBeUndefined()
    expect(task.lifecycleActions.isFollowUp).toBe(false)
    expect(task.lifecycleActions.canStart).toBe(false)
  })

  it('maps Divo follow-up rows with delegated tag and lifecycleActions', () => {
    const task = followUpRecordToTask(BACKEND_FOLLOW_UP_RECORD)
    expect(task.kind).toBe('divo_follow_up')
    expect(task.delegatedTag).toBe('Divo Follow Up')
    expect(task.lifecycleActions.isFollowUp).toBe(true)
    expect(task.lifecycleActions.canStart).toBe(true)
  })

  it('prefers lifecycleActions.isFollowUp over id prefix when classifying rows', () => {
    const task = followUpRecordToTask({
      ...BACKEND_FOLLOW_UP_RECORD,
      id: 'lark:unexpected',
      lifecycleActions: PLAIN_LARK_LIFECYCLE_ACTIONS
    })

    expect(task.kind).toBe('plain_lark')
    expect(task.lifecycleActions.isFollowUp).toBe(false)
  })
})
