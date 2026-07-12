import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PiRawEvent } from '@/lib/pi'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as Array<(event: { payload: PiRawEvent }) => void>,
  unlisten: vi.fn(),
  listen: vi.fn(),
  approvalListener: undefined as
    | ((event: { payload: PiRawEvent }) => void)
    | undefined,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))

import { usePiApproval } from '@/hooks/usePiApproval'
import { createPiMessageStream } from '../pi-stream'

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
  mocks.listeners = mocks.approvalListener ? [mocks.approvalListener] : []
  mocks.unlisten.mockReset()
  mocks.listen.mockReset()
  mocks.listen.mockImplementation(
    async (
      _name: string,
      listener: (event: { payload: PiRawEvent }) => void
    ) => {
      mocks.listeners.push(listener)
      return mocks.unlisten
    }
  )
  usePiApproval.setState({ queues: {} })
})

describe('createPiMessageStream run ownership', () => {
  it('does not start Pi after stop while approval-listener setup is deferred', async () => {
    const abortController = new AbortController()
    let resolveApprovalListener: (() => void) | undefined
    mocks.listen.mockImplementationOnce(
      (_name: string, listener: (event: { payload: PiRawEvent }) => void) =>
        new Promise((resolve) => {
          resolveApprovalListener = () => {
            mocks.approvalListener = listener
            mocks.listeners.push(listener)
            resolve(mocks.unlisten)
          }
        })
    )

    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'stop during listener startup',
      abortSignal: abortController.signal,
      isStale: () => false,
    })
    const reader = stream.getReader()
    await reader.read()

    abortController.abort()
    resolveApprovalListener?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'pi_start',
      expect.anything()
    )
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'pi_prompt',
      expect.anything()
    )
  })

  it('does not prompt after stop while Pi startup is deferred', async () => {
    const abortController = new AbortController()
    let resolvePiStart: (() => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'pi_start') {
        return new Promise<void>((resolve) => {
          resolvePiStart = resolve
        })
      }
      return Promise.resolve(undefined)
    })

    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'stop during Pi startup',
      abortSignal: abortController.signal,
      isStale: () => false,
    })
    const reader = stream.getReader()
    await reader.read()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_start',
        expect.objectContaining({ threadId: 'thread-1' })
      )
    )

    abortController.abort()
    resolvePiStart?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'pi_prompt',
      expect.anything()
    )
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
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_prompt',
        expect.objectContaining({ threadId: 'thread-1', runId: expect.any(String) })
      )
    )
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

  it('keeps two concurrent thread streams isolated through terminal cleanup', async () => {
    const onA = vi.fn()
    const onB = vi.fn()
    const terminalA = vi.fn()
    const terminalB = vi.fn()
    const streamA = createPiMessageStream({
      threadId: 'thread-a',
      message: 'A',
      abortSignal: undefined,
      isStale: () => false,
      onPiEvent: onA,
      onTerminal: terminalA,
    })
    const streamB = createPiMessageStream({
      threadId: 'thread-b',
      message: 'B',
      abortSignal: undefined,
      isStale: () => false,
      onPiEvent: onB,
      onTerminal: terminalB,
    })
    const readerA = streamA.getReader()
    const readerB = streamB.getReader()
    await Promise.all([readerA.read(), readerB.read()])
    await vi.waitFor(() =>
      expect(
        mocks.invoke.mock.calls.filter(([command]) => command === 'pi_prompt')
      ).toHaveLength(2)
    )
    const prompts = mocks.invoke.mock.calls
      .filter(([command]) => command === 'pi_prompt')
      .map(([, payload]) => payload)
    const promptA = prompts.find((payload) => payload.threadId === 'thread-a')
    const promptB = prompts.find((payload) => payload.threadId === 'thread-b')

    mocks.listeners.forEach((listener) =>
      listener({
        payload: {
          type: 'message_update',
          thread_id: 'thread-a',
          run_id: promptA.runId,
          assistantMessageEvent: { type: 'text_delta', delta: 'only A' },
        },
      })
    )
    expect(onA).toHaveBeenCalledOnce()
    expect(onB).not.toHaveBeenCalled()

    mocks.listeners.forEach((listener) =>
      listener({
        payload: { type: 'agent_end', thread_id: 'thread-a', run_id: promptA.runId },
      })
    )
    await vi.waitFor(() => expect(terminalA).toHaveBeenCalledOnce())
    expect(terminalB).not.toHaveBeenCalled()

    mocks.listeners.forEach((listener) =>
      listener({
        payload: { type: 'agent_end', thread_id: 'thread-b', run_id: promptB.runId },
      })
    )
    await vi.waitFor(() => expect(terminalB).toHaveBeenCalledOnce())
  })

  it('tracks capacity waiting and admission for the same run without resubmitting', async () => {
    const onRunStateChange = vi.fn()
    const stream = createPiMessageStream({
      threadId: 'thread-c',
      message: 'C',
      abortSignal: undefined,
      isStale: () => false,
      onRunStateChange,
    })
    const reader = stream.getReader()
    await reader.read()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_prompt',
        expect.objectContaining({ threadId: 'thread-c', runId: expect.any(String) })
      )
    )
    const prompt = mocks.invoke.mock.calls.find(([command]) => command === 'pi_prompt')?.[1]

    mocks.listeners.forEach((listener) =>
      listener({
        payload: {
          type: 'pi_runtime_waiting',
          thread_id: 'thread-c',
          run_id: prompt.runId,
        },
      })
    )
    mocks.listeners.forEach((listener) =>
      listener({
        payload: {
          type: 'prompt_accepted',
          thread_id: 'thread-c',
          run_id: prompt.runId,
        },
      })
    )

    expect(onRunStateChange.mock.calls).toEqual([
      [prompt.runId, 'capacity_waiting'],
      [prompt.runId, 'active'],
    ])
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'pi_prompt')
    ).toHaveLength(1)
    await reader.cancel()
  })

  it('stops the exact capacity waiter once and never admits it later', async () => {
    const abortController = new AbortController()
    const onTerminal = vi.fn()
    const onRunStateChange = vi.fn()
    const stream = createPiMessageStream({
      threadId: 'thread-c',
      message: 'C',
      abortSignal: abortController.signal,
      isStale: () => false,
      onTerminal,
      onRunStateChange,
    })
    const reader = stream.getReader()
    await reader.read()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_prompt',
        expect.objectContaining({ threadId: 'thread-c', runId: expect.any(String) })
      )
    )
    const prompt = mocks.invoke.mock.calls.find(([command]) => command === 'pi_prompt')?.[1]
    mocks.listeners.forEach((listener) =>
      listener({
        payload: {
          type: 'pi_runtime_waiting',
          thread_id: 'thread-c',
          run_id: prompt.runId,
        },
      })
    )

    abortController.abort()
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('pi_abort', {
        threadId: 'thread-c',
        thread_id: 'thread-c',
        runId: prompt.runId,
        run_id: prompt.runId,
      })
    )
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledOnce())

    mocks.listeners.forEach((listener) =>
      listener({
        payload: {
          type: 'prompt_accepted',
          thread_id: 'thread-c',
          run_id: prompt.runId,
        },
      })
    )
    expect(onRunStateChange.mock.calls).toEqual([[prompt.runId, 'capacity_waiting']])
    expect(onTerminal).toHaveBeenCalledOnce()
  })

  it('keeps approvals and a crash scoped to their owning concurrent run', async () => {
    const terminalA = vi.fn()
    const terminalB = vi.fn()
    const streamA = createPiMessageStream({
      threadId: 'thread-a', message: 'A', abortSignal: undefined, isStale: () => false,
      onTerminal: terminalA,
    })
    const streamB = createPiMessageStream({
      threadId: 'thread-b', message: 'B', abortSignal: undefined, isStale: () => false,
      onTerminal: terminalB,
    })
    await Promise.all([streamA.getReader().read(), streamB.getReader().read()])
    await vi.waitFor(() =>
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'pi_prompt')).toHaveLength(2)
    )
    const prompts = mocks.invoke.mock.calls
      .filter(([command]) => command === 'pi_prompt')
      .map(([, payload]) => payload)
    const promptA = prompts.find((payload) => payload.threadId === 'thread-a')
    const promptB = prompts.find((payload) => payload.threadId === 'thread-b')
    const approvalFor = (threadId: string, runId: string, id: string): PiRawEvent => ({
      type: 'extension_ui_request', thread_id: threadId, run_id: runId, id,
      method: 'confirm', title: 'divo_approval_v1',
      message: JSON.stringify({
        version: 1, toolCallId: `tool-${id}`, source: 'divo', kind: 'gmail.send',
        action: 'send', title: 'Review email', presentation: { to: ['maya@example.com'] },
      }),
    })
    mocks.listeners.forEach((listener) => listener({ payload: approvalFor('thread-a', promptA.runId, 'approval-a') }))
    mocks.listeners.forEach((listener) => listener({ payload: approvalFor('thread-b', promptB.runId, 'approval-b') }))
    expect(usePiApproval.getState().queues['thread-a']).toHaveLength(1)
    expect(usePiApproval.getState().queues['thread-b']).toHaveLength(1)

    mocks.listeners.forEach((listener) =>
      listener({
        payload: {
          type: 'pi_process_exit', thread_id: 'thread-a', run_id: promptA.runId,
          message: 'Pi process exited',
        },
      })
    )
    await vi.waitFor(() => expect(terminalA).toHaveBeenCalledOnce())
    expect(terminalB).not.toHaveBeenCalled()
    expect(usePiApproval.getState().queues['thread-b']).toHaveLength(1)
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

  it('closes a partial Pi response as a stop rather than emitting a generic error', async () => {
    const abortController = new AbortController()
    const stream = createPiMessageStream({
      threadId: 'thread-1',
      message: 'stop after a partial answer',
      abortSignal: abortController.signal,
      isStale: () => false,
    })
    const reader = stream.getReader()
    const first = await reader.read()
    expect(first.value).toMatchObject({ type: 'start' })
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_prompt',
        expect.objectContaining({ threadId: 'thread-1', runId: expect.any(String) })
      )
    )
    const prompt = mocks.invoke.mock.calls.find(([command]) => command === 'pi_prompt')?.[1]
    const transcriptListener = mocks.listeners.at(-1)
    transcriptListener?.({
      payload: {
        type: 'message_update',
        thread_id: 'thread-1',
        run_id: prompt.runId,
        assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' },
      },
    })

    const partialChunks = [await reader.read(), await reader.read()]
    expect(partialChunks.map((chunk) => chunk.value?.type)).toEqual([
      'text-start',
      'text-delta',
    ])

    abortController.abort()
    const rest: Array<{ type?: string }> = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      rest.push(next.value as { type?: string })
    }

    expect(rest.map((chunk) => chunk.type)).toContain('text-end')
    expect(rest.map((chunk) => chunk.type)).not.toContain('error')
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
