import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandGroup } from './CommandGroup'

describe('CommandGroup', () => {
  const renderTool = vi.fn((part: Record<string, unknown>, partIndex: number) => (
    <div data-testid={`tool-card-${partIndex}`}>{String(part.toolCallId)}</div>
  ))

  it('shows one Running row per in-flight tool while active', () => {
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

    expect(screen.getByText('Running skills.search')).toBeInTheDocument()
    expect(screen.getByText('Running connections.list')).toBeInTheDocument()
    expect(screen.queryByText(/Ran \d+ commands/)).not.toBeInTheDocument()
    expect(renderTool).not.toHaveBeenCalled()
  })

  it('flips finished tools to Ran while later ones still run', () => {
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

    expect(screen.getByText('Ran skills.search')).toBeInTheDocument()
    expect(screen.getByText('Running zoho books')).toBeInTheDocument()
  })

  it('shows Ran rows when settled and expands into the tool card', async () => {
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

    expect(screen.getByText('Ran skills.list')).toBeInTheDocument()
    expect(screen.getByText('Ran connections.list')).toBeInTheDocument()
    expect(screen.queryByTestId('tool-card-2')).not.toBeInTheDocument()

    await user.click(screen.getByText('Ran skills.list'))
    expect(screen.getByTestId('tool-card-2')).toHaveTextContent('tc-2')
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
    expect(screen.queryByText(/^Running /)).not.toBeInTheDocument()
  })
})
