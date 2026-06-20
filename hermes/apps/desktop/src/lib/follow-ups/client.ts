import { createHttpFollowUpsClient } from './http-client'
import type {
  CompleteFollowUpRequest,
  CreateFollowUpRequest,
  CreateFollowUpResponse,
  FollowUpActionRequest,
  FollowUpActionResponse,
  FollowUpDetailResponse,
  FollowUpRecord,
  ListFollowUpTasksResponse,
  StartFollowUpIntentRequest,
  UpdateFollowUpDocRequest
} from './api-types'
import { FollowUpsClientError } from './api-types'
import { MOCK_FOLLOW_UP_ASSIGNEES, MOCK_FOLLOW_UP_TASKS } from './mock-data'
import { inferLifecycleActions } from './lifecycle-actions'
import { dueLabelFromChip, followUpTaskToRecord, taskGroupFromDueChip } from './map-task'
import { policyJsonFromPreset } from './policy-preset'

export interface FollowUpsClient {
  createFollowUp(request: CreateFollowUpRequest): Promise<CreateFollowUpResponse>
  listTaskMetadata(): Promise<ListFollowUpTasksResponse>
  getFollowUpDetail(followUpId: string): Promise<FollowUpDetailResponse>
  startFollowUpIntent(request: StartFollowUpIntentRequest): Promise<FollowUpActionResponse>
  pauseFollowUp(request: FollowUpActionRequest): Promise<FollowUpActionResponse>
  updateFollowUpDoc(request: UpdateFollowUpDocRequest): Promise<FollowUpActionResponse>
  completeFollowUp(request: CompleteFollowUpRequest): Promise<FollowUpActionResponse>
}

export interface MockFollowUpsClientOptions {
  initialTasks?: FollowUpRecord[]
  onCreate?: (request: CreateFollowUpRequest) => void
  failCreateWith?: string
  delayMs?: number
}

export function createMockFollowUpsClient(options: MockFollowUpsClientOptions = {}): FollowUpsClient {
  const records = new Map<string, FollowUpRecord>(
    (options.initialTasks ?? MOCK_FOLLOW_UP_TASKS.map(followUpTaskToRecord)).map(record => [record.id, record])
  )

  const maybeDelay = async () => {
    if (options.delayMs && options.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, options.delayMs))
    }
  }

  const getRecord = (followUpId: string): FollowUpRecord => {
    const record = records.get(followUpId)
    if (!record) {
      throw new FollowUpsClientError(`Follow-up not found: ${followUpId}`, 'not_found')
    }
    return record
  }

  const updateRecord = (record: FollowUpRecord) => {
    records.set(record.id, record)
    return record
  }

  return {
    async createFollowUp(request) {
      await maybeDelay()
      options.onCreate?.(request)

      if (options.failCreateWith) {
        throw new FollowUpsClientError(options.failCreateWith, 'create_failed')
      }

      if (!request.title.trim()) {
        throw new FollowUpsClientError('Title is required', 'validation_error')
      }
      if (!request.assigneeId) {
        throw new FollowUpsClientError('Assignee is required', 'validation_error')
      }

      const assignee = MOCK_FOLLOW_UP_ASSIGNEES.find(option => option.id === request.assigneeId)
      const createdId = `fu-mock-${Date.now()}`
      const created: FollowUpRecord = {
        id: createdId,
        title: request.title.trim(),
        status: 'assigned',
        assignedByName: 'You',
        assigneeName: assignee?.name ?? request.assigneeQuery ?? request.assigneeId,
        dueLabel: dueLabelFromChip(request.dueDate),
        dueDate: request.dueDate,
        group: taskGroupFromDueChip(request.dueDate),
        notes: request.notes,
        larkTaskGuid: `mock-task-${Date.now()}`,
        larkTaskUrl: 'https://example.larksuite.com/task/mock-created',
        delegatedTag: 'Divo Follow Up',
        followUpPolicyJson: policyJsonFromPreset(request.policyPreset),
        lifecycleActions: inferLifecycleActions({ id: createdId, status: 'assigned' })
      }
      updateRecord(created)
      return { followUp: created }
    },

    async listTaskMetadata() {
      await maybeDelay()
      return {
        tasks: [...records.values()].filter(task => task.status !== 'deleted')
      }
    },

    async getFollowUpDetail(followUpId) {
      await maybeDelay()
      return { followUp: getRecord(followUpId) }
    },

    async startFollowUpIntent(request) {
      await maybeDelay()
      const current = getRecord(request.followUpId)
      return {
        followUp: updateRecord({
          ...current,
          status: current.status === 'assigned' || current.status === 'paused' ? 'starting' : current.status
        })
      }
    },

    async pauseFollowUp(request) {
      await maybeDelay()
      const current = getRecord(request.followUpId)
      return { followUp: updateRecord({ ...current, status: 'paused' }) }
    },

    async updateFollowUpDoc(request) {
      await maybeDelay()
      const note = request.note.trim()
      if (!note) {
        throw new FollowUpsClientError('Note is required', 'validation_error')
      }
      const current = getRecord(request.followUpId)
      return {
        followUp: updateRecord({
          ...current,
          status: current.status === 'active' ? 'active' : current.status,
          notes: current.notes ? `${current.notes}\n\n${note}` : note
        })
      }
    },

    async completeFollowUp(request) {
      await maybeDelay()
      const current = getRecord(request.followUpId)
      return {
        followUp: updateRecord({
          ...current,
          status: 'done',
          notes: request.summary ?? current.notes
        })
      }
    }
  }
}

let defaultClient: FollowUpsClient | null = null

export function getFollowUpsClient(): FollowUpsClient {
  if (!defaultClient) {
    defaultClient =
      resolveFollowUpsClientMode() === 'http' ? createHttpFollowUpsClient() : createMockFollowUpsClient()
  }
  return defaultClient
}

/** Test-only override for injecting a mock/http client boundary. */
export function setFollowUpsClientForTests(client: FollowUpsClient | null): void {
  defaultClient = client
}

export type FollowUpsClientMode = 'mock' | 'http'

function hasHermesDesktopApiBridge(): boolean {
  const bridge = (window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop
  return typeof bridge?.api === 'function'
}

export function resolveFollowUpsClientMode(): FollowUpsClientMode {
  const raw = import.meta.env.VITE_DESKTOP_FOLLOW_UPS_CLIENT
  if (raw === 'mock') {
    return 'mock'
  }
  if (raw === 'http') {
    return 'http'
  }
  if (typeof window !== 'undefined' && hasHermesDesktopApiBridge()) {
    return 'http'
  }
  return 'mock'
}
