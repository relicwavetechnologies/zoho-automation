import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { TeachClarificationCard } from './TeachClarificationCard'
import type { PiTeachClarificationRequest } from '@/lib/pi/teach-clarification'

const request: PiTeachClarificationRequest = {
  protocol: 'teach-clarification',
  requestId: 'request-1',
  threadId: 'thread-1',
  runId: 'run-1',
  status: 'pending',
  descriptor: {
    version: 1,
    reason: 'The trigger and action boundary are unclear.',
    questions: [
      {
        id: 'trigger',
        question: 'When should Divo run this?',
        selection: 'single',
        options: [
          { id: 'new-email', label: 'When a new email arrives' },
          { id: 'manual', label: 'Only when I ask' },
        ],
        allowCustom: true,
      },
    ],
    runCorrelation: {
      version: 1,
      threadId: 'thread-1',
      runId: 'run-1',
      profile: 'teach',
    },
  },
}

describe('TeachClarificationCard', () => {
  it('requires an answer and submits structured choices', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <TeachClarificationCard
        request={request}
        position={0}
        total={1}
        onMove={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    const submit = screen.getByRole('button', { name: 'Continue teaching' })
    expect(submit).toBeDisabled()
    await user.click(
      screen.getByRole('button', { name: 'When a new email arrives' })
    )
    expect(submit).toBeEnabled()
    await user.click(submit)
    expect(onSubmit).toHaveBeenCalledWith({
      version: 1,
      decision: 'answer',
      answers: [
        { questionId: 'trigger', selectedOptionIds: ['new-email'] },
      ],
    })
  })

  it('keeps the custom answer collapsed until it is asked for', async () => {
    const user = userEvent.setup()
    render(
      <TeachClarificationCard
        request={request}
        position={0}
        total={1}
        onMove={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    const label = 'Custom answer for When should Divo run this?'
    expect(screen.queryByLabelText(label)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Something else' }))
    expect(screen.getByLabelText(label)).toBeInTheDocument()
  })

  it('scrolls the next unanswered question into view after a single choice', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    // jsdom does not implement scrollIntoView.
    Element.prototype.scrollIntoView = scrollIntoView

    const twoQuestions: PiTeachClarificationRequest = {
      ...request,
      descriptor: {
        ...request.descriptor,
        questions: [
          request.descriptor.questions[0],
          {
            id: 'scope',
            question: 'How far should Divo go?',
            selection: 'single',
            options: [
              { id: 'draft', label: 'Draft only' },
              { id: 'send', label: 'Send it' },
            ],
            allowCustom: false,
          },
        ],
      },
    }

    render(
      <TeachClarificationCard
        request={twoQuestions}
        position={0}
        total={1}
        onMove={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /When a new email arrives/ })
    )
    expect(scrollIntoView).toHaveBeenCalled()
  })
})
