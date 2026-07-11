import { describe, expect, it } from 'vitest'

import {
  parsePiMemoryReviewEvent,
  validatePiMemoryReviewResponse,
} from '../memory-review'
import type { PiRawEvent } from '../types'

function event(descriptor: unknown): PiRawEvent {
  return {
    type: 'extension_ui_request',
    thread_id: 'thread-1',
    id: 'review-1',
    method: 'editor',
    title: 'divo_memory_review_v1',
    prefill: JSON.stringify(descriptor),
  }
}

const descriptor = {
  version: 1,
  proposalId: 'proposal-1',
  bullets: [
    { id: 'fact-1', text: 'Finance reviews refunds over ₹10K.' },
    { id: 'fact-2', text: 'Acme uses net-60 terms.' },
  ],
  allowedTargets: [
    { scope: 'personal', label: 'Personal' },
    {
      scope: 'department',
      label: 'Finance',
      departmentId: 'dept-1',
    },
  ],
}

describe('Pi memory review protocol', () => {
  it('parses the named editor request with backend-provided targets', () => {
    const result = parsePiMemoryReviewEvent(event(descriptor))
    expect(result.kind).toBe('memory-review')
    if (result.kind !== 'memory-review') return
    expect(result.request).toMatchObject({
      protocol: 'memory-review',
      requestId: 'review-1',
      threadId: 'thread-1',
    })
    expect(result.request.descriptor.allowedTargets[1]).toEqual({
      scope: 'department',
      label: 'Finance',
      departmentId: 'dept-1',
    })
  })

  it('rejects malformed targets, duplicate bullets, and unknown versions', () => {
    expect(
      parsePiMemoryReviewEvent(
        event({ ...descriptor, version: 2 })
      )
    ).toMatchObject({ kind: 'invalid' })
    expect(
      parsePiMemoryReviewEvent(
        event({
          ...descriptor,
          bullets: [descriptor.bullets[0], descriptor.bullets[0]],
        })
      )
    ).toMatchObject({ kind: 'invalid', reason: 'memory bullet ids must be unique' })
    expect(
      parsePiMemoryReviewEvent(
        event({
          ...descriptor,
          allowedTargets: [{ scope: 'department', label: 'Finance' }],
        })
      )
    ).toMatchObject({
      kind: 'invalid',
      reason: 'department targets require departmentId',
    })
  })

  it('accepts only selections from the exact request', () => {
    const parsed = parsePiMemoryReviewEvent(event(descriptor))
    if (parsed.kind !== 'memory-review') throw new Error('expected request')
    expect(() =>
      validatePiMemoryReviewResponse(parsed.request, {
        version: 1,
        proposalId: 'proposal-1',
        decision: 'approve',
        selectedTarget: { scope: 'company' },
        selectedBulletIds: ['fact-1'],
      })
    ).toThrow(/not provided by the backend/)
    expect(() =>
      validatePiMemoryReviewResponse(parsed.request, {
        version: 1,
        proposalId: 'proposal-1',
        decision: 'approve',
        selectedTarget: { scope: 'personal' },
        selectedBulletIds: ['invented'],
      })
    ).toThrow(/not part of this proposal/)
  })
})
