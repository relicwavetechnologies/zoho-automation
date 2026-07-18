import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TeachExperiencePreview } from './TeachExperiencePreview'

describe('TeachExperiencePreview', () => {
  it('shows a truthful step-by-step mock processing timeline', () => {
    render(<TeachExperiencePreview onExit={vi.fn()} />)

    expect(screen.getByText('Learning from your demonstration')).toBeInTheDocument()
    expect(screen.getAllByText('Recording received')).toHaveLength(2)
    expect(screen.getByText('DeepSeek is reviewing the teaching')).toBeInTheDocument()
    expect(screen.getByText(/no persona change is presented as successful/i)).toBeInTheDocument()
    expect(screen.getByText(/UI preview · no model calls/i)).toBeInTheDocument()
  })

  it('shows the exact mock persona change, correction bar and Undo control', async () => {
    const user = userEvent.setup()
    render(<TeachExperiencePreview onExit={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /View learned result/i }))

    expect(screen.getByText('Review what Divo learned')).toBeInTheDocument()
    expect(screen.getByText('One workflow rule learned')).toBeInTheDocument()
    expect(screen.getByText(/exactly what was written/i)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Refine what Divo learned' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo (1 left)' })).toBeInTheDocument()
  })

  it('accepts a mock follow-up correction in the retained context', async () => {
    const user = userEvent.setup()
    render(<TeachExperiencePreview onExit={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /View learned result/i }))

    await user.type(
      screen.getByRole('textbox', { name: 'Refine what Divo learned' }),
      'Only forward unread Cursor emails.'
    )
    await user.click(screen.getByRole('button', { name: 'Send correction' }))

    expect(screen.getByText(/DeepSeek is revisiting the rule/i)).toBeInTheDocument()
  })
})
