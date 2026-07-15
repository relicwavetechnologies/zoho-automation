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

  it('loads and updates the persistent device-level Bash rule', async () => {
    render(<PermissionRulesPopover />)

    fireEvent.click(screen.getByRole('button', { name: 'Permission rules' }))

    expect(await screen.findByText('Bash commands')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('pi_get_permission_rules')

    const rule = screen.getByRole('switch', {
      name: 'Always allow Bash',
    })
    fireEvent.click(rule)

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        'pi_set_persistent_bash_approval',
        { allowed: true }
      )
      expect(rule).toBeChecked()
    })
    expect(screen.getByText('Always allow on this device')).toBeInTheDocument()
  })
})
