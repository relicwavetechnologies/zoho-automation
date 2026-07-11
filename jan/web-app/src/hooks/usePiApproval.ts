import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

import {
  parsePiApprovalEvent,
  type PiApprovalRequest,
} from '@/lib/pi/approval'
import {
  isPiMemoryReviewRequest,
  parsePiMemoryReviewEvent,
  validatePiMemoryReviewResponse,
  type PiMemoryReviewRequest,
  type PiMemoryReviewResponse,
} from '@/lib/pi/memory-review'
import type { PiRawEvent } from '@/lib/pi'

export const PI_APPROVAL_RESPONSE_COMMAND = 'pi_extension_ui_respond'

export type PiPendingUiRequest = PiApprovalRequest | PiMemoryReviewRequest

type PiApprovalState = {
  queues: Record<string, PiPendingUiRequest[]>
  enqueue: (request: PiPendingUiRequest) => void
  resolve: (
    threadId: string,
    requestId: string,
    confirmed: boolean
  ) => Promise<boolean>
  resolveMemory: (
    threadId: string,
    requestId: string,
    response: PiMemoryReviewResponse
  ) => Promise<boolean>
  allowBashForTask: (threadId: string, requestId: string) => Promise<boolean>
  denyExpired: (now?: number) => Promise<void>
  denyThread: (threadId: string) => Promise<void>
  discardThreadAfterAbort: (threadId: string) => void
}

function containsRequest(
  queues: Record<string, PiPendingUiRequest[]>,
  requestId: string
) {
  return Object.values(queues).some((queue) =>
    queue.some((request) => request.requestId === requestId)
  )
}

function updateRequest(
  queues: Record<string, PiPendingUiRequest[]>,
  threadId: string,
  requestId: string,
  update: (request: PiPendingUiRequest) => PiPendingUiRequest
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
  queues: Record<string, PiPendingUiRequest[]>,
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

async function sendMemoryResponse(
  requestId: string,
  threadId: string,
  response?: PiMemoryReviewResponse
) {
  await invoke(PI_APPROVAL_RESPONSE_COMMAND, {
    requestId,
    threadId,
    ...(response
      ? { value: JSON.stringify(response) }
      : { cancelled: true }),
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
    if (
      !request ||
      isPiMemoryReviewRequest(request) ||
      request.status === 'submitting'
    ) {
      return false
    }

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

  resolveMemory: async (threadId, requestId, response) => {
    const request = get().queues[threadId]?.find(
      (candidate) => candidate.requestId === requestId
    )
    if (
      !request ||
      !isPiMemoryReviewRequest(request) ||
      request.status === 'submitting'
    ) {
      return false
    }

    let validated: PiMemoryReviewResponse
    try {
      validated = validatePiMemoryReviewResponse(request, response)
    } catch (error) {
      // A malformed local form result must cancel the Pi editor promise rather
      // than leave it blocked or forward untrusted selections.
      try {
        await sendMemoryResponse(requestId, threadId)
        set((state) => ({
          queues: removeRequest(state.queues, threadId, requestId),
        }))
      } catch (deliveryError) {
        set((state) => ({
          queues: updateRequest(state.queues, threadId, requestId, (entry) => ({
            ...entry,
            status: 'error',
            error:
              deliveryError instanceof Error
                ? deliveryError.message
                : error instanceof Error
                  ? error.message
                  : 'Could not cancel invalid memory review',
          })),
        }))
      }
      return false
    }

    set((state) => ({
      queues: updateRequest(state.queues, threadId, requestId, (entry) => ({
        ...entry,
        status: 'submitting',
        error: undefined,
      })),
    }))
    try {
      await sendMemoryResponse(requestId, threadId, validated)
      set((state) => ({
        queues: removeRequest(state.queues, threadId, requestId),
      }))
      return true
    } catch (error) {
      set((state) => ({
        queues: updateRequest(state.queues, threadId, requestId, (entry) => ({
          ...entry,
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : 'Could not deliver the memory review decision',
        })),
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
      isPiMemoryReviewRequest(request) ||
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
          !isPiMemoryReviewRequest(request) &&
          request.expiresAt <= now &&
          request.status !== 'submitting'
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
      pending.map((request) => {
        if (isPiMemoryReviewRequest(request)) {
          return get().resolveMemory(threadId, request.requestId, {
            version: 1,
            proposalId: request.descriptor.proposalId,
            decision: 'cancel',
            selectedTarget: null,
            selectedBulletIds: [],
          })
        }
        return get().resolve(threadId, request.requestId, false)
      })
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
  if (parsed.kind === 'approval') {
    usePiApproval.getState().enqueue(parsed.request)
    return true
  }
  if (parsed.kind === 'invalid') {
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

  const memoryReview = parsePiMemoryReviewEvent(event)
  if (memoryReview.kind === 'not-memory-review') return false
  if (memoryReview.kind === 'memory-review') {
    usePiApproval.getState().enqueue(memoryReview.request)
    return true
  }

  console.error(
    `[Pi memory review] Rejected invalid request: ${memoryReview.reason}`
  )
  if (memoryReview.requestId && memoryReview.threadId) {
    try {
      await sendMemoryResponse(memoryReview.requestId, memoryReview.threadId)
    } catch (error) {
      console.error(
        '[Pi memory review] Failed to deliver automatic cancellation',
        error
      )
    }
  }
  return true
}
