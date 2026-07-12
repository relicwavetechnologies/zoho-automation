import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PiRawEvent } from '@/lib/pi'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as Array<(event: { payload: PiRawEvent }) => void>,
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      _name: string,
      listener: (event: { payload: PiRawEvent }) => void
    ) => {
      mocks.listeners.push(listener)
      return mocks.unlisten
    }
  ),
}))

import { usePiApproval } from '@/hooks/usePiApproval'
import { createPiMessageStream } from '../pi-stream'

describe('createPiMessageStream run ownership', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(undefined)
    mocks.listeners = []
    mocks.unlisten.mockReset()
    usePiApproval.setState({ queues: {} })
  })

  it('scopes aborts and approval responses to one generated run', async () => {
    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'send the email',
      abortSignal: undefined,
      isStale: () => false,
    })
    const reader = stream.getReader()
    await reader.read()
    await vi.waitFor(() => expect(mocks.listeners).toHaveLength(2))
    const prompt = mocks.invoke.mock.calls.find(([command]) => command === 'pi_prompt')?.[1]
    expect(prompt).toMatchObject({ threadId: 'thread-1', runId: expect.any(String) })
    expect(prompt.runId).toBe(prompt.run_id)

    mocks.listeners[0]?.({
      payload: {
        type: 'extension_ui_request',
        thread_id: 'thread-1',
        run_id: prompt.runId,
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
        runId: prompt.runId,
        confirmed: false,
      })
    )
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
    expect(mocks.invoke).toHaveBeenCalledWith('pi_abort', {
      threadId: 'thread-1',
      thread_id: 'thread-1',
      runId: prompt.runId,
      run_id: prompt.runId,
    })

    // A memory editor can outlive the stream that opened it. It must still
    // reach the persistent approval queue rather than leave Pi blocked.
    mocks.listeners[0]?.({
      payload: {
        type: 'extension_ui_request',
        thread_id: 'thread-1',
        run_id: prompt.runId,
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
      runId: prompt.runId,
    })
  })

  it('ignores a stale transcript event from another run', async () => {
    const onPiEvent = vi.fn()
    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'current run',
      abortSignal: undefined,
      isStale: () => false,
      onPiEvent,
    })
    const reader = stream.getReader()
    await reader.read()
    await vi.waitFor(() => expect(mocks.listeners.length).toBeGreaterThanOrEqual(1))
    const prompt = mocks.invoke.mock.calls.find(([command]) => command === 'pi_prompt')?.[1]
    const transcriptListener = mocks.listeners.at(-1)

    transcriptListener?.({
      payload: {
        type: 'agent_end',
        thread_id: 'thread-1',
        run_id: `${prompt.runId}-stale`,
      },
    })

    expect(onPiEvent).not.toHaveBeenCalled()
    await reader.cancel()
  })

  it('waits for scoped abort reconciliation before releasing the terminal busy state', async () => {
    const abortController = new AbortController()
    const onTerminal = vi.fn()
    let resolveAbort: (() => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'pi_abort') {
        return new Promise<void>((resolve) => {
          resolveAbort = resolve
        })
      }
      return Promise.resolve(undefined)
    })

    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'abort this run',
      abortSignal: abortController.signal,
      isStale: () => false,
      onTerminal,
    })
    const reader = stream.getReader()
    await reader.read()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_prompt',
        expect.objectContaining({ threadId: 'thread-1', runId: expect.any(String) })
      )
    )
    const prompt = mocks.invoke.mock.calls.find(([command]) => command === 'pi_prompt')?.[1]
    const transcriptListener = mocks.listeners.at(-1)

    abortController.abort()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_abort',
        expect.objectContaining({ threadId: 'thread-1', runId: prompt.runId })
      )
    )
    expect(onTerminal).not.toHaveBeenCalled()

    // A terminal event from the aborting run cannot release busy early.
    transcriptListener?.({
      payload: {
        type: 'agent_end',
        thread_id: 'thread-1',
        run_id: prompt.runId,
      },
    })
    expect(onTerminal).not.toHaveBeenCalled()

    resolveAbort?.()
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledOnce())
  })

  it('releases terminal state after direct stream cancellation reconciles', async () => {
    const onTerminal = vi.fn()
    let resolveAbort: (() => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'pi_abort') {
        return new Promise<void>((resolve) => {
          resolveAbort = resolve
        })
      }
      return Promise.resolve(undefined)
    })

    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'cancel this run',
      abortSignal: undefined,
      isStale: () => false,
      onTerminal,
    })
    const reader = stream.getReader()
    await reader.read()
    const cancellation = reader.cancel()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_abort',
        expect.objectContaining({ threadId: 'thread-1', runId: expect.any(String) })
      )
    )
    expect(onTerminal).not.toHaveBeenCalled()

    resolveAbort?.()
    await cancellation
    expect(onTerminal).toHaveBeenCalledOnce()
  })
})
