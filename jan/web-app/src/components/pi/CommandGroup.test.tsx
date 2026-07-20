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

  it('renders a lone running call as its own row, with no loader header', () => {
    // A burst of one is not a burst: the "Running 1 command" header said less
    // than the row beneath it and buried the tool's own mark under a generic
    // loader. A running Gmail call should just look like Gmail, shimmering.
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

    expect(container.querySelectorAll('[data-dots-loader]')).toHaveLength(0)
    expect(screen.queryByText(/^Using /)).not.toBeInTheDocument()
    const row = screen.getByText('google gmail').closest('div')
    expect(row?.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('google gmail')).toHaveClass('text-shimmer')
  })

  describe('folded burst icon stack', () => {
    const settled = (toolId: string, partIndex: number) => ({
      partIndex,
      part: {
        type: 'tool-divo_gateway',
        state: 'output-available',
        toolCallId: `tc-${partIndex}`,
        input: { op: 'tools.invoke', payload: { toolId } },
      },
    })

    const stack = (container: HTMLElement) =>
      container.querySelector('[data-testid="tool-icon-stack"]')

    it('shows one mark per distinct tool, however many times it was called', () => {
      // Three Gmail calls are still one Gmail mark — presence is the signal,
      // not volume.
      const { container } = render(
        <CommandGroup
          messageId="m1"
          active={false}
          awaitingApproval={false}
          renderTool={renderTool}
          tools={[
            settled('googleGmail', 0),
            settled('googleGmail', 1),
            settled('googleGmail', 2),
          ]}
        />
      )
      expect(stack(container)?.querySelectorAll('svg')).toHaveLength(1)
    })

    it('shows a mark for each different tool', () => {
      const { container } = render(
        <CommandGroup
          messageId="m1"
          active={false}
          awaitingApproval={false}
          renderTool={renderTool}
          tools={[
            settled('googleGmail', 0),
            settled('googleGmail', 1),
            settled('larkDocs', 2),
          ]}
        />
      )
      expect(stack(container)?.querySelectorAll('svg')).toHaveLength(2)
    })

    it('caps the row and counts the remainder', () => {
      const { container } = render(
        <CommandGroup
          messageId="m1"
          active={false}
          awaitingApproval={false}
          renderTool={renderTool}
          tools={[
            settled('googleGmail', 0),
            settled('larkDocs', 1),
            settled('zohoBooks', 2),
            settled('canvaDesign', 3),
            settled('googleDrive', 4),
            settled('googleCalendar', 5),
          ]}
        />
      )
      expect(stack(container)?.querySelectorAll('svg')).toHaveLength(4)
      expect(screen.getByText('+2')).toBeInTheDocument()
    })

    it('keeps the stack leading the row once the burst is expanded', async () => {
      // The stack is the row's left anchor, not decoration — dropping it on
      // open would shunt the label sideways as the burst folds.
      const user = userEvent.setup()
      const { container } = render(
        <CommandGroup
          messageId="m1"
          active={false}
          awaitingApproval={false}
          renderTool={renderTool}
          tools={[settled('googleGmail', 0), settled('larkDocs', 1)]}
        />
      )
      expect(stack(container)).not.toBeNull()
      await user.click(screen.getByRole('button', { expanded: false }))
      expect(stack(container)).not.toBeNull()
    })

    it('gives a lone call its own mark instead of a one-item stack', () => {
      // No summary line at all, so no stack — the row's own ToolIcon leads.
      const { container } = render(
        <CommandGroup
          messageId="m1"
          active={false}
          awaitingApproval={false}
          renderTool={renderTool}
          tools={[settled('googleGmail', 0)]}
        />
      )
      expect(stack(container)).toBeNull()
      expect(screen.getByText('google gmail')).toBeInTheDocument()
    })
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
          {
            partIndex: 1,
            part: {
              type: 'tool-bash',
              state: 'output-available',
              input: { op: 'connections.list' },
            },
          },
        ]}
      />
    )

    expect(screen.getByText('Explored 2 searches')).toBeInTheDocument()
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
    expect(screen.getByText('skill search')).not.toHaveClass('text-shimmer')
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

  it('keeps a backend approval status visible instead of folding it into the burst', () => {
    render(
      <CommandGroup
        messageId="m1"
        active={false}
        awaitingApproval={false}
        renderTool={renderTool}
        tools={[
          {
            partIndex: 4,
            part: {
              type: 'tool-divo_gateway',
              state: 'output-error',
              toolCallId: 'tc-approval',
              errorText: JSON.stringify({
                details: {
                  status: 'approval_required',
                  approval: { approvalId: 'approval-1', message: 'Waiting for Finance.' },
                },
              }),
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('tool-card-4')).toHaveTextContent('tc-approval')
    expect(screen.queryByText(/^Explored /)).not.toBeInTheDocument()
  })
})
