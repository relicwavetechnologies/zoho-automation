import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TextareaAutosize from 'react-textarea-autosize'

import { DivoComposerFrame } from '../DivoComposerFrame'

/**
 * The cutover risk is not whether Astryx renders — it is whether OUR textarea
 * survives inside Astryx's input slot with its behaviour intact. ChatInput's
 * slash menu, IME handling and Enter-to-send all live on that element, so
 * these assert the slot is a genuine passthrough and not a wrapper that
 * intercepts.
 */
describe('DivoComposerFrame', () => {
  const renderFrame = (props: Partial<Parameters<typeof DivoComposerFrame>[0]> = {}) =>
    render(
      <DivoComposerFrame
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        input={<TextareaAutosize data-testid="chat-input" />}
        {...props}
      />
    )

  it('renders our textarea rather than an Astryx input', () => {
    renderFrame()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('lets our textarea keep its own key handling', () => {
    const onKeyDown = vi.fn()
    renderFrame({
      input: <TextareaAutosize data-testid="chat-input" onKeyDown={onKeyDown} />,
    })

    // Enter-to-send belongs to ChatInput. If Astryx swallowed keys here, the
    // slash menu and IME guards would silently stop working.
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' })
    expect(onKeyDown).toHaveBeenCalled()
  })

  it('renders every Divo slot it is given', () => {
    renderFrame({
      drawer: <span>drawer-slot</span>,
      headerActions: <span>header-actions-slot</span>,
      headerContext: <span>header-context-slot</span>,
      footerActions: <span>footer-actions-slot</span>,
      sendActions: <span>send-actions-slot</span>,
      sendButton: <button type="button">send-slot</button>,
    })

    for (const slot of [
      'drawer-slot',
      'header-actions-slot',
      'header-context-slot',
      'footer-actions-slot',
      'send-actions-slot',
      'send-slot',
    ]) {
      expect(screen.getByText(slot)).toBeInTheDocument()
    }
  })

  it('surfaces an error status without swallowing it', () => {
    renderFrame({ status: { type: 'error', message: 'Skill lookup failed' } })
    expect(screen.getByText('Skill lookup failed')).toBeInTheDocument()
  })
})
