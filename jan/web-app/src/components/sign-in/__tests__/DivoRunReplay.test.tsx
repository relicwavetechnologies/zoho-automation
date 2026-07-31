import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DivoRunReplay, REPLAY_STEPS } from '../DivoRunReplay'

// The gate renders before any session exists, so the replay must not reach for
// a store, the gateway, or Tauri. Rendering it bare here is the assertion: if
// the real trace components ever grow such a dependency, this suite fails
// first — which is the tripwire for the coupling this component accepts.
describe('DivoRunReplay', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const BEAT_MS = 1150

  /**
   * Advance exactly one beat. One act() per beat rather than a single long
   * jump: the next timer is only scheduled once React has re-rendered and the
   * effect has re-run.
   */
  const beats = (count: number) => {
    for (let i = 0; i < count; i++) {
      act(() => void vi.advanceTimersByTime(BEAT_MS))
    }
  }

  it('pins the request before any work has run', () => {
    render(<DivoRunReplay />)
    expect(
      screen.getByText('Which invoices are overdue, and who do I chase?')
    ).toBeInTheDocument()
  })

  it('resolves the fixture through the real tool vocabulary', () => {
    render(<DivoRunReplay />)
    beats(REPLAY_STEPS.length)

    // The point of replaying through PiTraceTimeline is that the gateway parts
    // resolve to brand labels the same way the chat resolves them. If the
    // part shape drifts, these read as raw tool ids instead.
    expect(screen.getByText(/zoho books/i)).toBeInTheDocument()
    expect(screen.getByText(/google contacts/i)).toBeInTheDocument()
    expect(screen.getByText(/google gmail/i)).toBeInTheDocument()
  })

  it('loops back to an empty run instead of dead-ending', () => {
    render(<DivoRunReplay />)

    beats(REPLAY_STEPS.length)
    expect(screen.getByText(/google gmail/i)).toBeInTheDocument()

    act(() => void vi.advanceTimersByTime(3600))
    expect(screen.queryByText(/google gmail/i)).not.toBeInTheDocument()
  })
})
