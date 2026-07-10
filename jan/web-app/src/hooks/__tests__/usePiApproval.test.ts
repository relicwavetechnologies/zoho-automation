import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PiApprovalRequest } from '@/lib/pi/approval'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import {
  consumePiApprovalEvent,
  PI_APPROVAL_RESPONSE_COMMAND,
  usePiApproval,
} from '../usePiApproval'

function request(
  requestId: string,
  overrides: Partial<PiApprovalRequest> = {}
): PiApprovalRequest {
  return {
    requestId,
    threadId: 'thread-1',
    descriptor: {
      version: 1,
      toolCallId: `tool-${requestId}`,
      source: 'divo',
      kind: 'gmail.send',
      action: 'send',
      title: 'Review email before sending',
      presentation: { to: ['maya@example.com'] },
    },
    receivedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
    ...overrides,
  }
}

describe('usePiApproval', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(undefined)
    usePiApproval.setState({ queues: {} })
  })

  it('queues by thread and ignores duplicate request ids', () => {
    act(() => {
      usePiApproval.getState().enqueue(request('request-1'))
      usePiApproval.getState().enqueue(request('request-1'))
      usePiApproval
        .getState()
        .enqueue(request('request-2', { threadId: 'thread-2' }))
    })

    expect(usePiApproval.getState().queues['thread-1']).toHaveLength(1)
    expect(usePiApproval.getState().queues['thread-2']).toHaveLength(1)
  })

  it('delivers a payload-bound decision and removes it only after success', async () => {
    usePiApproval.getState().enqueue(request('request-1'))

    await usePiApproval.getState().resolve('thread-1', 'request-1', true)

    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'request-1',
      threadId: 'thread-1',
      confirmed: true,
    })
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('keeps a failed decision visible and leaves Pi paused', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('desktop unavailable'))
    usePiApproval.getState().enqueue(request('request-1'))

    await usePiApproval.getState().resolve('thread-1', 'request-1', true)

    expect(usePiApproval.getState().queues['thread-1']?.[0]).toMatchObject({
      status: 'error',
      error: 'desktop unavailable',
    })
  })

  it('enables Rust-owned always allow only for an active Bash request', async () => {
    usePiApproval.getState().enqueue(
      request('request-bash', {
        descriptor: {
          version: 1,
          toolCallId: 'tool-bash',
          source: 'bash',
          kind: 'bash.execute',
          action: 'execute',
          title: 'Run terminal command',
          presentation: { command: 'npm test' },
        },
      })
    )

    const allowed = await usePiApproval
      .getState()
      .allowBashForTask('thread-1', 'request-bash')

    expect(allowed).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'request-bash',
      threadId: 'thread-1',
      confirmed: true,
      alwaysAllowBash: true,
    })
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('refuses always allow for non-Bash requests', async () => {
    usePiApproval.getState().enqueue(request('request-divo'))

    const allowed = await usePiApproval
      .getState()
      .allowBashForTask('thread-1', 'request-divo')

    expect(allowed).toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(usePiApproval.getState().queues['thread-1']).toHaveLength(1)
  })

  it('forces stale approvals to denial even when approve is requested', async () => {
    usePiApproval
      .getState()
      .enqueue(request('request-1', { expiresAt: Date.now() - 1 }))

    await usePiApproval.getState().resolve('thread-1', 'request-1', true)

    expect(mocks.invoke).toHaveBeenCalledWith(
      PI_APPROVAL_RESPONSE_COMMAND,
      expect.objectContaining({ confirmed: false })
    )
  })

  it('denies every pending request before thread cleanup', async () => {
    usePiApproval.getState().enqueue(request('request-1'))
    usePiApproval.getState().enqueue(request('request-2'))

    await usePiApproval.getState().denyThread('thread-1')

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      PI_APPROVAL_RESPONSE_COMMAND,
      expect.objectContaining({ requestId: 'request-1', confirmed: false })
    )
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      PI_APPROVAL_RESPONSE_COMMAND,
      expect.objectContaining({ requestId: 'request-2', confirmed: false })
    )
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('automatically denies a malformed private approval event', async () => {
    const consumed = await consumePiApprovalEvent({
      type: 'extension_ui_request',
      thread_id: 'thread-1',
      id: 'request-bad',
      method: 'confirm',
      title: 'divo_approval_v1',
      message: JSON.stringify({ version: 99 }),
    })

    expect(consumed).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'request-bad',
      threadId: 'thread-1',
      confirmed: false,
    })
    expect(usePiApproval.getState().queues).toEqual({})
  })
})
