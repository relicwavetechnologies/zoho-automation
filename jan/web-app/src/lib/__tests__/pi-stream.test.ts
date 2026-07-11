import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PiRawEvent } from '@/lib/pi'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: undefined as ((event: { payload: PiRawEvent }) => void) | undefined,
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      _name: string,
      listener: (event: { payload: PiRawEvent }) => void
    ) => {
      // The first listener is the durable approval listener. A stream adds a
      // second listener for transcript events, but that one is removed with
      // the stream and must not control approval delivery.
      mocks.listener ??= listener
      return mocks.unlisten
    }
  ),
}))

import { usePiApproval } from '@/hooks/usePiApproval'
import { createPiMessageStream } from '../pi-stream'

describe('createPiMessageStream approval events', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(undefined)
    mocks.listener = undefined
    mocks.unlisten.mockReset()
    usePiApproval.setState({ queues: {} })
  })

  it('keeps approval delivery alive after the originating stream is cancelled', async () => {
    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'send the email',
      abortSignal: undefined,
      isStale: () => false,
    })
    const reader = stream.getReader()
    await reader.read()
    await vi.waitFor(() => expect(mocks.listener).toBeTypeOf('function'))

    mocks.listener?.({
      payload: {
        type: 'extension_ui_request',
        thread_id: 'thread-1',
        id: 'approval-request-1',
        method: 'confirm',
        title: 'divo_approval_v1',
        message: JSON.stringify({
          version: 1,
          toolCallId: 'tool-call-1',
          source: 'divo',
          kind: 'gmail.send',
          action: 'send',
          title: 'Review email before sending',
          presentation: { to: ['maya@example.com'] },
        }),
      },
    })

    expect(usePiApproval.getState().queues['thread-1']).toHaveLength(1)

    await reader.cancel()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('pi_extension_ui_respond', {
        requestId: 'approval-request-1',
        threadId: 'thread-1',
        confirmed: false,
      })
    )
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()

    // A memory editor can outlive the stream that opened it. It must still
    // reach the persistent approval queue rather than leave Pi blocked.
    mocks.listener?.({
      payload: {
        type: 'extension_ui_request',
        thread_id: 'thread-1',
        id: 'memory-review-1',
        method: 'editor',
        title: 'divo_memory_review_v1',
        prefill: JSON.stringify({
          version: 1,
          proposalId: 'proposal-1',
          bullets: [{ id: 'fact-1', text: 'Use net-60 payment terms.' }],
          allowedTargets: [{ scope: 'personal', label: 'Personal' }],
        }),
      },
    })

    await vi.waitFor(() =>
      expect(usePiApproval.getState().queues['thread-1']).toHaveLength(1)
    )
    expect(usePiApproval.getState().queues['thread-1'][0]).toMatchObject({
      protocol: 'memory-review',
      requestId: 'memory-review-1',
    })
  })
})
