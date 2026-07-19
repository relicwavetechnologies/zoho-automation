import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DivoShowcase } from '../DivoShowcase'

// The gate renders before any session exists, so the showcase must not reach
// for a store, the gateway, or Tauri. Rendering it bare here is the assertion:
// if it ever grows such a dependency, this suite fails first.
describe('DivoShowcase', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const tabs = () => screen.getAllByRole('tab')

  it('renders every capability as a chapter and starts on the first', () => {
    render(<DivoShowcase />)
    expect(tabs()).toHaveLength(5)
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Just ask')).toBeInTheDocument()
  })

  it('advances on its own and wraps back to the start', () => {
    render(<DivoShowcase />)

    act(() => void vi.advanceTimersByTime(5200))
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')

    // Four more ticks returns to scene one — a loop, not a dead end.
    act(() => void vi.advanceTimersByTime(5200 * 4))
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('lets a chapter marker jump straight to its scene', () => {
    render(<DivoShowcase />)

    // fireEvent, not userEvent: userEvent's own scheduler deadlocks against
    // the fake timers this suite needs for the auto-advance.
    act(() => void fireEvent.click(tabs()[3]!))
    expect(tabs()[3]).toHaveAttribute('aria-selected', 'true')
  })

  it('clears its timer on unmount', () => {
    const clear = vi.spyOn(window, 'clearInterval')
    const { unmount } = render(<DivoShowcase />)
    unmount()
    expect(clear).toHaveBeenCalled()
  })
})
