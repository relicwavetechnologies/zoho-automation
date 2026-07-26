import type {
  DepartmentToolManageSnapshot,
  DepartmentToolCoverage,
  DivoToolInventoryItem,
} from '@/lib/divo-tools'

/**
 * The reading of the permission model the access screens are built on.
 *
 * The old screens rendered the backend's vocabulary directly — origin, scope,
 * provenance, clamp reason, company ceiling — as three stacked lists with
 * different words for the same thing. These are the few questions a manager
 * actually asks, answered once, so every table can be dumb.
 */

export type ToolReadiness = 'ready' | 'connection_required' | 'admin_connection_required' | 'not_applicable'

/** What a row in the tools list says about a tool, at a glance. */
export type ToolStatus =
  | { kind: 'ready'; label: 'Ready' }
  | { kind: 'attention'; label: 'Needs connection' }
  | { kind: 'fixed'; label: 'Fixed by Divo' }
  | { kind: 'builtin'; label: 'Built in' }

export function toolStatus(items: DivoToolInventoryItem[]): ToolStatus {
  if (items.some(item => item.readiness === 'connection_required' || item.readiness === 'admin_connection_required')) {
    return { kind: 'attention', label: 'Needs connection' }
  }
  if (items.length > 0 && items.every(item => item.origins.some(origin => origin.kind === 'local' || origin.kind === 'system'))) {
    return { kind: 'fixed', label: 'Fixed by Divo' }
  }
  if (items.some(item => item.readiness === 'ready')) return { kind: 'ready', label: 'Ready' }
  return { kind: 'builtin', label: 'Built in' }
}

/** "All 9 people", "5 of 9 people", "No one". */
export function coverageLabel(peopleWithAccess: number, totalPeople: number): string {
  if (peopleWithAccess === 0) return 'No one'
  if (totalPeople > 0 && peopleWithAccess === totalPeople) return `All ${totalPeople} people`
  return `${peopleWithAccess} of ${totalPeople} people`
}

/** A tool nobody in the department can use is "available", not "in use". */
export function isInUse(coverage: DepartmentToolCoverage): boolean {
  return coverage.peopleWithAccess > 0 || coverage.actionsGranted.length > 0
}

export type CeilingState =
  | { kind: 'clear' }
  | { kind: 'partial'; actions: string[] }
  | { kind: 'total' }

/**
 * How much of a tool company policy is holding down. A ceiling that blocks
 * everything is one sentence said once; a ceiling that varies action by action
 * is the only case that earns a label on each switch.
 */
export function ceilingState(coverage: Pick<DepartmentToolCoverage, 'blockedActions' | 'supportedActions'>): CeilingState {
  if (!coverage.blockedActions.length) return { kind: 'clear' }
  if (coverage.blockedActions.length >= coverage.supportedActions.length) return { kind: 'total' }
  return { kind: 'partial', actions: coverage.blockedActions }
}

export type EffectiveMark = 'allowed' | 'blocked_by_company' | 'not_allowed'

/**
 * One person, one action: what actually happens, and why.
 *
 * `configuredAllowed` is what the department set; `effectiveAllowed` is what
 * survives company policy. Showing only one of them is how "I switched it on
 * and nothing happened" became a support question.
 */
export function effectiveMark(state: {
  configuredAllowed: boolean
  effectiveAllowed: boolean
}): EffectiveMark {
  if (state.effectiveAllowed) return 'allowed'
  return state.configuredAllowed ? 'blocked_by_company' : 'not_allowed'
}

export function whyThisAccess(state: {
  configuredProvenance: 'member_override' | 'department_role' | 'default'
  configuredAllowed: boolean
  effectiveBlockReason: 'company_tool_disabled' | 'company_action_disabled' | null
  roleName: string
}): string {
  if (state.effectiveBlockReason) return 'Blocked by company policy'
  if (state.configuredProvenance === 'member_override') {
    return state.configuredAllowed ? 'Allowed by a personal exception' : 'Removed by a personal exception'
  }
  if (state.configuredProvenance === 'department_role' && state.configuredAllowed) return `Allowed by the ${state.roleName} group`
  return `The ${state.roleName} group does not have this`
}

/** People in a group, named — "Rahul, Priya +3". */
export function groupMemberSummary(names: string[], limit = 3): string {
  if (!names.length) return 'No one yet'
  const shown = names.slice(0, limit).join(', ')
  return names.length > limit ? `${shown} +${names.length - limit}` : shown
}

/**
 * The actions a group holds, from the snapshot's role states. Used for the
 * capability list, where a per-switch grid would be far too much detail.
 */
export function grantedActions(snapshot: DepartmentToolManageSnapshot): string[] {
  return snapshot.supportedActions.filter(action =>
    snapshot.roleActionStates.some(state => state.actionGroup === action && state.configuredAllowed))
}
