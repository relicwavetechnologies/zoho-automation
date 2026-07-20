import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TodoBubble } from './TodoBubble'

function todoMessage() {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: [{
      type: 'tool_call',
      tool_name: 'divo_todos',
      tool_call_id: 'todos-1',
      input: {},
      output: {
        details: {
          version: 1,
          boardId: 'board-1',
          revision: 2,
          items: [
            { id: 'done', content: 'Research current options', status: 'completed' },
            {
              id: 'active',
              content: 'Compare TTS vendors',
              activeForm: 'Comparing TTS vendors',
              description: 'Compare quality, latency, and pricing.',
              status: 'in_progress',
            },
            { id: 'next', content: 'Write recommendation', status: 'pending' },
          ],
        },
      },
    }],
  }
}

describe('TodoBubble', () => {
  it('shows only the active task then opens the ordered task context', () => {
    render(<TodoBubble threadId="thread-a" messages={[todoMessage()] as any} />)

    const trigger = screen.getByTestId('todo-bubble-trigger')
    expect(trigger).toHaveTextContent('Comparing TTS vendors')
    expect(trigger).not.toHaveTextContent('Research current options')

    fireEvent.click(trigger)
    expect(screen.getByText('Previous')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Up next')).toBeInTheDocument()
    expect(screen.getByText('Research current options')).toBeInTheDocument()
    expect(screen.getByText('Write recommendation')).toBeInTheDocument()
  })

  it('does not render a bubble without a current task', () => {
    const complete = todoMessage()
    ;(complete.content[0] as any).output.details.items[1].status = 'completed'
    ;(complete.content[0] as any).output.details.items[2].status = 'completed'
    render(<TodoBubble threadId="thread-a" messages={[complete] as any} />)
    expect(screen.queryByTestId('todo-bubble-trigger')).not.toBeInTheDocument()
  })
})
