/**
 * The desktop view of one department.
 *
 * The team page writes through manager-only routes. Company views may also read
 * the same snapshot, so the agent map can show every team without re-deriving
 * permissions in the browser.
 *
 * These routers answer with their payload bare rather than the usual
 * { success, data }, hence `raw` on every call.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, api } from '@/lib/api'
import { TOOLS_BASE } from './use-tools'
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

/**
 * One row from the candidate search.
 *
 * Mirrors `CandidateSummary` on the backend, optionality included: the rows are
 * built from Lark channel identities, and an identity may carry no email, no
 * display name and no matching Divo user.
 */
export type Candidate = {
  /**
   * Absent for somebody who reached Divo without Lark.
   *
   * The search used to start and end at this company's Lark directory, so every
   * candidate had one. A team on a different Lark tenant — given accounts here
   * by invite — has no identity on this install, and they are returned by their
   * Divo account instead.
   */
  channelIdentityId?: string
  userId?: string
  name?: string
  email?: string
  workspaceRole?: string
  isWorkspaceMember: boolean
  isAlreadyAssigned: boolean
  larkDisplayName?: string
}

/**
 * A stable React key, whichever door the candidate came through.
 *
 * Three kinds of row reach the list and only one of them is guaranteed a Lark
 * identity, so keying on that alone gave every invited member the same
 * `undefined` key — React then reuses one row's state for another as the search
 * narrows, and the wrong person ends up selected.
 */
export function candidateKey(c: Candidate): string {
  return c.channelIdentityId ?? (c.userId ? `user:${c.userId}` : `email:${c.email ?? ''}`)
}

/** Whether this candidate can actually be added, and if not, why. */
export function candidateBlock(c: Candidate): string | null {
  if (c.isAlreadyAssigned) return 'Already in this team'
  if (!c.isWorkspaceMember || !c.userId) return 'No Divo account yet'
  return null
}

/** A name for a candidate that never assumes a field is present. */
export function candidateLabel(c: Candidate): string {
  // "Unnamed account" rather than "Unnamed Lark account": a row with no name
  // may never have been near Lark, and naming the wrong system is how somebody
  // goes looking for the fix in a directory this person is not in.
  return c.name ?? c.larkDisplayName ?? c.email ?? 'Unnamed account'
}

