import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))

import {
  getDivoToolManageSnapshot,
  setDivoDepartmentMemberToolAction,
  toolActionSummary,
  toolSearchText,
  type DivoToolInventoryItem,
} from '../divo-tools'

const inventoryItem: DivoToolInventoryItem = {
  tool: {
    toolId: 'googleDrive', name: 'Google Drive', description: 'Read and organise company files.',
    category: 'productivity', domain: 'google', hitlRequired: false,
  },
  origins: [
    { kind: 'global', allowedActions: ['read'] },
    { kind: 'department', department: { id: 'ops-id', name: 'Operations' }, allowedActions: ['create', 'read'] },
  ],
  managementScopes: [{ kind: 'department', department: { id: 'ops-id', name: 'Operations' } }],
  readiness: 'ready',
}

describe('Divo desktop tools client', () => {
  it('searches only server-returned tool metadata and access labels', () => {
    expect(toolSearchText(inventoryItem)).toContain('operations')
    expect(toolSearchText(inventoryItem)).toContain('manage operations')
    expect(toolSearchText(inventoryItem)).toContain('google drive')
    expect(toolActionSummary(inventoryItem)).toBe('read, create')
  })

  it('describes a management-only configurable row without calling it fixed policy', () => {
    const managementOnly: DivoToolInventoryItem = {
      ...inventoryItem,
      origins: [],
      managementScopes: [{ kind: 'global', label: 'Global' }],
    }
    expect(toolActionSummary(managementOnly)).toBe('Management access only')
  })

  it('passes the selected department scope through to the Tauri proxy', () => {
    getDivoToolManageSnapshot(inventoryItem.tool.toolId, inventoryItem.managementScopes[0]!)
    expect(h.invoke).toHaveBeenCalledWith('divo_tool_manage_snapshot', {
      toolId: 'googleDrive', scope: 'department', departmentId: 'ops-id',
    })
  })

  it('sends exact action mutation inputs without deriving permissions', () => {
    setDivoDepartmentMemberToolAction('googleDrive', 'ops-id', 'member-id', 'create', true)
    expect(h.invoke).toHaveBeenCalledWith('divo_tool_set_department_member_action', {
      toolId: 'googleDrive', departmentId: 'ops-id', userId: 'member-id', actionGroup: 'create', allowed: true,
    })
  })
})
