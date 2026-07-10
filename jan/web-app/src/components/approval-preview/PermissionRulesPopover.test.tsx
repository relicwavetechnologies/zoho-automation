import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

import { PermissionRulesPopover } from './PermissionRulesPopover'

describe('PermissionRulesPopover', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'pi_get_permission_rules') {
        return Promise.resolve({ bashAlwaysAllow: false })
      }
      return Promise.resolve(undefined)
    })
  })

  it('loads and updates the real task-scoped Bash rule', async () => {
    render(<PermissionRulesPopover threadId="thread-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Permission rules' }))

    expect(await screen.findByText('Bash commands')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('pi_get_permission_rules', {
      threadId: 'thread-1',
    })

    const rule = screen.getByRole('switch', {
      name: 'Always allow Bash for this task',
    })
    fireEvent.click(rule)

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_set_bash_approval_rule',
        { threadId: 'thread-1', allowed: true }
      )
      expect(rule).toBeChecked()
    })
    expect(screen.getByText('Always allow for this task')).toBeInTheDocument()
  })

  it('disables rule changes when there is no task', async () => {
    render(<PermissionRulesPopover threadId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Permission rules' }))

    expect(
      await screen.findByText('Start or open a task to configure its rules.')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('switch', {
        name: 'Always allow Bash for this task',
      })
    ).toBeDisabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