export function useDepartment(departmentId?: string) {
  const { token } = useAdminAuth()
  const [snapshot, setSnapshot] = useState<DepartmentSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)

  // See `useAdminResource` in use-company.ts: switching departments mid-flight
  // otherwise lets the older answer land last and win.
  const generation = useRef(0)

  const load = useCallback(async () => {
    if (!token || !departmentId) { generation.current += 1; setLoading(false); return }
    const gen = ++generation.current
    setLoading(true)
    try {
      const data = await api.get<DepartmentSnapshot>(
        `${base}/departments/${departmentId}/manage`, token, { quiet: true, raw: true },
      )
      if (generation.current !== gen) return
      setSnapshot(data)
      setError(null)
      setRefused(false)
    } catch (e) {
      if (generation.current !== gen) return
      // A refusal is a meaningful answer rather than a failure: the viewer may
      // not manage or administer this department.
      setError(e instanceof Error ? e.message : 'Could not load this department.')
      setRefused(e instanceof ApiError && (e.status === 403 || e.status === 401))
      setSnapshot(null)
    } finally {
      if (generation.current === gen) setLoading(false)
    }
  }, [token, departmentId])

  useEffect(() => { void load() }, [load])

  const setMemberRole = useCallback(async (userId: string, roleId: string) => {
    if (!token || !departmentId) return
    await api.put(`${base}/departments/${departmentId}/memberships`, { userId, roleId }, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  /**
   * Adds or moves somebody. The same PUT does both — the backend upserts, so
   * "add Ananya as Analyst" and "move Ananya to Analyst" are one call.
   */
  const addMember = useCallback(async (userId: string, roleId: string) => {
    if (!token || !departmentId) return
    await api.put(`${base}/departments/${departmentId}/memberships`, { userId, roleId }, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  /**
   * Search people who could join this team.
   *
   * It does **not** exclude anyone — that was a comment describing behaviour
   * the route never had. The search runs over Lark channel identities, and it
   * returns three kinds of person: somebody addable, somebody already in this
   * team, and a Lark identity with no Divo account behind it at all. Only the
   * first can be added; `userId` is genuinely absent for the third, which is
   * why every field here is optional. Typing them as required is what let a
   * `userId`-less row reach `addMember` and come back as a bare 400, and let a
   * row with neither name nor email throw inside `initialsOf` mid-render.
   *
   * The two unaddable kinds are returned rather than filtered out, so the
   * drawer can say which one it is. "Nobody matches" when the person is right
   * there in Lark is a worse answer than "they need a Divo account first".
   */
  const findCandidates = useCallback(async (query: string): Promise<Candidate[]> => {
    if (!token || !departmentId || query.trim().length === 0) return []
    return api.get<Candidate[]>(
      `${base}/departments/${departmentId}/candidates?query=${encodeURIComponent(query)}`,
      token, { quiet: true, raw: true },
    ).catch(() => [])
  }, [token, departmentId])

  const createRole = useCallback(async (name: string) => {
    if (!token || !departmentId) return
    // The slug is the stable identifier the backend matches on and is not
    // user-editable afterwards, so it is derived rather than asked for.
    const slug = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
    await api.post(`${base}/departments/${departmentId}/roles`, { name: name.trim(), slug }, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  const renameRole = useCallback(async (roleId: string, name: string) => {
    if (!token || !departmentId) return
    await api.put(`${base}/departments/${departmentId}/roles/${roleId}`, { name: name.trim() }, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  const deleteRole = useCallback(async (roleId: string) => {
    if (!token || !departmentId) return
    await api.delete(`${base}/departments/${departmentId}/roles/${roleId}`, {}, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  const removeMember = useCallback(async (userId: string) => {
    if (!token || !departmentId) return
    await api.delete(`${base}/departments/${departmentId}/memberships/${userId}`, {}, token, { raw: true })
    await load()
  }, [token, departmentId, load])

  return {
    snapshot, loading, error, refused, refresh: load,
    setMemberRole, addMember, removeMember, findCandidates, createRole, renameRole, deleteRole,
  }
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

  // Same reason as `useDepartment` above: the permission grid is the one place
  // a stale answer is genuinely dangerous, because it is read as the record of
  // who may do what in the department currently on screen.
  const generation = useRef(0)

  const load = useCallback(async () => {
    if (!token || !departmentId) { generation.current += 1; setLoading(false); return }
    const gen = ++generation.current
    setLoading(true)
    try {
      const cover = await api.get<Coverage>(
        `${TOOLS_BASE}/tools/coverage/${departmentId}`, token, { quiet: true, raw: true },
      )
      if (generation.current !== gen) return
      const query = `scope=department&departmentId=${encodeURIComponent(departmentId)}`
      const snapshots = await Promise.all(cover.tools.map((entry) =>
        api.get<ToolScopeSnapshot>(
          `${TOOLS_BASE}/tools/${entry.tool.toolId}/manage?${query}`, token, { quiet: true, raw: true },
        ).catch(() => null),
      ))
      if (generation.current !== gen) return
      setCoverage(cover)
      // A tool that refuses is dropped rather than rendered as a blank row —
      // an empty grid reads as "nothing is allowed", which is a lie.
      const kept = snapshots.filter((s): s is ToolScopeSnapshot => s !== null)
      setTools(kept)
      // But dropping every one of them and rendering the remains is the same
      // lie in a different shape. If the coverage listed tools and not one
      // snapshot came back, that is a failed read, not an ungoverned team.
      setError(kept.length === 0 && cover.tools.length > 0
        ? 'Could not read this team’s permissions.'
        : null)
    } catch (e) {
      if (generation.current !== gen) return
      setError(e instanceof Error ? e.message : 'Could not load this team’s permissions.')
      setCoverage(null)
      setTools([])
    } finally {
      if (generation.current === gen) setLoading(false)
    }
  }, [token, departmentId])

  useEffect(() => { void load() }, [load])

  /** Re-reads one tool after a write, leaving the other snapshots alone. */
  const reloadTool = useCallback(async (toolId: string) => {
    if (!token || !departmentId) return
    const query = `scope=department&departmentId=${encodeURIComponent(departmentId)}`
    const fresh = await api.get<ToolScopeSnapshot>(
      `${TOOLS_BASE}/tools/${toolId}/manage?${query}`, token, { quiet: true, raw: true },
    )
    setTools((prev) => prev.map((s) => (s.tool.toolId === toolId ? fresh : s)))
  }, [token, departmentId])

  const setRoleAction = useCallback(async (toolId: string, roleId: string, actionGroup: string, allowed: boolean) => {
    if (!token || !departmentId) return
    await api.put(
      `${TOOLS_BASE}/tools/${toolId}/departments/${departmentId}/roles/${roleId}/actions/${actionGroup}`,
      { allowed }, token, { raw: true },
    )
    await reloadTool(toolId)
  }, [token, departmentId, reloadTool])

  const setMemberAction = useCallback(async (toolId: string, userId: string, actionGroup: string, allowed: boolean) => {
    if (!token || !departmentId) return
    await api.put(
      `${TOOLS_BASE}/tools/${toolId}/departments/${departmentId}/members/${userId}/actions/${actionGroup}`,
      { allowed }, token, { raw: true },
    )
    await reloadTool(toolId)
  }, [token, departmentId, reloadTool])

  const clearMemberAction = useCallback(async (toolId: string, userId: string, actionGroup: string) => {
    if (!token || !departmentId) return
    await api.delete(
      `${TOOLS_BASE}/tools/${toolId}/departments/${departmentId}/members/${userId}/actions/${actionGroup}`,
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
  /**
   * The team's spend by day, every day in the window including the zeroes.
   *
   * A total on its own cannot tell a team that uses Divo daily from one that
   * used it once and stopped, and that is the question a manager opens this
   * page with. Priced by the same helpers as the personal figure, so the two
   * cannot disagree about what a day cost.
   */
  series: { date: string; spendUsd: number }[]
  people: TeamMemberUsage[]
}

const EMPTY_USAGE: TeamUsage = {
  days: 30, spendUsd: 0, runs: 0, totalPeople: 0, activePeople: 0, series: [], people: [],
}

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

/* ── Which team am I managing ─────────────────────────── */

/**
 * Leading two departments used to mean managing one of them.
 *
 * `session.departments` can hold several with `isManager`, and the sidebar
 * switcher lists each — but every Team entry navigated to the same `/team`, and
 * this hook returned `.find(isManager)`, so the second department was
 * unreachable from anywhere in the app. The URL is not the right place to carry
 * it either: five routes would each have to grow a segment, and coming back to
 * `/team` from a bookmark would still have to choose.
 *
 * So the choice is remembered, the way the desktop remembers its tool scope.
 * `useSyncExternalStore` rather than a context because the writer is the
 * sidebar and the readers are five screens that do not share a provider — this
 * keeps them in step without threading state through the shell.
 */
const MANAGED_DEPARTMENT_KEY = 'divo_team_department'

const departmentListeners = new Set<() => void>()

const readStoredDepartment = (): string | null => {
  try { return localStorage.getItem(MANAGED_DEPARTMENT_KEY) } catch { return null }
}

let storedDepartmentId: string | null = readStoredDepartment()

/** Remembers which led department the Team scope is currently about. */
export function selectManagedDepartment(departmentId: string): void {
  if (storedDepartmentId === departmentId) return
  storedDepartmentId = departmentId
  try { localStorage.setItem(MANAGED_DEPARTMENT_KEY, departmentId) } catch { /* private browsing */ }
  for (const listener of departmentListeners) listener()
}

const subscribeDepartment = (listener: () => void) => {
  departmentListeners.add(listener)
  return () => { departmentListeners.delete(listener) }
}

const departmentSnapshot = () => storedDepartmentId

/**
 * Every department this person leads, and which one the Team scope is showing.
 *
 * Falls back to the first rather than to nothing when the remembered id is not
 * one they lead any more — losing the manager role on one team should not blank
 * the scope for the other.
 */
export function useManagedDepartments(): {
  departments: { id: string; name: string }[]
  department: { id: string; name: string } | null
  select: (departmentId: string) => void
} {
  const { session } = useAdminAuth()
  const stored = useSyncExternalStore(subscribeDepartment, departmentSnapshot, departmentSnapshot)

  const departments = useMemo(
    () => (session?.departments ?? [])
      .filter((d) => d.isManager)
      .map((d) => ({ id: d.id, name: d.name })),
    [session],
  )

  const department = departments.find((d) => d.id === stored) ?? departments[0] ?? null
  return { departments, department, select: selectManagedDepartment }
}
