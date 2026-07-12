import { describe, it, expect, beforeEach } from 'vitest'
import { useMessageQueue, type QueuedMessage } from '../message-queue-store'

function resetStore() {
  useMessageQueue.setState({ queues: {}, inFlight: {} })
}

function makeMessage(id: string, text: string): QueuedMessage {
  return {
    id,
    text,
    createdAt: Date.now(),
    attachments: [],
    skillReferences: [],
    parentId: null,
    hadBranching: false,
  }
}

describe('useMessageQueue', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('enqueue', () => {
    it('adds a message to an empty queue', () => {
      const { enqueue, getQueue } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'hello'))

      expect(getQueue('thread-1')).toHaveLength(1)
      expect(getQueue('thread-1')[0].text).toBe('hello')
    })

    it('appends messages in FIFO order', () => {
      const { enqueue, getQueue } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'first'))
      enqueue('thread-1', makeMessage('m2', 'second'))
      enqueue('thread-1', makeMessage('m3', 'third'))

      const queue = getQueue('thread-1')
      expect(queue).toHaveLength(3)
      expect(queue.map((m) => m.text)).toEqual(['first', 'second', 'third'])
    })

    it('keeps queues isolated per thread', () => {
      const { enqueue, getQueue } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'for thread 1'))
      enqueue('thread-2', makeMessage('m2', 'for thread 2'))

      expect(getQueue('thread-1')).toHaveLength(1)
      expect(getQueue('thread-2')).toHaveLength(1)
      expect(getQueue('thread-1')[0].text).toBe('for thread 1')
      expect(getQueue('thread-2')[0].text).toBe('for thread 2')
    })
  })

  describe('claim / acknowledge', () => {
    it('keeps the first message until its claim is acknowledged', () => {
      const { enqueue, claimNext, acknowledge, getQueue } =
        useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'first'))
      enqueue('thread-1', makeMessage('m2', 'second'))

      const claim = claimNext('thread-1')
      expect(claim?.message.text).toBe('first')
      expect(getQueue('thread-1')).toHaveLength(2)

      acknowledge('thread-1', claim!)
      expect(getQueue('thread-1')).toHaveLength(1)
      expect(getQueue('thread-1')[0].text).toBe('second')
    })

    it('returns undefined when the queue is empty or its head is already claimed', () => {
      const { enqueue, claimNext } = useMessageQueue.getState()
      expect(claimNext('thread-1')).toBeUndefined()
      enqueue('thread-1', makeMessage('m1', 'first'))
      expect(claimNext('thread-1')).toBeDefined()
      expect(claimNext('thread-1')).toBeUndefined()
    })

    it('retains a failed head with an actionable failure and does not spin past FIFO', () => {
      const { enqueue, claimNext, release, getQueue } =
        useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'first'))
      enqueue('thread-1', makeMessage('m2', 'second'))

      const claim = claimNext('thread-1')!
      release('thread-1', claim, {
        code: 'submission_failed',
        message: 'Try again after fixing the attachment.',
      })

      expect(getQueue('thread-1').map((message) => message.text)).toEqual([
        'first',
        'second',
      ])
      expect(getQueue('thread-1')[0].failure?.message).toContain('attachment')
      expect(claimNext('thread-1')).toBeUndefined()
    })

    it('keeps a claimed head visible until cancellation wins or it is acknowledged', () => {
      const {
        enqueue,
        claimNext,
        requestCancellation,
        isDispatchable,
        discard,
        getQueue,
      } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'first'))
      enqueue('thread-1', makeMessage('m2', 'second'))

      const claim = claimNext('thread-1')!
      expect(requestCancellation('thread-1', 'm1')).toBe(true)
      expect(isDispatchable('thread-1', claim)).toBe(false)
      expect(getQueue('thread-1').map((message) => message.id)).toEqual([
        'm1',
        'm2',
      ])

      discard('thread-1', claim)
      expect(getQueue('thread-1').map((message) => message.id)).toEqual(['m2'])
    })
  })

  describe('removeMessage', () => {
    it('removes a specific message by id', () => {
      const { enqueue, removeMessage, getQueue } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'first'))
      enqueue('thread-1', makeMessage('m2', 'second'))
      enqueue('thread-1', makeMessage('m3', 'third'))

      removeMessage('thread-1', 'm2')
      const queue = getQueue('thread-1')
      expect(queue).toHaveLength(2)
      expect(queue.map((m) => m.text)).toEqual(['first', 'third'])
    })

    it('is a no-op if the message id does not exist', () => {
      const { enqueue, removeMessage, getQueue } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'first'))

      removeMessage('thread-1', 'non-existent')
      expect(getQueue('thread-1')).toHaveLength(1)
    })

    it('is a no-op for a non-existent thread', () => {
      const { removeMessage } = useMessageQueue.getState()
      removeMessage('non-existent', 'm1')
      // Should not throw
    })
  })

  describe('clearQueue', () => {
    it('removes all messages for a thread', () => {
      const { enqueue, clearQueue, getQueue } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'a'))
      enqueue('thread-1', makeMessage('m2', 'b'))
      enqueue('thread-1', makeMessage('m3', 'c'))

      clearQueue('thread-1')
      expect(getQueue('thread-1')).toHaveLength(0)
    })

    it('does not affect other threads', () => {
      const { enqueue, clearQueue, getQueue } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'a'))
      enqueue('thread-2', makeMessage('m2', 'b'))

      clearQueue('thread-1')
      expect(getQueue('thread-1')).toHaveLength(0)
      expect(getQueue('thread-2')).toHaveLength(1)
    })

    it('is a no-op for an empty or non-existent queue', () => {
      const { clearQueue, getQueue } = useMessageQueue.getState()
      // Should not throw
      clearQueue('non-existent')
      expect(getQueue('non-existent')).toHaveLength(0)
    })

    it('cancels but does not hide an in-flight head', () => {
      const { enqueue, claimNext, clearQueue, getQueue, isDispatchable } =
        useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'claimed'))
      enqueue('thread-1', makeMessage('m2', 'later'))
      const claim = claimNext('thread-1')!

      clearQueue('thread-1')

      expect(getQueue('thread-1').map((message) => message.id)).toEqual(['m1'])
      expect(isDispatchable('thread-1', claim)).toBe(false)
    })
  })

  describe('getQueue', () => {
    it('returns an empty array for unknown threads', () => {
      const { getQueue } = useMessageQueue.getState()
      expect(getQueue('unknown')).toEqual([])
    })

    it('returns the same reference for empty queues (avoids re-renders)', () => {
      const { getQueue } = useMessageQueue.getState()
      const a = getQueue('unknown-1')
      const b = getQueue('unknown-2')
      expect(a).toBe(b)
    })
  })

  describe('immutable snapshots and FIFO', () => {
    it('detaches attachments and skill references from later composer edits', () => {
      const { enqueue, getQueue } = useMessageQueue.getState()
      const message = makeMessage('m1', 'with file')
      message.attachments = [
        { type: 'document', name: 'brief.pdf', path: '/tmp/brief.pdf' },
      ]
      message.skillReferences = [
        {
          id: 'skill-1',
          name: 'Briefing',
          description: 'Use the brief',
          category: 'Ops',
          toolIds: ['read-brief'],
        },
      ]
      enqueue('thread-1', message)

      message.attachments[0].name = 'changed.pdf'
      message.skillReferences[0].toolIds.push('changed-tool')

      expect(getQueue('thread-1')[0].attachments[0].name).toBe('brief.pdf')
      expect(getQueue('thread-1')[0].skillReferences[0].toolIds).toEqual([
        'read-brief',
      ])
    })

    it('processes acknowledged messages one at a time in order', () => {
      const { enqueue, claimNext, acknowledge } = useMessageQueue.getState()
      enqueue('thread-1', makeMessage('m1', 'first'))
      enqueue('thread-1', makeMessage('m2', 'second'))
      enqueue('thread-1', makeMessage('m3', 'third'))

      const results: string[] = []
      let claim = claimNext('thread-1')
      while (claim) {
        results.push(claim.message.text)
        acknowledge('thread-1', claim)
        claim = claimNext('thread-1')
      }

      expect(results).toEqual(['first', 'second', 'third'])
    })
  })
})
