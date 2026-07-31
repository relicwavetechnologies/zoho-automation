import type { DivoSkillReference } from '@/lib/divo-skill-reference-context'
import type { Attachment } from '@/types/attachment'
import { create } from 'zustand'

export type QueuedSkillReference = Readonly<
  Omit<DivoSkillReference, 'toolIds'> & { toolIds: readonly string[] }
>

export type QueuedMessage = {
  id: string
  text: string
  createdAt: number
  /** A detached composer snapshot. Never read attachments from the live composer on replay. */
  attachments: readonly Attachment[]
  skillReferences: readonly QueuedSkillReference[]
  /** The active-path parent selected when the user queued this send. */
  parentId: string | null
  /** Whether the thread was branched when parentId was captured. */
  hadBranching: boolean
  failure?: QueuedMessageFailure
}

export type QueuedMessageFailure = {
  code: 'branch_parent_missing' | 'submission_failed'
  message: string
}

export type QueuedMessageClaim = {
  message: QueuedMessage
  claimId: string
}

type InFlightClaim = {
  messageId: string
  claimId: string
  cancellationRequested?: boolean
}

// Stable reference for empty queues so selectors don't trigger unnecessary re-renders
const EMPTY_QUEUE: QueuedMessage[] = []

interface MessageQueueState {
  // Per-thread message queues
  queues: Record<string, QueuedMessage[]>
  inFlight: Record<string, InFlightClaim | undefined>

  enqueue: (threadId: string, message: QueuedMessage) => void
  claimNext: (threadId: string) => QueuedMessageClaim | undefined
  acknowledge: (threadId: string, claim: QueuedMessageClaim) => void
  isDispatchable: (threadId: string, claim: QueuedMessageClaim) => boolean
  discard: (threadId: string, claim: QueuedMessageClaim) => void
  requestCancellation: (threadId: string, messageId: string) => boolean
  release: (
    threadId: string,
    claim: QueuedMessageClaim,
    failure: QueuedMessageFailure
  ) => void
  removeMessage: (threadId: string, messageId: string) => void
  clearQueue: (threadId: string) => void
  getQueue: (threadId: string) => QueuedMessage[]
}

const snapshotAttachments = (attachments: readonly Attachment[]) =>
  Object.freeze(
    attachments.map((attachment) => Object.freeze({ ...attachment }))
  )

const snapshotSkillReferences = (references: readonly QueuedSkillReference[]) =>
  Object.freeze(
    references.map((reference) =>
      Object.freeze({
        ...reference,
        toolIds: Object.freeze([...reference.toolIds]),
      })
    )
  )

const snapshotMessage = (message: QueuedMessage): QueuedMessage =>
  Object.freeze({
    ...message,
    attachments: snapshotAttachments(message.attachments),
    skillReferences: snapshotSkillReferences(message.skillReferences),
    failure: undefined,
  })

export const useMessageQueue = create<MessageQueueState>((set, get) => ({
  queues: {},
  inFlight: {},

  enqueue: (threadId, message) => {
    const snapshot = snapshotMessage(message)
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: [...(state.queues[threadId] ?? []), snapshot],
      },
    }))
  },

  // Claim, then acknowledge only after the normal submission path accepts it.
  // A failed head stays in place and blocks later messages, preserving FIFO.
  claimNext: (threadId) => {
    let claim: QueuedMessageClaim | undefined
    set((state) => {
      const queue = state.queues[threadId]
      const head = queue?.[0]
      if (!head || head.failure || state.inFlight[threadId]) return state

      const claimId = `${head.id}:${Date.now()}:${Math.random()}`
      claim = { message: head, claimId }
      return {
        inFlight: {
          ...state.inFlight,
          [threadId]: { messageId: head.id, claimId },
        },
      }
    })
    return claim
  },

  acknowledge: (threadId, claim) => {
    set((state) => {
      const inFlight = state.inFlight[threadId]
      const queue = state.queues[threadId]
      if (
        !inFlight ||
        inFlight.messageId !== claim.message.id ||
        inFlight.claimId !== claim.claimId ||
        queue?.[0]?.id !== claim.message.id
      ) {
        return state
      }
      const { [threadId]: _, ...restInFlight } = state.inFlight
      return {
        queues: { ...state.queues, [threadId]: queue.slice(1) },
        inFlight: restInFlight,
      }
    })
  },

  isDispatchable: (threadId, claim) => {
    const inFlight = get().inFlight[threadId]
    return (
      inFlight?.messageId === claim.message.id &&
      inFlight.claimId === claim.claimId &&
      !inFlight.cancellationRequested &&
      get().queues[threadId]?.[0]?.id === claim.message.id
    )
  },

  discard: (threadId, claim) => {
    set((state) => {
      const inFlight = state.inFlight[threadId]
      const queue = state.queues[threadId]
      if (
        inFlight?.messageId !== claim.message.id ||
        inFlight.claimId !== claim.claimId ||
        queue?.[0]?.id !== claim.message.id
      ) {
        return state
      }
      const { [threadId]: _, ...restInFlight } = state.inFlight
      return {
        queues: { ...state.queues, [threadId]: queue.slice(1) },
        inFlight: restInFlight,
      }
    })
  },

  requestCancellation: (threadId, messageId) => {
    let requested = false
    set((state) => {
      const inFlight = state.inFlight[threadId]
      if (inFlight?.messageId !== messageId) return state
      requested = true
      return {
        inFlight: {
          ...state.inFlight,
          [threadId]: { ...inFlight, cancellationRequested: true },
        },
      }
    })
    return requested
  },

  release: (threadId, claim, failure) => {
    set((state) => {
      const inFlight = state.inFlight[threadId]
      const queue = state.queues[threadId]
      if (
        !inFlight ||
        inFlight.messageId !== claim.message.id ||
        inFlight.claimId !== claim.claimId ||
        !queue?.length ||
        queue[0].id !== claim.message.id
      ) {
        return state
      }
      const { [threadId]: _, ...restInFlight } = state.inFlight
      return {
        queues: {
          ...state.queues,
          [threadId]: [{ ...queue[0], failure }, ...queue.slice(1)],
        },
        inFlight: restInFlight,
      }
    })
  },

  removeMessage: (threadId, messageId) => {
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue) return state
      const inFlight = state.inFlight[threadId]
      if (inFlight?.messageId === messageId) {
        return {
          inFlight: {
            ...state.inFlight,
            [threadId]: { ...inFlight, cancellationRequested: true },
          },
        }
      }
      const filtered = queue.filter((m) => m.id !== messageId)
      if (filtered.length === queue.length) return state
      return {
        queues: { ...state.queues, [threadId]: filtered },
      }
    })
  },

  clearQueue: (threadId) => {
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue?.length) return state
      const inFlight = state.inFlight[threadId]
      if (inFlight && queue[0]?.id === inFlight.messageId) {
        return {
          queues: { ...state.queues, [threadId]: [queue[0]] },
          inFlight: {
            ...state.inFlight,
            [threadId]: { ...inFlight, cancellationRequested: true },
          },
        }
      }
      const updated = { ...state.queues }
      delete updated[threadId]
      return { queues: updated }
    })
  },

  getQueue: (threadId) => {
    return get().queues[threadId] ?? EMPTY_QUEUE
  },
}))
