import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { AutomateMode } from './AutomateMode'

describe('AutomateMode', () => {
  it('walks through the complete mock workflow-learning experience', async () => {
    const user = userEvent.setup()
    render(<AutomateMode />)

    await user.click(screen.getByRole('button', { name: 'Record workflow' }))
    expect(screen.getByText('Choose what Divo can observe')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Allow 3 sources & start' }))
    expect(screen.getByText('Learning your workflow')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Mark important step' }))
    expect(screen.getByText('2 marked')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Finish recording' }))
    expect(screen.getByText('Divo is understanding your workflow')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'View mock result now' }))
    expect(screen.getByText("Review Divo's understanding")).toBeInTheDocument()
    expect(screen.getByText('Follow up with overdue sales leads')).toBeInTheDocument()
    expect(screen.getByText('Google Sheets')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Needs changes' }))
    expect(screen.getByLabelText('What did Divo misunderstand?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Yes, this is correct' }))
    expect(screen.getByText('Your automation draft is ready to test.')).toBeInTheDocument()
    expect(screen.getByText('Mock preview — no workflow, trigger or skill has been created.')).toBeInTheDocument()
  })
})
