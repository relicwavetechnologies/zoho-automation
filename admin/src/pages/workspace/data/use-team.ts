/**
 * The manager's view of one department.
 *
 * Everything here already existed on the backend and nothing called it. The
 * permission snapshot in particular is richer than the mock assumed: it reports
 * what was *configured*, where that came from, what the member can *actually*
 * do, and — when those two disagree — which company-level rule is holding it
 * down. That last part is the thing a manager needs and almost no RBAC UI has,
 * so it is modelled here rather than flattened into a boolean.
 *
 * These routers answer with their payload bare rather than the usual
 * { success, data }, hence `raw` on every call.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

export type DeptRole = { id: string; name: string; slug: string; isDefault?: boolean }

export type DeptMember = {
  id?: string
  userId: string
  name: string | null
  email: string
  roleId: string
  roleSlug?: string
  roleName?: string
  status?: string
}

export type DepartmentSnapshot = {
  department: { id: string; name: string; slug: string; description: string | null }
  roles: DeptRole[]
  memberships: DeptMember[]
}

/**
 * Why a configured permission is not in effect.
 *
 * Both values mean the same thing to the person reading it — the company
 * ceiling is above you — but they point at different settings, so the message
 * can name the one an admin would actually have to change.
 */
export type EffectiveBlockReason = 'company_tool_disabled' | 'company_action_disabled' | null

/** Where a configured value came from, in backend terms. */
export type ConfiguredProvenance = 'member_override' | 'department_role' | 'default'

export type MemberActionState = {
  userId: string
  actionGroup: string
  configuredAllowed: boolean
  configuredProvenance: ConfiguredProvenance
  effectiveAllowed: boolean
  effectiveBlockReason: EffectiveBlockReason
  storedOverride: boolean | null
  provenance: 'override' | 'inherited'
}

export type RoleActionState = {
  roleId: string
  actionGroup: string
  configuredAllowed: boolean
  configuredProvenance: 'department_role' | 'default'
  /**
   * Whether the company ceiling leaves this grant any effect for the people
   * currently in the role. `no_active_members` is not a block — it means the
   * question cannot be answered yet, which is different from "denied".
   */
  companyPolicyStatus:
    | 'no_active_members'
    | 'company_tool_blocks_all_current_members'
    | 'company_action_blocks_all_current_members'
    | 'company_policy_allows_some_current_members'
}

export type ToolScopeSnapshot = {
  tool: { toolId: string; name: string; description?: string | null }
  supportedActions: string[]
  actionLabels: Record<string, string>
  roles: DeptRole[]
  members: DeptMember[]
  memberActionStates: MemberActionState[]
  roleActionStates: RoleActionState[]
  companyCeiling: { role: string; actions: string[] }[]
}

const base = '/api/desktop'

export function useDepartment(departmentId?: string) {
  const { token } = useAdminAuth()
  const [snapshot, setSnapshot] = useState<DepartmentSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token || !departmentId) { setLoading(false); return }
    try {
      const data = await api.get<DepartmentSnapshot>(
        `${base}/departments/${departmentId}/manage`, token, { quiet: true, raw: true },
      )
      setSnapshot(data)
      setError(null)
    } catch (e) {
      // The route refuses anyone who does not manage this department, which is
      // a meaningful answer rather than a failure — say so plainly.
      setError(e instanceof Error ? e.message : 'Could not load this department.')
      setSnapshot(null)
    } finally {
      setLoading(false)
    }
  }, [token, departmentId])

  useEffect(() => { void load() }, [load])

  const setMemberRole = useCallback(async (userId: string, roleId: string) => {
    if (!token || !departmentId) return
    await api.put(`${base}/departments/${departmentId}/memberships`, { userId, roleId }, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  const removeMember = useCallback(async (userId: string) => {
    if (!token || !departmentId) return
    await api.delete(`${base}/departments/${departmentId}/memberships/${userId}`, {}, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  return { snapshot, loading, error, refresh: load, setMemberRole, removeMember }
}

/**
 * One tool's permissions in one department, with provenance and ceiling.
 *
 * `scope` is the manager's department. The same route serves the company view
 * with `scope=global`, which is why the audience is a parameter rather than two
 * separate hooks — one editor, two audiences.
 */
export function useToolScope(toolId?: string, departmentId?: string) {
  const { token } = useAdminAuth()
  const [snapshot, setSnapshot] = useState<ToolScopeSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!token || !toolId || !departmentId) { setLoading(false); return }
    setLoading(true)
    try {
      const query = `scope=department&departmentId=${encodeURIComponent(departmentId)}`
      setSnapshot(await api.get<ToolScopeSnapshot>(
        `${base}/tools/${toolId}/manage?${query}`, token, { quiet: true, raw: true },
      ))
    } catch {
      setSnapshot(null)
    } finally {
      setLoading(false)
    }
  }, [token, toolId, departmentId])

  useEffect(() => { void load() }, [load])

  /** Grant or withhold an action for a whole role. */
  const setRoleAction = useCallback(async (roleId: string, actionGroup: string, allowed: boolean) => {
    if (!token || !toolId || !departmentId) return
    await api.put(
      `${base}/tools/${toolId}/departments/${departmentId}/roles/${roleId}/actions/${actionGroup}`,
      { allowed }, token, { raw: true },
    )
    await load()
  }, [token, toolId, departmentId, load])

  /**
   * An exception for one person.
   *
   * Note there is no way to lift one back to the role: the override table has
   * only findMany and upsert in the entire backend, so `allowed: false` is an
   * explicit deny that still outranks the role rather than a return to
   * inheriting. The UI must not offer "reset to role" until a DELETE exists.
   */
  const setMemberAction = useCallback(async (userId: string, actionGroup: string, allowed: boolean) => {
    if (!token || !toolId || !departmentId) return
    await api.put(
      `${base}/tools/${toolId}/departments/${departmentId}/members/${userId}/actions/${actionGroup}`,
      { allowed }, token, { raw: true },
    )
    await load()
  }, [token, toolId, departmentId, load])

  return { snapshot, loading, refresh: load, setRoleAction, setMemberAction }
}

/** Every tool's configured reach in one department, in one round trip. */
export function useDepartmentCoverage(departmentId?: string) {
  const { token } = useAdminAuth()
  const [coverage, setCoverage] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token || !departmentId) { setLoading(false); return }
    let live = true
    void (async () => {
      try {
        const data = await api.get(`${base}/tools/coverage/${departmentId}`, token, { quiet: true, raw: true })
        if (live) setCoverage(data)
      } catch {
        if (live) setCoverage(null)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token, departmentId])

  return { coverage, loading }
}

/**
 * The department this person leads.
 *
 * Managing more than one is possible, and the scope switcher already lists each
 * separately — this picks the first as the default landing department.
 */
export function useMyManagedDepartment(): { id: string; name: string } | null {
  const { session } = useAdminAuth()
  const led = session?.departments.find((d) => d.isManager)
  return led ? { id: led.id, name: led.name } : null
}
