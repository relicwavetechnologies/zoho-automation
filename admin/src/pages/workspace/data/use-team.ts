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
import { ApiError, api } from '@/lib/api'
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
  const [refused, setRefused] = useState(false)

  const load = useCallback(async () => {
    if (!token || !departmentId) { setLoading(false); return }
    try {
      const data = await api.get<DepartmentSnapshot>(
        `${base}/departments/${departmentId}/manage`, token, { quiet: true, raw: true },
      )
      setSnapshot(data)
      setError(null)
      setRefused(false)
    } catch (e) {
      // The route refuses anyone who does not manage this department, which is
      // a meaningful answer rather than a failure — say so plainly.
      setError(e instanceof Error ? e.message : 'Could not load this department.')
      setRefused(e instanceof ApiError && (e.status === 403 || e.status === 401))
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

  return { snapshot, loading, error, refused, refresh: load, setMemberRole, removeMember }
}

export type CoverageTool = {
  tool: { toolId: string; name: string; description: string | null; category: string; domain: string }
  supportedActions: string[]
  actionLabels: Record<string, string>
  actionsGranted: string[]
  approvalActions: string[]
  peopleWithAccess: number
  blockedActions: string[]
  exceptionCount: number
}

export type Coverage = {
  department: { id: string; name: string }
  totalPeople: number
  tools: CoverageTool[]
}

/**
 * Every configurable tool in one department, each with its full permission
 * snapshot.
 *
 * The backend is tool-first — one snapshot per tool — while a manager thinks
 * person-first. Rather than ask the backend to grow a second shape, the whole
 * set is fetched once and pivoted here: a person's row is their entries across
 * every tool's `memberActionStates`, a role's row is the same across
 * `roleActionStates`. It is one burst of small parallel reads on entering the
 * scope, and every later view is instant and consistent.
 */
export function useDepartmentMatrix(departmentId?: string) {
  const { token } = useAdminAuth()
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [tools, setTools] = useState<ToolScopeSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token || !departmentId) { setLoading(false); return }
    try {
      const cover = await api.get<Coverage>(
        `${base}/tools/coverage/${departmentId}`, token, { quiet: true, raw: true },
      )
      const query = `scope=department&departmentId=${encodeURIComponent(departmentId)}`
      const snapshots = await Promise.all(cover.tools.map((entry) =>
        api.get<ToolScopeSnapshot>(
          `${base}/tools/${entry.tool.toolId}/manage?${query}`, token, { quiet: true, raw: true },
        ).catch(() => null),
      ))
      setCoverage(cover)
      // A tool that refuses is dropped rather than rendered as a blank row —
      // an empty grid reads as "nothing is allowed", which is a lie.
      setTools(snapshots.filter((s): s is ToolScopeSnapshot => s !== null))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this team’s permissions.')
      setCoverage(null)
      setTools([])
    } finally {
      setLoading(false)
    }
  }, [token, departmentId])

  useEffect(() => { void load() }, [load])

  /** Re-reads one tool after a write, leaving the other snapshots alone. */
  const reloadTool = useCallback(async (toolId: string) => {
    if (!token || !departmentId) return
    const query = `scope=department&departmentId=${encodeURIComponent(departmentId)}`
    const fresh = await api.get<ToolScopeSnapshot>(
      `${base}/tools/${toolId}/manage?${query}`, token, { quiet: true, raw: true },
    )
    setTools((prev) => prev.map((s) => (s.tool.toolId === toolId ? fresh : s)))
  }, [token, departmentId])

  const setRoleAction = useCallback(async (toolId: string, roleId: string, actionGroup: string, allowed: boolean) => {
    if (!token || !departmentId) return
    await api.put(
      `${base}/tools/${toolId}/departments/${departmentId}/roles/${roleId}/actions/${actionGroup}`,
      { allowed }, token, { raw: true },
    )
    await reloadTool(toolId)
  }, [token, departmentId, reloadTool])

  const setMemberAction = useCallback(async (toolId: string, userId: string, actionGroup: string, allowed: boolean) => {
    if (!token || !departmentId) return
    await api.put(
      `${base}/tools/${toolId}/departments/${departmentId}/members/${userId}/actions/${actionGroup}`,
      { allowed }, token, { raw: true },
    )
    await reloadTool(toolId)
  }, [token, departmentId, reloadTool])

  const clearMemberAction = useCallback(async (toolId: string, userId: string, actionGroup: string) => {
    if (!token || !departmentId) return
    await api.delete(
      `${base}/tools/${toolId}/departments/${departmentId}/members/${userId}/actions/${actionGroup}`,
      {}, token, { raw: true },
    )
    await reloadTool(toolId)
  }, [token, departmentId, reloadTool])

  return { coverage, tools, loading, error, refresh: load, setRoleAction, setMemberAction, clearMemberAction }
}

export type TeamMemberUsage = {
  userId: string
  name: string | null
  email: string
  roleSlug: string
  roleName: string
  spendUsd: number
  runs: number
}

export type TeamUsage = {
  days: number
  spendUsd: number
  runs: number
  totalPeople: number
  activePeople: number
  people: TeamMemberUsage[]
}

const EMPTY_USAGE: TeamUsage = { days: 30, spendUsd: 0, runs: 0, totalPeople: 0, activePeople: 0, people: [] }

/** What this department cost, per person, heaviest first. */
export function useTeamUsage(departmentId?: string, days = 30) {
  const { token } = useAdminAuth()
  const [usage, setUsage] = useState<TeamUsage>(EMPTY_USAGE)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token || !departmentId) { setLoading(false); return }
    let live = true
    void (async () => {
      try {
        const data = await api.get<TeamUsage>(
          `${base}/departments/${departmentId}/usage?days=${days}`, token, { quiet: true },
        )
        if (live) setUsage(data)
      } catch {
        if (live) setUsage({ ...EMPTY_USAGE, days })
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token, departmentId, days])

  return { usage, loading }
}

export type ApprovalPolicy = {
  enabled: boolean
  requiredActions: { toolId: string; actions: string[] }[]
}

/** What Divo must ask this manager about before doing it. */
export function useApprovalPolicy(departmentId?: string) {
  const { token } = useAdminAuth()
  const [policy, setPolicy] = useState<ApprovalPolicy | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!token || !departmentId) { setLoading(false); return }
    let live = true
    void (async () => {
      try {
        const data = await api.get<ApprovalPolicy>(
          `${base}/departments/${departmentId}/manager-approval`, token, { quiet: true, raw: true },
        )
        if (live) setPolicy(data)
      } catch {
        if (live) setPolicy(null)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token, departmentId])

  /**
   * The route replaces the whole policy, so the caller sends the complete next
   * state rather than a delta — and the local copy is only adopted once the
   * backend has echoed its own normalised version back.
   */
  const save = useCallback(async (next: ApprovalPolicy) => {
    if (!token || !departmentId) return
    setSaving(true)
    try {
      const saved = await api.put<ApprovalPolicy>(
        `${base}/departments/${departmentId}/manager-approval`, next, token, { raw: true },
      )
      setPolicy(saved)
    } finally {
      setSaving(false)
    }
  }, [token, departmentId])

  return { policy, loading, saving, save }
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
