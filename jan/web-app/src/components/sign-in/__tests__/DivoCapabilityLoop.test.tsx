import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DivoCapabilityLoop } from '../DivoCapabilityLoop'

// The gate renders before any session exists, so the loop must not reach for a
// store, the gateway, or Tauri. Rendering it bare here is the assertion: if it
// ever grows such a dependency, this suite fails first.
describe('DivoCapabilityLoop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const BEAT_MS = 1150
  const RUN_LENGTH = 6

  /**
   * Advance exactly one beat.
   *
   * Deliberately one act() per beat rather than one long jump: the next timer
   * is only scheduled once React has re-rendered and the effect has re-run, so
   * a single advanceTimersByTime moves the run forward by one step no matter
   * how far it is wound.
   */
  const beats = (count: number) => {
    for (let i = 0; i < count; i++) {
      act(() => void vi.advanceTimersByTime(BEAT_MS))
    }
  }

  it('opens on the request alone, then accumulates the run', () => {
    render(<DivoCapabilityLoop />)

    beats(1)
    expect(
      screen.getByText('Which invoices are overdue, and who do I chase?')
    ).toBeInTheDocument()
    expect(screen.queryByText('Zoho Books')).not.toBeInTheDocument()

    // Earlier beats must stay on screen as later ones arrive — accumulating is
    // what makes this read as one task rather than a carousel.
    beats(2)
    expect(screen.getByText('Zoho Books')).toBeInTheDocument()
    expect(
      screen.getByText('Which invoices are overdue, and who do I chase?')
    ).toBeInTheDocument()
  })

  it('chains tools across vendors and finishes with a result', () => {
    render(<DivoCapabilityLoop />)

    beats(RUN_LENGTH)

    // Three different vendors in one run is the actual claim being made.
    expect(screen.getByText('Zoho Books')).toBeInTheDocument()
    expect(screen.getByText('Google Contacts')).toBeInTheDocument()
    expect(screen.getByText('Gmail')).toBeInTheDocument()
    expect(
      screen.getByText('3 overdue · ₹4.2L · drafts ready to send')
    ).toBeInTheDocument()
  })

  it('loops back to an empty run instead of dead-ending', () => {
    render(<DivoCapabilityLoop />)

    beats(RUN_LENGTH)
    expect(screen.getByText('Gmail')).toBeInTheDocument()

    // The hold, then the reset.
    act(() => void vi.advanceTimersByTime(3400))
    expect(screen.queryByText('Gmail')).not.toBeInTheDocument()
  })

  it('always shows the full integration set, used or not', () => {
    const { container } = render(<DivoCapabilityLoop />)

    // The unused marks carry the message ("everything else is already here"),
    // so they must render from the first frame rather than appearing as the
    // run touches them.
    expect(container.querySelectorAll('li')).toHaveLength(15)
  })
})
