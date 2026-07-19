import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  ThreadStateIndicator,
  deriveThreadRuntimeState,
} from '../ThreadStateIndicator'
import { useAppState } from '@/hooks/useAppState'
import { useChatSessions } from '@/stores/chat-session-store'
import { usePiApproval } from '@/hooks/usePiApproval'

const THREAD_ID = 't1'

const resetStores = () => {
  useAppState.setState({
    busyThreads: {},
    streamingContents: {},
    loadingModels: {},
    cancelToolCalls: {},
    piThreadRunStates: {},
  })
  useChatSessions.setState({ sessions: {} })
  usePiApproval.setState({ queues: {} })
}

// The indicator only ever reads `status` and `isStreaming` off a session, so a
// partial object is enough to drive it.
const setSessionStatus = (status: string, isStreaming = false) =>
  act(() => {
    useChatSessions.setState({
      sessions: { [THREAD_ID]: { status, isStreaming } as never },
    })
  })

const setRunning = () =>
  act(() => {
    useAppState.setState({ busyThreads: { [THREAD_ID]: true } })
  })

const setWaiting = () =>
  act(() => {
    useAppState.setState({
      // Waiting prompts are also flagged busy; the indicator must still say waiting.
      busyThreads: { [THREAD_ID]: true },
      piThreadRunStates: {
        [THREAD_ID]: { runId: 'run1', state: 'capacity_waiting' },
      },
    })
  })

const setApprovalPending = () =>
  act(() => {
    usePiApproval.setState({
      queues: { [THREAD_ID]: [{ requestId: 'r1', runId: 'run1' } as never] },
    })
  })

const setIdle = () => act(() => resetStores())

const slotState = (container: HTMLElement) =>
  container
    .querySelector('[data-thread-state]')
    ?.getAttribute('data-thread-state')

beforeEach(resetStores)

describe('deriveThreadRuntimeState — precedence', () => {
  it('ranks approval above every other overlapping signal', () => {
    expect(
      deriveThreadRuntimeState({
        approvalPending: true,
        failed: true,
        capacityWaiting: true,
        running: true,
      })
    ).toBe('approval')
  })

  it('ranks failed above waiting and running (not hidden by generic busy)', () => {
    expect(
      deriveThreadRuntimeState({
        approvalPending: false,
        failed: true,
        capacityWaiting: true,
        running: true,
      })
    ).toBe('failed')
  })

  it('ranks waiting above running because a waiter is also busy', () => {
    expect(
      deriveThreadRuntimeState({
        approvalPending: false,
        failed: false,
        capacityWaiting: true,
        running: true,
      })
    ).toBe('waiting')
  })

  it('falls back to running, then idle', () => {
    expect(
      deriveThreadRuntimeState({
        approvalPending: false,
        failed: false,
        capacityWaiting: false,
        running: true,
      })
    ).toBe('running')
    expect(
      deriveThreadRuntimeState({
        approvalPending: false,
        failed: false,
        capacityWaiting: false,
        running: false,
      })
    ).toBe('idle')
  })
})

describe('ThreadStateIndicator — reserved slot + accessibility', () => {
  it('renders a reserved-but-empty, non-announced slot when idle', () => {
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    const slot = container.querySelector('[data-thread-state="idle"]')
    expect(slot).not.toBeNull()
    // Non-interactive, non-announced, and no visible icon.
    expect(slot).toHaveAttribute('aria-hidden', 'true')
    expect(slot).not.toHaveAttribute('role')
    expect(slot?.querySelector('svg')).toBeNull()
    // Same fixed-size box as the visible states, so geometry is constant.
    expect(slot).toHaveClass('h-4', 'w-3', 'shrink-0')
  })

  it('names the visible icon via role="img" without a live region', () => {
    setRunning()
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    const slot = container.querySelector('[data-thread-state]')
    expect(slot).toHaveAttribute('role', 'img')
    // Not a polite/assertive live region — avoids per-row auto-announcements.
    expect(slot).not.toHaveAttribute('role', 'status')
    expect(slot).toHaveAttribute('aria-label', 'Working')
    expect(slot).toHaveAttribute('title', 'Working')
    expect(slot).toHaveClass('h-4', 'w-3', 'shrink-0')
  })
})

describe('ThreadStateIndicator — per-state rendering', () => {
  it('shows the scattered dot loader while running', () => {
    // Running is the one state with motion, and it uses the same dot loader as
    // the work log rather than a spinner — a spinner here reads as "stuck".
    setRunning()
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    expect(slotState(container)).toBe('running')
    expect(container.querySelector('[data-dots-loader="scatter"]')).not.toBeNull()
  })

  it('shows a still "Waiting for capacity" indicator', () => {
    setWaiting()
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    const slot = container.querySelector('[data-thread-state]')
    expect(slot).toHaveAttribute('data-thread-state', 'waiting')
    expect(slot).toHaveAttribute('aria-label', 'Waiting for capacity')
    expect(container.querySelector('[data-dots-loader]')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('shows an "Approval needed" indicator even while the run is busy', () => {
    setRunning()
    setApprovalPending()
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    const slot = container.querySelector('[data-thread-state]')
    expect(slot).toHaveAttribute('data-thread-state', 'approval')
    expect(slot).toHaveAttribute('aria-label', 'Approval needed')
  })

  it('shows a "Failed" indicator when the session status is error', () => {
    setSessionStatus('error')
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    const slot = container.querySelector('[data-thread-state]')
    expect(slot).toHaveAttribute('data-thread-state', 'failed')
    expect(slot).toHaveAttribute('aria-label', 'Failed')
  })

  it('does not treat a normal streaming session as failed', () => {
    setSessionStatus('streaming', true)
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    expect(slotState(container)).toBe('running')
  })
})

describe('ThreadStateIndicator — runtime transitions', () => {
  it('walks idle → running → waiting → approval → failed → idle as stores change', () => {
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    expect(slotState(container)).toBe('idle')

    setRunning()
    expect(slotState(container)).toBe('running')

    setWaiting()
    expect(slotState(container)).toBe('waiting')

    setApprovalPending()
    expect(slotState(container)).toBe('approval')

    // Approval clears, run errors out.
    act(() => usePiApproval.setState({ queues: {} }))
    setSessionStatus('error')
    act(() => useAppState.setState({ busyThreads: {}, piThreadRunStates: {} }))
    expect(slotState(container)).toBe('failed')

    setIdle()
    expect(slotState(container)).toBe('idle')
    // The reserved slot survives the return to idle — no null/removal.
    expect(container.querySelector('[data-thread-state="idle"]')).not.toBeNull()
  })

  it('removes the approval indicator when the terminal cleanup empties the queue', () => {
    setRunning()
    setApprovalPending()
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    expect(slotState(container)).toBe('approval')

    // Terminal/abort cleanup removes the thread's pending request.
    act(() => usePiApproval.setState({ queues: {} }))
    expect(slotState(container)).toBe('running')
    expect(
      container.querySelector('[data-thread-state="approval"]')
    ).toBeNull()
  })

  it('clears the failed indicator when a retry moves the status off error', () => {
    setSessionStatus('error')
    const { container } = render(<ThreadStateIndicator threadId={THREAD_ID} />)
    expect(slotState(container)).toBe('failed')

    // Retry: status advances to submitted, then streaming.
    setSessionStatus('submitted', true)
    expect(slotState(container)).toBe('running')

    setSessionStatus('ready', false)
    expect(slotState(container)).toBe('idle')
  })
})
