import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  setRoleAction: vi.fn(),
  onUpdated: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/divo-tools', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/divo-tools')>(),
  getDivoToolManageSnapshot: h.getSnapshot,
  setDivoDepartmentRoleToolAction: h.setRoleAction,
}))

import { DepartmentAccessMatrix } from '../DepartmentAccessMatrix'
import type { DepartmentManagementRole, DepartmentToolManageSnapshot, DivoToolInventoryItem } from '@/lib/divo-tools'

const department = { id: 'operations', name: 'Operations' }
const role: DepartmentManagementRole = { id: 'role-ops', name: 'Operator', slug: 'OPERATOR', isSystem: false, isDefault: true, zohoReadScope: 'personalised' }
const item: DivoToolInventoryItem = {
  tool: { toolId: 'googleDrive', name: 'Google Drive', description: 'Company files', category: 'files', domain: 'google', hitlRequired: false },
  origins: [{ kind: 'department', department, allowedActions: ['read'] }],
  managementScopes: [{ kind: 'department', department }],
  readiness: 'ready',
}
const snapshot: DepartmentToolManageSnapshot = {
  tool: item.tool,
  scope: { kind: 'department', department },
  supportedActions: ['read'],
  roles: [{ id: role.id, name: role.name, slug: role.slug }],
  members: [],
  roleActions: [],
  memberOverrides: [],
  memberActionStates: [],
  roleActionStates: [{ roleId: role.id, actionGroup: 'read', configuredAllowed: true, configuredProvenance: 'department_role', companyPolicyStatus: 'company_policy_allows_some_current_members' }],
  companyCeiling: [],
}

describe('DepartmentAccessMatrix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.getSnapshot.mockResolvedValue(snapshot)
    h.setRoleAction.mockResolvedValue({
      ...snapshot,
      roleActionStates: [{ ...snapshot.roleActionStates[0], configuredAllowed: false }],
    })
  })

  it('loads exact department policy and persists a role capability change', async () => {
    render(<DepartmentAccessMatrix department={department} items={[item]} query="" roles={[role]} onUpdated={h.onUpdated} />)

    const toggle = await screen.findByRole('switch', { name: 'Operator Google Drive read' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    await waitFor(() => expect(h.setRoleAction).toHaveBeenCalledWith('googleDrive', 'operations', 'role-ops', 'read', false))
    expect(h.onUpdated).toHaveBeenCalledTimes(1)
  })

  it('does not request tools outside the managed department scope', async () => {
    render(<DepartmentAccessMatrix department={department} items={[{ ...item, managementScopes: [{ kind: 'department', department: { id: 'finance', name: 'Finance' } }] }]} query="" roles={[role]} onUpdated={h.onUpdated} />)

    expect(await screen.findByText('No department-managed tools')).toBeInTheDocument()
    expect(h.getSnapshot).not.toHaveBeenCalled()
  })

  it('filters the matrix by tool capability search', async () => {
    render(<DepartmentAccessMatrix department={department} items={[item]} query="send" roles={[role]} onUpdated={h.onUpdated} />)

    expect(await screen.findByText('No tool capabilities match this search.')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Operator Google Drive read' })).not.toBeInTheDocument()
  })
})
