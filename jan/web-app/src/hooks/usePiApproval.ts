import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

import {
  parsePiApprovalEvent,
  type PiApprovalRequest,
} from '@/lib/pi/approval'
import type { PiRawEvent } from '@/lib/pi'

export const PI_APPROVAL_RESPONSE_COMMAND = 'pi_extension_ui_respond'

type PiApprovalState = {
  queues: Record<string, PiApprovalRequest[]>
  enqueue: (request: PiApprovalRequest) => void
  resolve: (
    threadId: string,
    requestId: string,
    confirmed: boolean
  ) => Promise<boolean>
  allowBashForTask: (threadId: string, requestId: string) => Promise<boolean>
  denyExpired: (now?: number) => Promise<void>
  denyThread: (threadId: string) => Promise<void>
  discardThreadAfterAbort: (threadId: string) => void
}

function containsRequest(
  queues: Record<string, PiApprovalRequest[]>,
  requestId: string
) {
  return Object.values(queues).some((queue) =>
    queue.some((request) => request.requestId === requestId)
  )
}

function updateRequest(
  queues: Record<string, PiApprovalRequest[]>,
  threadId: string,
  requestId: string,
  update: (request: PiApprovalRequest) => PiApprovalRequest
) {
  const queue = queues[threadId]
  if (!queue) return queues
  return {
    ...queues,
    [threadId]: queue.map((request) =>
      request.requestId === requestId ? update(request) : request
    ),
  }
}

function removeRequest(
  queues: Record<string, PiApprovalRequest[]>,
  threadId: string,
  requestId: string
) {
  const queue = queues[threadId]
  if (!queue) return queues
  const nextQueue = queue.filter((request) => request.requestId !== requestId)
  const nextQueues = { ...queues }
  if (nextQueue.length > 0) nextQueues[threadId] = nextQueue
  else delete nextQueues[threadId]
  return nextQueues
}

async function sendDecision(
  requestId: string,
  threadId: string,
  confirmed: boolean,
  alwaysAllowBash = false
) {
  await invoke(PI_APPROVAL_RESPONSE_COMMAND, {
    requestId,
    threadId,
    confirmed,
    ...(alwaysAllowBash ? { alwaysAllowBash: true } : {}),
  })
}

export const usePiApproval = create<PiApprovalState>()((set, get) => ({
  queues: {},

  enqueue: (request) => {
    set((state) => {
      if (containsRequest(state.queues, request.requestId)) return state
      return {
        queues: {
          ...state.queues,
          [request.threadId]: [
            ...(state.queues[request.threadId] ?? []),
            request,
          ],
        },
      }
    })
  },

  resolve: async (threadId, requestId, confirmed) => {
    const request = get().queues[threadId]?.find(
      (candidate) => candidate.requestId === requestId
    )
    if (!request || request.status === 'submitting') return false

    // Expired actions can only be denied. This prevents an old card from
    // approving an action after its payload-bound intent has gone stale.
    const effectiveConfirmation =
      confirmed && request.expiresAt > Date.now()

    set((state) => ({
      queues: updateRequest(
        state.queues,
        threadId,
        requestId,
        (entry) => ({ ...entry, status: 'submitting', error: undefined })
      ),
    }))

    try {
      await sendDecision(requestId, threadId, effectiveConfirmation)
      set((state) => ({
        queues: removeRequest(state.queues, threadId, requestId),
      }))
      return true
    } catch (error) {
      set((state) => ({
        queues: updateRequest(
          state.queues,
          threadId,
          requestId,
          (entry) => ({
            ...entry,
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Could not deliver the approval decision',
          })
        ),
      }))
      return false
    }
  },

  allowBashForTask: async (threadId, requestId) => {
    const request = get().queues[threadId]?.find(
      (candidate) => candidate.requestId === requestId
    )
    if (
      !request ||
      request.status === 'submitting' ||
      request.descriptor.source !== 'bash' ||
      request.expiresAt <= Date.now()
    ) {
      return false
    }

    set((state) => ({
      queues: updateRequest(
        state.queues,
        threadId,
        requestId,
        (entry) => ({ ...entry, status: 'submitting', error: undefined })
      ),
    }))

    try {
      // Rust verifies that this exact active request is Bash before recording
      // the memory-only task grant and confirming the current command.
      await sendDecision(requestId, threadId, true, true)
      set((state) => ({
        queues: removeRequest(state.queues, threadId, requestId),
      }))
      return true
    } catch (error) {
      set((state) => ({
        queues: updateRequest(
          state.queues,
          threadId,
          requestId,
          (entry) => ({
            ...entry,
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Could not enable automatic Bash approval',
          })
        ),
      }))
      return false
    }
  },

  denyExpired: async (now = Date.now()) => {
    const expired = Object.values(get().queues)
      .flat()
      .filter(
        (request) =>
          request.expiresAt <= now && request.status !== 'submitting'
      )
    await Promise.all(
      expired.map((request) =>
        get().resolve(request.threadId, request.requestId, false)
      )
    )
  },

  denyThread: async (threadId) => {
    const pending = get().queues[threadId] ?? []
    await Promise.all(
      pending.map((request) =>
        get().resolve(threadId, request.requestId, false)
      )
    )
  },

  // Call only after Rust confirms pi_abort. At that point Rust has cancelled
  // every pending extension UI promise, so removing a failed local denial is
  // safe and cannot resume execution.
  discardThreadAfterAbort: (threadId) => {
    set((state) => {
      if (!state.queues[threadId]) return state
      const queues = { ...state.queues }
      delete queues[threadId]
      return { queues }
    })
  },
}))

/**
 * Consume a raw Pi event. Malformed events for this private protocol are
 * immediately denied when they still carry enough routing information.
 */
export async function consumePiApprovalEvent(event: PiRawEvent) {
  const parsed = parsePiApprovalEvent(event)
  if (parsed.kind === 'not-approval') return false

  if (parsed.kind === 'approval') {
    usePiApproval.getState().enqueue(parsed.request)
    return true
  }

  console.error(`[Pi approval] Rejected invalid request: ${parsed.reason}`)
  if (parsed.requestId && parsed.threadId) {
    try {
      await sendDecision(parsed.requestId, parsed.threadId, false)
    } catch (error) {
      console.error('[Pi approval] Failed to deliver automatic denial', error)
    }
  }
  return true
}
