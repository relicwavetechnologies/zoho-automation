import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandGroup } from './CommandGroup'

/**
 * A burst has two shapes: expanded with a live header while anything in it is
 * still running, and a single foldable summary line once everything has landed.
 * The verb lives on the header — individual rows carry only the tool's name, so
 * a burst of six doesn't repeat "Ran" six times.
 */
describe('CommandGroup', () => {
  const renderTool = vi.fn((part: Record<string, unknown>, partIndex: number) => (
    <div data-testid={`tool-card-${partIndex}`}>{String(part.toolCallId)}</div>
  ))

  it('shows a live header over one row per in-flight tool while active', () => {
    render(
      <CommandGroup
        messageId="m1"
        active
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 0,
            part: {
              type: 'tool-divo_gateway',
              state: 'input-available',
              input: { op: 'skills.search' },
            },
          },
          {
            partIndex: 1,
            part: {
              type: 'tool-divo_gateway',
              state: 'input-streaming',
              input: '{"op":"connections.list"',
            },
          },
        ]}
      />
    )

    expect(screen.getByText('Exploring 2 searches')).toBeInTheDocument()
    expect(screen.getByText('skill search')).toBeInTheDocument()
    expect(screen.getByText('connection list')).toBeInTheDocument()
    expect(renderTool).not.toHaveBeenCalled()
  })

  it('keeps the burst expanded while any tool is still running', () => {
    render(
      <CommandGroup
        messageId="m1"
        active
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 0,
            part: {
              type: 'tool-divo_gateway',
              state: 'output-available',
              input: { op: 'skills.search' },
            },
          },
          {
            partIndex: 1,
            part: {
              type: 'tool-divo_gateway',
              state: 'input-available',
              input: { op: 'tools.invoke', payload: { toolId: 'zohoBooks' } },
            },
          },
        ]}
      />
    )

    // Present tense, and the counts include calls that have already landed.
    expect(screen.getByText('Exploring 1 search, ran 1 command')).toBeInTheDocument()
    // The settled row drops its shimmer; the in-flight one keeps it.
    expect(screen.getByText('skill search')).not.toHaveClass('text-shimmer')
    expect(screen.getByText('zoho books')).toHaveClass('text-shimmer')
  })

  it('folds a settled burst to one line that expands back to the rows', async () => {
    const user = userEvent.setup()
    render(
      <CommandGroup
        messageId="m1"
        active={false}
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 2,
            part: {
              type: 'tool-divo_gateway',
              state: 'output-available',
              toolCallId: 'tc-2',
              input: { op: 'skills.list' },
            },
          },
          {
            partIndex: 3,
            part: {
              type: 'tool-divo_gateway',
              state: 'output-available',
              toolCallId: 'tc-3',
              input: { op: 'connections.list' },
            },
          },
        ]}
      />
    )

    const summary = screen.getByText('Explored 2 searches')
    expect(summary).toBeInTheDocument()
    expect(screen.queryByText('skill list')).not.toBeInTheDocument()

    await user.click(summary)
    expect(screen.getByText('skill list')).toBeInTheDocument()

    // Rows stay individually expandable to their full tool card.
    await user.click(screen.getByText('skill list'))
    expect(screen.getByTestId('tool-card-2')).toHaveTextContent('tc-2')
  })

  it('keeps the tool own icon on a running row, not a generic loader', () => {
    // A running Gmail call should look like Gmail. The shimmer carries "in
    // flight"; the dot loader is only for rows with no identity of their own,
    // which here is the burst header alone.
    const { container } = render(
      <CommandGroup
        messageId="m1"
        active
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 0,
            part: {
              type: 'tool-divo_gateway',
              state: 'input-available',
              input: { op: 'tools.invoke', payload: { toolId: 'googleGmail' } },
            },
          },
        ]}
      />
    )

    expect(container.querySelectorAll('[data-dots-loader]')).toHaveLength(1)
    const row = screen.getByText('google gmail').closest('div')
    expect(row?.querySelector('svg')).not.toBeNull()
    expect(row?.querySelector('[data-dots-loader]')).toBeNull()
  })

  it('folds mid-turn once every tool in the burst has landed', () => {
    // `active` alone is not enough to keep the burst open — the segment can
    // still be the live one while its tools have all settled and the model has
    // moved on to talking.
    render(
      <CommandGroup
        messageId="m1"
        active
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 0,
            part: {
              type: 'tool-bash',
              state: 'output-available',
              input: { op: 'skills.search' },
            },
          },
        ]}
      />
    )

    expect(screen.getByText('Explored 1 search')).toBeInTheDocument()
    expect(screen.queryByText('skill search')).not.toBeInTheDocument()
  })

  it('shimmers a running row and drops the class once it settles', () => {
    // The shimmer paints the text via a gradient, so leaving the class on a
    // finished row would keep animating it — it has to come off, not pause.
    const { rerender } = render(
      <CommandGroup
        messageId="m1"
        active
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 0,
            part: {
              type: 'tool-bash',
              state: 'input-available',
              input: { op: 'skills.search' },
            },
          },
        ]}
      />
    )
    expect(screen.getByText('skill search')).toHaveClass('text-shimmer')

    rerender(
      <CommandGroup
        messageId="m1"
        active
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 0,
            part: {
              type: 'tool-bash',
              state: 'output-available',
              input: { op: 'skills.search' },
            },
          },
        ]}
      />
    )
    expect(screen.getByText('Explored 1 search')).not.toHaveClass('text-shimmer')
  })

  it('renders real tool cards while awaiting approval', () => {
    render(
      <CommandGroup
        messageId="m1"
        active
        awaitingApproval
        renderTool={renderTool}
        tools={[
          {
            partIndex: 0,
            part: {
              type: 'tool-bash',
              state: 'input-available',
              toolCallId: 'tc-bash',
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('tool-card-0')).toHaveTextContent('tc-bash')
    expect(screen.queryByText(/^Exploring /)).not.toBeInTheDocument()
  })
})
