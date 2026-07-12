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
  denyThread: (threadId: string, runId?: string) => Promise<void>
  discardThreadAfterAbort: (threadId: string, runId?: string) => void
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
  requestId: string,
  runId?: string
) {
  const queue = queues[threadId]
  if (!queue) return queues
  const nextQueue = queue.filter(
    (request) =>
      request.requestId !== requestId ||
      (runId !== undefined && request.runId !== runId)
  )
  const nextQueues = { ...queues }
  if (nextQueue.length > 0) nextQueues[threadId] = nextQueue
  else delete nextQueues[threadId]
  return nextQueues
}

async function sendDecision(
  requestId: string,
  threadId: string,
  runId: string,
  confirmed: boolean,
  alwaysAllowBash = false
) {
  await invoke(PI_APPROVAL_RESPONSE_COMMAND, {
    requestId,
    threadId,
    runId,
    confirmed,
    ...(alwaysAllowBash ? { alwaysAllowBash: true } : {}),
  })
}

async function sendMemoryResponse(
  requestId: string,
  threadId: string,
  runId: string,
  response?: PiMemoryReviewResponse
) {
  await invoke(PI_APPROVAL_RESPONSE_COMMAND, {
    requestId,
    threadId,
    runId,
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
      await sendDecision(requestId, threadId, request.runId, effectiveConfirmation)
      set((state) => ({
        queues: removeRequest(state.queues, threadId, requestId, request.runId),
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
        await sendMemoryResponse(requestId, threadId, request.runId)
        set((state) => ({
          queues: removeRequest(state.queues, threadId, requestId, request.runId),
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
      await sendMemoryResponse(requestId, threadId, request.runId, validated)
      set((state) => ({
        queues: removeRequest(state.queues, threadId, requestId, request.runId),
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
      await sendDecision(requestId, threadId, request.runId, true, true)
      set((state) => ({
        queues: removeRequest(state.queues, threadId, requestId, request.runId),
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

  denyThread: async (threadId, runId) => {
    const pending = (get().queues[threadId] ?? []).filter(
      (request) => runId === undefined || request.runId === runId
    )
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
  discardThreadAfterAbort: (threadId, runId) => {
    set((state) => {
      const pending = state.queues[threadId]
      if (!pending) return state
      if (runId === undefined) {
        const queues = { ...state.queues }
        delete queues[threadId]
        return { queues }
      }
      const remaining = pending.filter((request) => request.runId !== runId)
      const queues = { ...state.queues }
      if (remaining.length > 0) queues[threadId] = remaining
      else delete queues[threadId]
      return {
        queues,
      }
    })
  },
}))

function reconcileCancelledRequest(event: PiRawEvent) {
  if (
    event.type !== 'extension_ui_response' ||
    event.cancelled !== true ||
    typeof event.id !== 'string' ||
    typeof event.thread_id !== 'string' ||
    typeof event.run_id !== 'string'
  ) {
    return false
  }
  const requestId = event.id.trim()
  const threadId = event.thread_id.trim()
  const runId = event.run_id.trim()
  if (!requestId || !threadId || !runId) return false
  usePiApproval.setState((state) => ({
    queues: removeRequest(state.queues, threadId, requestId, runId),
  }))
  return true
}

/**
 * Consume a raw Pi event. Malformed events for this private protocol are
 * immediately denied when they still carry enough routing information.
 */
export async function consumePiApprovalEvent(event: PiRawEvent) {
  if (reconcileCancelledRequest(event)) return true
  const parsed = parsePiApprovalEvent(event)
  if (parsed.kind === 'approval') {
    usePiApproval.getState().enqueue(parsed.request)
    return true
  }
  if (parsed.kind === 'invalid') {
    console.error(`[Pi approval] Rejected invalid request: ${parsed.reason}`)
    if (parsed.requestId && parsed.threadId && parsed.runId) {
      try {
        await sendDecision(
          parsed.requestId,
          parsed.threadId,
          parsed.runId,
          false
        )
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
  if (memoryReview.requestId && memoryReview.threadId && memoryReview.runId) {
    try {
      await sendMemoryResponse(
        memoryReview.requestId,
        memoryReview.threadId,
        memoryReview.runId
      )
    } catch (error) {
      console.error(
        '[Pi memory review] Failed to deliver automatic cancellation',
        error
      )
    }
  }
  return true
}
