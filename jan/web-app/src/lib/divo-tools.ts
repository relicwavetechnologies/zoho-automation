import { invoke } from '@tauri-apps/api/core'

export type DivoTool = {
  toolId: string
  name: string
  description: string
  category: string
  domain: string
  hitlRequired: boolean
}

export type ToolOrigin =
  | { kind: 'global'; allowedActions: string[] }
  | { kind: 'department'; department: { id: string; name: string }; allowedActions: string[] }
  | { kind: 'local'; reason: string }
  | { kind: 'system'; allowedActions: string[]; reason: string }

export type ToolManagementScope =
  | { kind: 'global'; label: 'Global' }
  | { kind: 'department'; department: { id: string; name: string } }

export type DivoToolInventoryItem = {
  tool: DivoTool
  origins: ToolOrigin[]
  managementScopes: ToolManagementScope[]
  readiness: 'ready' | 'connection_required' | 'admin_connection_required' | 'not_applicable'
}

export type DivoToolInventory = { tools: DivoToolInventoryItem[] }

export type ToolAction = {
  actionGroup: string
  effectiveAllowed: boolean
  storedAllowed: boolean
  storedProvenance: 'default' | 'override'
  clampReason: 'company_tool_disabled' | null
}
export type ToolRoleSnapshot = { role: string; actions: ToolAction[] }
export type DepartmentRole = { id: string; name: string; slug: string }
export type DepartmentMember = { userId: string; name: string | null; email: string | null; roleId: string }
export type DepartmentAction = { roleId?: string; userId?: string; actionGroup: string; allowed: boolean }
export type DepartmentMemberActionState = {
  userId: string
  actionGroup: string
  configuredAllowed: boolean
  configuredProvenance: 'member_override' | 'department_role' | 'default'
  effectiveAllowed: boolean
  effectiveBlockReason: 'company_tool_disabled' | 'company_action_disabled' | null
  storedOverride: boolean | null
  provenance: 'inherited' | 'override'
}
export type DepartmentRoleActionState = {
  roleId: string
  actionGroup: string
  configuredAllowed: boolean
  configuredProvenance: 'department_role' | 'default'
  companyPolicyStatus:
    | 'no_active_members'
    | 'company_tool_blocks_all_current_members'
    | 'company_action_blocks_all_current_members'
    | 'company_policy_allows_some_current_members'
}

export type GlobalToolManageSnapshot = {
  tool: DivoTool
  scope: { kind: 'global'; label: 'Global' }
  supportedActions: string[]
  /** Backend-phrased action names — "Send email", "Delete records". */
  actionLabels: Record<string, string>
  roles: ToolRoleSnapshot[]
}

export type DepartmentToolManageSnapshot = {
  tool: DivoTool
  scope: { kind: 'department'; department: { id: string; name: string } }
  supportedActions: string[]
  actionLabels: Record<string, string>
  roles: DepartmentRole[]
  members: DepartmentMember[]
  roleActions: DepartmentAction[]
  memberOverrides: DepartmentAction[]
  memberActionStates: DepartmentMemberActionState[]
  roleActionStates: DepartmentRoleActionState[]
  companyCeiling: Array<{ role: string; actions: string[] }>
}

export type ToolManageSnapshot = GlobalToolManageSnapshot | DepartmentToolManageSnapshot

export type DepartmentManagementRole = {
  id: string
  name: string
  slug: string
  isSystem: boolean
  isDefault: boolean
  zohoReadScope: string
}

export type DepartmentManagementMember = {
  id: string
  userId: string
  name: string | null
  email: string
  roleId: string
  roleSlug: string
  roleName: string
  status: string
}

export type DepartmentManagementSnapshot = {
  department: { id: string; name: string; slug: string; description: string | null; status: string }
  roles: DepartmentManagementRole[]
  memberships: DepartmentManagementMember[]
}

export type DepartmentManagerApprovalPolicy = {
  enabled: boolean
  requiredActions: Array<{ toolId: string; actions: string[] }>
}

export type DepartmentCandidate = {
  channelIdentityId: string
  userId?: string
  name?: string
  email?: string
  workspaceRole?: string
  isWorkspaceMember: boolean
  isAlreadyAssigned: boolean
  larkDisplayName?: string
  larkSourceRoles: string[]
}

/**
 * What one department has actually configured, for every tool at once.
 * The tools list needs this per row; the manage snapshot is the drill-down.
 */
export type DepartmentToolCoverage = {
  tool: DivoTool
  supportedActions: string[]
  actionLabels: Record<string, string>
  actionsGranted: string[]
  approvalActions: string[]
  peopleWithAccess: number
  /** Actions company policy is holding down for ordinary members. */
  blockedActions: string[]
  exceptionCount: number
}

export type DepartmentCoverage = {
  department: { id: string; name: string }
  totalPeople: number
  tools: DepartmentToolCoverage[]
}

export function getDivoToolsInventory(): Promise<DivoToolInventory> {
  return invoke<DivoToolInventory>('divo_tools_inventory')
}

