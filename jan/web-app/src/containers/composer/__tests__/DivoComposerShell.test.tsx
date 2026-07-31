import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DivoComposerShell } from '../DivoComposerShell'

// MovingBorder pulls in an animation frame loop that has nothing to prove
// here; stub it to a marker so "is the streaming trace mounted" is a simple
// query rather than a timing test.
vi.mock('@/containers/MovingBorder', () => ({
  MovingBorder: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="moving-border">{children}</div>
  ),
}))

const baseProps = {
  isComposerBusy: false,
  isFocused: false,
  isDragOver: false,
  dropAcceptsAnything: true,
  onDragEnter: () => {},
  onDragLeave: () => {},
  onDragOver: () => {},
  onDrop: () => {},
}

describe('DivoComposerShell', () => {
  it('renders the body verbatim in both variants', () => {
    for (const variant of ['landing', 'thread'] as const) {
      const { unmount } = render(
        <DivoComposerShell {...baseProps} variant={variant}>
          <textarea data-testid="body" />
        </DivoComposerShell>
      )
      expect(screen.getByTestId('body')).toBeInTheDocument()
      // The variant is exposed on the shell so the two looks are
      // distinguishable — and so the drop zone can be found below.
      expect(
        document.querySelector(`[data-composer-variant="${variant}"]`)
      ).not.toBeNull()
      unmount()
    }
  })

  it('traces the frame only while streaming', () => {
    const { rerender } = render(
      <DivoComposerShell {...baseProps} variant="landing">
        <span>body</span>
      </DivoComposerShell>
    )
    expect(screen.queryByTestId('moving-border')).not.toBeInTheDocument()

    rerender(
      <DivoComposerShell {...baseProps} variant="landing" isComposerBusy>
        <span>body</span>
      </DivoComposerShell>
    )
    expect(screen.getByTestId('moving-border')).toBeInTheDocument()
  })

  it('binds drag handlers when it accepts drops', () => {
    const onDrop = vi.fn()
    render(
      <DivoComposerShell {...baseProps} variant="thread" onDrop={onDrop}>
        <span>body</span>
      </DivoComposerShell>
    )
    fireEvent.drop(document.querySelector('[data-composer-variant="thread"]')!)
    expect(onDrop).toHaveBeenCalled()
  })

  it('is not a drop target when it does not accept drops', () => {
    const onDrop = vi.fn()
    render(
      <DivoComposerShell
        {...baseProps}
        variant="thread"
        dropAcceptsAnything={false}
        onDrop={onDrop}
      >
        <span>body</span>
      </DivoComposerShell>
    )
    const shell = document.querySelector('[data-composer-variant="thread"]')!
    // No drop-zone marker, and the handler is not wired — a drop does nothing.
    expect(shell.getAttribute('data-drop-zone')).toBeNull()
    fireEvent.drop(shell)
    expect(onDrop).not.toHaveBeenCalled()
  })
})
