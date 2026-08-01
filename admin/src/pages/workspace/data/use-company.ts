/**
 * The company scope, on the admin API that already existed.
 *
 * Nothing here is a new endpoint. The old console read all of this; the revamp
 * changes what is shown and how, not where it comes from.
 *
 * One deliberate choice runs through the whole file: **cost comes from /spend,
 * never from /analytics/overview**. The analytics route reports an
 * `estimatedCostUsd` computed from a single blended rate across every model,
 * which was fine as a rough gauge and is wrong as a number anyone acts on. The
 * spend routes price each model separately and split cached input from fresh,
 * which is what the member and team surfaces already report. Two different
 * figures for the same month is the fastest way to lose trust in both.
 *
 * Nothing here duplicates `cursor/use-spend.ts`, `use-proxy.ts` or
 * `use-proxy-policy.ts`. Those own spend, the directory and the proxy — they
 * cache through react-query and they take a `companyId`, which is what a
 * super-admin looking at another workspace needs. Two hooks over one route is
 * two answers to one question; when in doubt the cursor one wins and this file
 * covers only what it does not.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '@/lib/api'
import { useToolInventory } from './use-tools'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

const base = '/api/admin'

/** Every hook here follows the same shape, so this carries the boilerplate. */
function useAdminResource<T>(path: string | null, fallback: T) {
  const { token } = useAdminAuth()
  const [data, setData] = useState<T>(fallback)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Kept apart from `error`: a refusal is an answer the screen should render as
  // one, a failure is something to retry.
  const [refused, setRefused] = useState(false)

  const load = useCallback(async () => {
    if (!token || !path) { setLoading(false); return }
    try {
      setData(await api.get<T>(`${base}${path}`, token, { quiet: true }))
      setError(null)
      setRefused(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this.')
      setRefused(e instanceof ApiError && (e.status === 403 || e.status === 401))
      setData(fallback)
    } finally {
      setLoading(false)
    }
    // `fallback` is a literal at every call site; including it would reload forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, path])

  useEffect(() => { void load() }, [load])

  return { data, loading, error, refused, refresh: load }
}

/* ── Overview ─────────────────────────────────────────── */

export type Overview = {
  period: { days: number; from: string; to: string }
  executions: { total: number; previousTotal: number; growthPct: number | null; delta: number }
  successRate: number
  activeMembers: number
  departmentCount: number
  tokens: { totalInput: number; totalOutput: number; total: number; callCount: number }
  channelBreakdown: { channel: string; count: number; pct: number }[]
  userActivity: { userId: string | null; name: string; email: string | null; count: number; pct: number }[]
  modelBreakdown: { modelId: string; provider: string; calls: number; inputTokens: number; outputTokens: number }[]
}

const EMPTY_OVERVIEW: Overview = {
  period: { days: 30, from: '', to: '' },
  executions: { total: 0, previousTotal: 0, growthPct: null, delta: 0 },
  successRate: 0, activeMembers: 0, departmentCount: 0,
  tokens: { totalInput: 0, totalOutput: 0, total: 0, callCount: 0 },
  channelBreakdown: [], userActivity: [], modelBreakdown: [],
}

/**
 * Company activity for the window.
 *
 * `tokens.estimatedCostUsd` is deliberately absent from the type. It exists on
 * the wire and is a blended-rate guess; leaving it out of the type is the
 * cheapest way to stop it reaching a screen by accident.
 */
export const useOverview = (days = 30) =>
  useAdminResource<Overview>(`/analytics/overview?days=${days}`, EMPTY_OVERVIEW)

/* ── Departments ──────────────────────────────────────── */

export type CompanyDepartment = {
  id: string
  companyId: string
  name: string
  slug: string
  description: string | null
  status: string
  /** Zero means nobody can approve for this team, which is worth surfacing. */
  managerCount: number
  memberCount: number
  roleCount: number
  hasAgentConfig: boolean
  createdAt: string
  updatedAt: string
}

export function useCompanyDepartments() {
  const { token } = useAdminAuth()
  const resource = useAdminResource<CompanyDepartment[]>('/departments', [])

  const createDepartment = useCallback(async (name: string, description?: string) => {
    if (!token) return
    await api.post(`${base}/departments`, { name: name.trim(), ...(description ? { description } : {}) }, token)
    await resource.refresh()
  }, [token, resource])

  const archiveDepartment = useCallback(async (id: string) => {
    if (!token) return
    // Archived rather than deleted: memberships, grants and audit rows point at
    // it, and a hard delete would orphan the history that explains them.
    await api.post(`${base}/departments/${id}/archive`, {}, token)
    await resource.refresh()
  }, [token, resource])

  return { ...resource, createDepartment, archiveDepartment }
}

/**
 * Spend per department.
 *
 * There is no company-wide route for this, but the department usage route
 * admits company admins as well as that department's manager — so the honest
 * answer is to ask it once per department rather than invent an aggregate.
 * Departments are few; this stays a handful of small parallel reads.
 */
export function useDepartmentSpend(departments: CompanyDepartment[], days = 30) {
  const { token } = useAdminAuth()
  const [spend, setSpend] = useState<Record<string, { spendUsd: number; runs: number }>>({})
  const [loading, setLoading] = useState(true)
  const ids = departments.map((d) => d.id).join(',')

  useEffect(() => {
    if (!token || !ids) { setLoading(false); return }
    let live = true
    void (async () => {
      const results = await Promise.all(ids.split(',').map(async (id) => {
        try {
          const data = await api.get<{ spendUsd: number; runs: number }>(
            `/api/desktop/departments/${id}/usage?days=${days}`, token, { quiet: true },
          )
          return [id, { spendUsd: data.spendUsd, runs: data.runs }] as const
        } catch {
          return null
        }
      }))
      if (!live) return
      setSpend(Object.fromEntries(results.filter((r): r is NonNullable<typeof r> => r !== null)))
      setLoading(false)
    })()
    return () => { live = false }
  }, [token, ids, days])

  return { spend, loading }
}

export type DepartmentDetail = {
  department: CompanyDepartment
  roles: { id: string; name: string; slug: string; isSystem: boolean; isDefault: boolean }[]
  memberships: {
    id: string; userId: string; name: string | null; email: string
    roleId: string; roleSlug: string; roleName: string; status: string
  }[]
  toolPermissions: { id: string; roleId: string; toolId: string; actionGroup: string; allowed: boolean }[]
  userOverrides: { id: string; userId: string; toolId: string; actionGroup: string; allowed: boolean }[]
  skills?: { id: string; name: string; summary: string; status: string }[]
}

/**
 * One department, read through the admin route rather than the manager's.
 *
 * The desktop route requires MANAGER membership, so a company admin who does
 * not personally lead the team gets a 403 there. Same data, different door.
 */
export const useDepartmentDetail = (departmentId?: string) =>
  useAdminResource<DepartmentDetail | null>(
    departmentId ? `/departments/${departmentId}?sections=roles,memberships,permissions,config` : null,
    null,
  )

/* ── Runs ─────────────────────────────────────────────── */

export type Run = {
  id: string
  status: string
  channel: string
  entrypoint: string
  latestSummary: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  userId: string | null
  userName: string | null
  turns: number
  tokens: number
  /** Null when nothing was attributed to the run — not the same as free. */
  costUsd: number | null
}

export function useRuns(filters: { limit?: number; status?: string; channel?: string; userId?: string } = {}) {
  const query = new URLSearchParams({ limit: String(filters.limit ?? 50) })
  if (filters.status) query.set('status', filters.status)
  if (filters.channel) query.set('channel', filters.channel)
  if (filters.userId) query.set('userId', filters.userId)
  return useAdminResource<Run[]>(`/executions?${query.toString()}`, [])
}

export const useRun = (runId?: string) =>
  useAdminResource<Run | null>(runId ? `/executions/${runId}` : null, null)

export type RunEvent = {
  id: string
  sequence: number
  phase: string
  eventType: string
  actorType: string
  actorKey: string | null
  title: string
  summary: string | null
  status: string | null
  payload: unknown
  createdAt: string
}

export const useRunEvents = (runId?: string) =>
  useAdminResource<RunEvent[]>(runId ? `/executions/${runId}/events` : null, [])

/* ── Audit ────────────────────────────────────────────── */

/**
 * One recorded change.
 *
 * The row carries an `actorId` and no name — resolving it is the caller's job,
 * against the directory it already has. `metadata` is whatever the writing
 * service passed, already redacted of anything secret-shaped by the backend.
 */
export type AuditEntry = {
  id: string
  companyId: string
  action: string
  outcome: string
  actorId: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export const useAuditLog = (limit = 100) =>
  useAdminResource<AuditEntry[]>(`/audit/logs?limit=${limit}`, [])

/* ── The company ceiling ──────────────────────────────── */

export type CeilingAction = {
  actionGroup: string
  /** What a person in this role can actually do, after the tool gate. */
  effectiveAllowed: boolean
  /** What the action row says on its own — `true` by default. */
  storedAllowed: boolean
  storedProvenance: 'override' | 'default'
  /**
   * Set when the whole tool is switched off for the role, which overrides every
   * action beneath it. The action row can say allow and mean nothing.
   */
  clampReason: 'company_tool_disabled' | null
}

export type CeilingTool = {
  tool: { toolId: string; name: string; description: string }
  supportedActions: string[]
  actionLabels: Record<string, string>
  roles: { role: string; actions: CeilingAction[] }[]
}

/**
 * The ceiling every department grant is clamped to.
 *
 * Same route as the manager's editor with `scope=global` — one editor, two
 * audiences, which is why the shape of this hook mirrors useDepartmentMatrix.
 * Only company admins are admitted; a manager gets a 403 per tool and sees an
 * empty grid rather than a wrong one.
 */
export function useCompanyCeiling() {
  const { token } = useAdminAuth()
  const { tools: inventory, loading: inventoryLoading } = useToolInventory()
  const [tools, setTools] = useState<CeilingTool[]>([])
  const [loading, setLoading] = useState(true)
  const [refused, setRefused] = useState(false)

  const load = useCallback(async () => {
    if (!token) { setLoading(false); return }
    if (inventoryLoading) return
    try {
      // Only tools this admin may actually govern globally — listing one that
      // cannot be edited is a row whose switches silently do nothing.
      const governable = inventory.filter((t) => t.managementScopes.some((s) => s.kind === 'global'))
      if (governable.length === 0) { setTools([]); setRefused(true); setLoading(false); return }
      const snapshots = await Promise.all(governable.map((t) =>
        api.get<CeilingTool>(
          `/api/desktop/auth/tools/${t.tool.toolId}/manage?scope=global`, token, { quiet: true, raw: true },
        ).catch(() => null),
      ))
      setTools(snapshots.filter((s): s is CeilingTool => s !== null))
      setRefused(false)
    } catch (e) {
      // The inventory itself refuses a non-admin, which is the honest signal —
      // the per-tool reads below would only ever return an empty grid.
      setRefused(e instanceof ApiError && (e.status === 403 || e.status === 401))
      setTools([])
    } finally {
      setLoading(false)
    }
  }, [token, inventory, inventoryLoading])

  useEffect(() => { void load() }, [load])

  const reloadTool = useCallback(async (toolId: string) => {
    if (!token) return
    const fresh = await api.get<CeilingTool>(
      `/api/desktop/auth/tools/${toolId}/manage?scope=global`, token, { quiet: true, raw: true },
    )
    setTools((prev) => prev.map((t) => (t.tool.toolId === toolId ? fresh : t)))
  }, [token])

  const setCeiling = useCallback(async (toolId: string, role: string, actionGroup: string, enabled: boolean) => {
    if (!token) return
    await api.put(
      `/api/desktop/auth/tools/${toolId}/global/roles/${role}/actions/${actionGroup}`,
      { enabled }, token, { raw: true },
    )
    await reloadTool(toolId)
  }, [token, reloadTool])

  return { tools, loading, refused, refresh: load, setCeiling }
}

/* ── Formatting shared by the company screens ─────────── */

/** "4 minutes ago", or an absolute date once it stops being useful. */
export function ago(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "3m 41s". Null while a run is still going, which the caller renders as live. */
export function durationLabel(ms: number | null): string | null {
  if (ms === null) return null
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

export const initialsOf = (name: string | null, email: string) =>
  (name ?? email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')

export const displayName = (name: string | null, email: string | null) =>
  name ?? email?.split('@')[0] ?? '—'

export const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  COMPANY_ADMIN: 'Company admin',
  MEMBER: 'Member',
}