export function getDivoDepartmentToolCoverage(departmentId: string): Promise<DepartmentCoverage> {
  return invoke<DepartmentCoverage>('divo_tool_coverage', { departmentId })
}

export function getDivoToolManageSnapshot(
  toolId: string,
  scope: ToolManagementScope,
): Promise<ToolManageSnapshot> {
  return invoke<ToolManageSnapshot>('divo_tool_manage_snapshot', {
    toolId,
    scope: scope.kind,
    departmentId: scope.kind === 'department' ? scope.department.id : undefined,
  })
}

export function setDivoGlobalToolAction(
  toolId: string,
  role: string,
  actionGroup: string,
  enabled: boolean,
): Promise<GlobalToolManageSnapshot> {
  return invoke<GlobalToolManageSnapshot>('divo_tool_set_global_action', {
    toolId,
    role,
    actionGroup,
    enabled,
  })
}

export function setDivoDepartmentRoleToolAction(
  toolId: string,
  departmentId: string,
  roleId: string,
  actionGroup: string,
  allowed: boolean,
): Promise<DepartmentToolManageSnapshot> {
  return invoke<DepartmentToolManageSnapshot>('divo_tool_set_department_role_action', {
    toolId,
    departmentId,
    roleId,
    actionGroup,
    allowed,
  })
}

export function setDivoDepartmentMemberToolAction(
  toolId: string,
  departmentId: string,
  userId: string,
  actionGroup: string,
  allowed: boolean,
): Promise<DepartmentToolManageSnapshot> {
  return invoke<DepartmentToolManageSnapshot>('divo_tool_set_department_member_action', {
    toolId,
    departmentId,
    userId,
    actionGroup,
    allowed,
  })
}

export function getDivoDepartmentManageSnapshot(departmentId: string): Promise<DepartmentManagementSnapshot> {
  return invoke<DepartmentManagementSnapshot>('divo_department_manage_snapshot', { departmentId })
}

export function getDivoDepartmentManagerApproval(departmentId: string): Promise<DepartmentManagerApprovalPolicy> {
  return invoke<DepartmentManagerApprovalPolicy>('divo_department_manager_approval', { departmentId })
}

export function setDivoDepartmentManagerApproval(
  departmentId: string,
  policy: DepartmentManagerApprovalPolicy,
): Promise<DepartmentManagerApprovalPolicy> {
  return invoke<DepartmentManagerApprovalPolicy>('divo_department_set_manager_approval', {
    departmentId,
    enabled: policy.enabled,
    requiredActions: policy.requiredActions,
  })
}

export function setDivoDepartmentZohoPersonalizedScope(
  departmentId: string,
  roleId: string,
  personalized: boolean,
): Promise<{ roleId: string; zohoReadScope: 'personalized' | 'show_all' }> {
  return invoke('divo_department_set_zoho_personalized_scope', { departmentId, roleId, personalized })
}

export function searchDivoDepartmentCandidates(departmentId: string, query: string): Promise<DepartmentCandidate[]> {
  return invoke<DepartmentCandidate[]>('divo_department_search_candidates', { departmentId, query })
}

export function createDivoDepartmentRole(departmentId: string, name: string, slug: string): Promise<DepartmentManagementRole> {
  return invoke<DepartmentManagementRole>('divo_department_create_role', { departmentId, name, slug })
}

export function updateDivoDepartmentRole(departmentId: string, roleId: string, name: string): Promise<DepartmentManagementRole> {
  return invoke<DepartmentManagementRole>('divo_department_update_role', { departmentId, roleId, name })
}

export function deleteDivoDepartmentRole(departmentId: string, roleId: string): Promise<{ deleted: boolean }> {
  return invoke<{ deleted: boolean }>('divo_department_delete_role', { departmentId, roleId })
}

export function saveDivoDepartmentMember(departmentId: string, userId: string, roleId: string): Promise<DepartmentManagementMember> {
  return invoke<DepartmentManagementMember>('divo_department_save_member', { departmentId, userId, roleId })
}

export function removeDivoDepartmentMember(departmentId: string, userId: string): Promise<{ deleted: boolean }> {
  return invoke<{ deleted: boolean }>('divo_department_remove_member', { departmentId, userId })
}

export function toolSearchText(item: DivoToolInventoryItem): string {
  return [
    item.tool.name,
    item.tool.description,
    item.tool.category,
    item.tool.domain,
    ...item.origins.flatMap(origin => origin.kind === 'department' ? [origin.department.name] : [origin.kind]),
    ...item.managementScopes.map(scope => scope.kind === 'global' ? scope.label : `Manage ${scope.department.name}`),
  ].join(' ').toLocaleLowerCase()
}

export function toolActionSummary(item: DivoToolInventoryItem): string {
  const actions = [...new Set(item.origins.flatMap(origin => 'allowedActions' in origin ? origin.allowedActions : []))]
  if (actions.length) return actions.join(', ')
  return item.origins.some(origin => origin.kind === 'local' || origin.kind === 'system') ? 'Fixed policy' : 'Management access only'
}
