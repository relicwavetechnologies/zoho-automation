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
    runId: 'run-1',
    descriptor: {
      version: 1,
      toolCallId: `tool-${requestId}`,
      source: 'divo',
      kind: 'gmail.send',
      action: 'send',
      title: 'Review email before sending',
      presentation: { to: ['maya@example.com'] },
      runCorrelation: { version: 1, threadId: 'thread-1', runId: 'run-1' },
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

  it('queues by exact thread/run/request identity', () => {
    act(() => {
      usePiApproval.getState().enqueue(request('request-1'))
      usePiApproval.getState().enqueue(request('request-1'))
      usePiApproval
        .getState()
        .enqueue(request('request-1', { runId: 'run-2' }))
      usePiApproval
        .getState()
        .enqueue(request('request-2', { threadId: 'thread-2' }))
    })

    expect(usePiApproval.getState().queues['thread-1']).toHaveLength(2)
    expect(usePiApproval.getState().queues['thread-2']).toHaveLength(1)
  })

  it('resolves only the request from the supplied active run', async () => {
    usePiApproval.getState().enqueue(request('same-request', { runId: 'run-a1' }))
    usePiApproval.getState().enqueue(request('same-request', { runId: 'run-a2' }))

    await usePiApproval
      .getState()
      .resolve('thread-1', 'same-request', true, 'run-a2')

    expect(mocks.invoke).toHaveBeenCalledWith(
      PI_APPROVAL_RESPONSE_COMMAND,
      expect.objectContaining({
        requestId: 'same-request',
        threadId: 'thread-1',
        runId: 'run-a2',
        confirmed: true,
      })
    )
    expect(usePiApproval.getState().queues['thread-1']).toMatchObject([
      { requestId: 'same-request', runId: 'run-a1' },
    ])
  })

  it('delivers a payload-bound decision and removes it only after success', async () => {
    usePiApproval.getState().enqueue(request('request-1'))

    await usePiApproval.getState().resolve('thread-1', 'request-1', true, 'run-1')

    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'request-1',
      threadId: 'thread-1',
      runId: 'run-1',
      confirmed: true,
    })
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('keeps a failed decision visible and leaves Pi paused', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('desktop unavailable'))
    usePiApproval.getState().enqueue(request('request-1'))

    await usePiApproval.getState().resolve('thread-1', 'request-1', true, 'run-1')

    expect(usePiApproval.getState().queues['thread-1']?.[0]).toMatchObject({
      status: 'error',
      error: 'desktop unavailable',
    })
  })

  it('keeps the actionable runtime delivery error returned by Tauri', async () => {
    mocks.invoke.mockRejectedValueOnce(
      'The local Divo runtime could not deliver this approval. Stop the run and send the request again. (Pi process is not running)'
    )
    usePiApproval.getState().enqueue(request('request-1'))

    await usePiApproval.getState().resolve('thread-1', 'request-1', true, 'run-1')

    expect(usePiApproval.getState().queues['thread-1']?.[0]).toMatchObject({
      status: 'error',
      error:
        'The local Divo runtime could not deliver this approval. Stop the run and send the request again. (Pi process is not running)',
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
          runCorrelation: { version: 1, threadId: 'thread-1', runId: 'run-1' },
        },
      })
    )

    const allowed = await usePiApproval
      .getState()
      .allowBashForTask('thread-1', 'request-bash', 'run-1')

    expect(allowed).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'request-bash',
      threadId: 'thread-1',
      runId: 'run-1',
      confirmed: true,
      alwaysAllowBash: true,
    })
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('does not hide a failed always-allow delivery behind a generic error', async () => {
    mocks.invoke.mockRejectedValueOnce('Pi process is not running')
    usePiApproval.getState().enqueue(
      request('request-bash', {
        descriptor: {
          version: 1,
          toolCallId: 'tool-bash',
          source: 'bash',
          kind: 'bash.execute',
          action: 'execute',
          title: 'Run terminal command',
          presentation: { command: 'pwd' },
          runCorrelation: { version: 1, threadId: 'thread-1', runId: 'run-1' },
        },
      })
    )

    const allowed = await usePiApproval
      .getState()
      .allowBashForTask('thread-1', 'request-bash', 'run-1')

    expect(allowed).toBe(false)
    expect(usePiApproval.getState().queues['thread-1']?.[0]).toMatchObject({
      status: 'error',
      error: 'Pi process is not running',
    })
  })

  it('refuses always allow for non-Bash requests', async () => {
    usePiApproval.getState().enqueue(request('request-divo'))

    const allowed = await usePiApproval
      .getState()
      .allowBashForTask('thread-1', 'request-divo', 'run-1')

    expect(allowed).toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(usePiApproval.getState().queues['thread-1']).toHaveLength(1)
  })

  it('forces stale approvals to denial even when approve is requested', async () => {
    usePiApproval
      .getState()
      .enqueue(request('request-1', { expiresAt: Date.now() - 1 }))

    await usePiApproval.getState().resolve('thread-1', 'request-1', true, 'run-1')

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
      run_id: 'run-1',
      id: 'request-bad',
      method: 'confirm',
      title: 'divo_approval_v1',
      message: JSON.stringify({ version: 99 }),
    })

    expect(consumed).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'request-bad',
      threadId: 'thread-1',
      runId: 'run-1',
      confirmed: false,
    })
    expect(usePiApproval.getState().queues).toEqual({})
  })

  it('queues a memory review and returns a structured value response', async () => {
    const consumed = await consumePiApprovalEvent({
      type: 'extension_ui_request',
      thread_id: 'thread-1',
      run_id: 'run-1',
      id: 'review-1',
      method: 'editor',
      title: 'divo_memory_review_v1',
      prefill: JSON.stringify({
        version: 1,
        proposalId: 'proposal-1',
        bullets: [{ id: 'fact-1', text: 'Acme uses net-60 terms.' }],
        allowedTargets: [{ scope: 'personal', label: 'Personal' }],
        runCorrelation: { version: 1, threadId: 'thread-1', runId: 'run-1' },
      }),
    })

    expect(consumed).toBe(true)
    expect(usePiApproval.getState().queues['thread-1']?.[0]).toMatchObject({
      protocol: 'memory-review',
      requestId: 'review-1',
    })

    await usePiApproval.getState().resolveMemory(
      'thread-1',
      'review-1',
      {
        version: 1,
        proposalId: 'proposal-1',
        decision: 'approve',
        selectedTarget: { scope: 'personal' },
        selectedBulletIds: ['fact-1'],
      },
      'run-1'
    )

    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'review-1',
      threadId: 'thread-1',
      runId: 'run-1',
      value: JSON.stringify({
        version: 1,
        proposalId: 'proposal-1',
        decision: 'approve',
        selectedTarget: { scope: 'personal' },
        selectedBulletIds: ['fact-1'],
      }),
    })
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('fails closed when a memory review selects a target it was not given', async () => {
    await consumePiApprovalEvent({
      type: 'extension_ui_request',
      thread_id: 'thread-1',
      run_id: 'run-1',
      id: 'review-1',
      method: 'editor',
      title: 'divo_memory_review_v1',
      prefill: JSON.stringify({
        version: 1,
        proposalId: 'proposal-1',
        bullets: [{ id: 'fact-1', text: 'Acme uses net-60 terms.' }],
        allowedTargets: [{ scope: 'personal', label: 'Personal' }],
        runCorrelation: { version: 1, threadId: 'thread-1', runId: 'run-1' },
      }),
    })

    const delivered = await usePiApproval
      .getState()
      .resolveMemory(
        'thread-1',
        'review-1',
        {
          version: 1,
          proposalId: 'proposal-1',
          decision: 'approve',
          selectedTarget: { scope: 'company' },
          selectedBulletIds: ['fact-1'],
        },
        'run-1'
      )

    expect(delivered).toBe(false)
    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'review-1',
      threadId: 'thread-1',
      runId: 'run-1',
      cancelled: true,
    })
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('queues Teach clarification and resumes the same run with structured answers', async () => {
    const consumed = await consumePiApprovalEvent({
      type: 'extension_ui_request',
      thread_id: 'thread-1',
      run_id: 'run-1',
      id: 'clarify-1',
      method: 'editor',
      title: 'divo_teach_clarification_v1',
      prefill: JSON.stringify({
        version: 1,
        reason: 'The workflow trigger is unclear.',
        questions: [{
          id: 'trigger',
          question: 'When should Divo run this?',
          selection: 'single',
          options: [
            { id: 'new-email', label: 'When a new email arrives' },
            { id: 'manual', label: 'Only when I ask' },
          ],
          allowCustom: true,
        }],
        runCorrelation: {
          version: 1,
          threadId: 'thread-1',
          runId: 'run-1',
          profile: 'teach',
          teachSessionId: 'teach-1',
          departmentId: 'department-1',
        },
      }),
    })

    expect(consumed).toBe(true)
    expect(usePiApproval.getState().queues['thread-1']?.[0]).toMatchObject({
      protocol: 'teach-clarification',
      requestId: 'clarify-1',
    })

    await usePiApproval.getState().resolveTeachClarification(
      'thread-1',
      'clarify-1',
      {
        version: 1,
        decision: 'answer',
        answers: [{ questionId: 'trigger', selectedOptionIds: ['new-email'] }],
      },
      'run-1'
    )

    expect(mocks.invoke).toHaveBeenCalledWith(PI_APPROVAL_RESPONSE_COMMAND, {
      requestId: 'clarify-1',
      threadId: 'thread-1',
      runId: 'run-1',
      value: JSON.stringify({
        version: 1,
        decision: 'answer',
        answers: [{ questionId: 'trigger', selectedOptionIds: ['new-email'] }],
      }),
    })
    expect(usePiApproval.getState().queues['thread-1']).toBeUndefined()
  })

  it('reconciles only the run-owned request cancelled by Rust', async () => {
    usePiApproval.getState().enqueue(request('same-id', { runId: 'run-1' }))
    usePiApproval.getState().enqueue(request('other-id', { runId: 'run-2' }))

    const consumed = await consumePiApprovalEvent({
      type: 'extension_ui_response',
      thread_id: 'thread-1',
      run_id: 'run-1',
      id: 'same-id',
      cancelled: true,
      reason: 'process_exited',
    })

    expect(consumed).toBe(true)
    expect(usePiApproval.getState().queues['thread-1']).toMatchObject([
      { requestId: 'other-id', runId: 'run-2' },
    ])
  })
})
