import { describe, expect, it } from 'vitest'

import {
  PI_APPROVAL_DEFAULT_TTL_MS,
  parsePiApprovalEvent,
} from '../approval'
import type { PiRawEvent } from '../types'

const NOW = Date.parse('2026-07-10T10:00:00.000Z')

function event(message: unknown): PiRawEvent {
  return {
    type: 'extension_ui_request',
    thread_id: 'thread-1',
    id: 'request-1',
    method: 'confirm',
    title: 'divo_approval_v1',
    message: typeof message === 'string' ? message : JSON.stringify(message),
  }
}

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    toolCallId: 'tool-call-1',
    source: 'divo',
    kind: 'gmail.send',
    action: 'send',
    title: 'Review email before sending',
    presentation: { to: ['maya@example.com'] },
    ...overrides,
  }
}

describe('parsePiApprovalEvent', () => {
  it('parses the versioned private approval protocol', () => {
    const result = parsePiApprovalEvent(event(descriptor()), NOW)

    expect(result.kind).toBe('approval')
    if (result.kind !== 'approval') return
    expect(result.request.requestId).toBe('request-1')
    expect(result.request.descriptor.kind).toBe('gmail.send')
    expect(result.request.expiresAt).toBe(NOW + PI_APPROVAL_DEFAULT_TTL_MS)
  })

  it('ignores unrelated extension UI requests', () => {
    expect(
      parsePiApprovalEvent(
        { ...event(descriptor()), title: 'some_other_dialog' },
        NOW
      )
    ).toEqual({ kind: 'not-approval' })
  })

  it('rejects unknown protocol versions', () => {
    const result = parsePiApprovalEvent(
      event(descriptor({ version: 2 })),
      NOW
    )
    expect(result).toMatchObject({
      kind: 'invalid',
      requestId: 'request-1',
      reason: 'unsupported approval protocol version',
    })
  })

  it('rejects malformed and expired explicit timestamps', () => {
    const malformed = parsePiApprovalEvent(
      event(descriptor({ expiresAt: 'tomorrow-ish' })),
      NOW
    )
    expect(malformed).toMatchObject({
      kind: 'invalid',
      reason: 'expiresAt must be a valid ISO timestamp',
    })

    const expired = parsePiApprovalEvent(
      event(descriptor({ expiresAt: '2026-07-10T09:59:59.000Z' })),
      NOW
    )
    expect(expired).toMatchObject({
      kind: 'invalid',
      reason: 'approval request has expired',
    })
  })

  it('rejects incomplete descriptors instead of guessing', () => {
    const result = parsePiApprovalEvent(
      event(descriptor({ presentation: undefined })),
      NOW
    )
    expect(result).toMatchObject({
      kind: 'invalid',
      reason: 'presentation must be an object',
    })
  })
})

