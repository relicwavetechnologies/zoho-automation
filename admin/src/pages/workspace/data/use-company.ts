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
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

const base = '/api/admin'

/** Every hook here follows the same shape, so this carries the boilerplate. */
function useAdminResource<T>(path: string | null, fallback: T) {
  const { token } = useAdminAuth()
  const [data, setData] = useState<T>(fallback)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token || !path) { setLoading(false); return }
    try {
      setData(await api.get<T>(`${base}${path}`, token, { quiet: true }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this.')
      setData(fallback)
    } finally {
      setLoading(false)
    }
    // `fallback` is a literal at every call site; including it would reload forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, path])

  useEffect(() => { void load() }, [load])

  return { data, loading, error, refresh: load }
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

/* ── Spend ────────────────────────────────────────────── */

export type SpendDaily = {
  today: { spendUsd: number; runs: number }
  series: { date: string; spendUsd: number }[]
  cacheSavingsPct: number
}

export type SpendModel = {
  modelId: string
  provider: string
  calls: number
  cacheMissIn: number
  cacheHitIn: number
  output: number
  costUsd: number
}

export type SpendMember = {
  userId: string
  name: string | null
  email: string | null
  tokens: number
  spend30d: number
  spendToday: number
  runs: number
  monthlyLimit: number
  usagePct: number
}

export type SpendMembers = {
  members: SpendMember[]
  totals: {
    memberCount: number
    spend30d: number
    topSpender: { name: string; amount: number } | null
    overLimit: { count: number; name: string | null; pct: number | null }
  }
}

const EMPTY_SPEND_MEMBERS: SpendMembers = {
  members: [],
  totals: { memberCount: 0, spend30d: 0, topSpender: null, overLimit: { count: 0, name: null, pct: null } },
}

/** `channel` narrows to one surface; the route accepts it and omits the filter otherwise. */
export const useSpendDaily = (days = 30, channel?: string) =>
  useAdminResource<SpendDaily>(
    `/spend/company-daily?days=${days}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`,
    { today: { spendUsd: 0, runs: 0 }, series: [], cacheSavingsPct: 0 },
  )

export const useSpendByModel = (days = 30) =>
  useAdminResource<SpendModel[]>(`/spend/by-model?days=${days}`, [])

export const useSpendByMember = (days = 30) =>
  useAdminResource<SpendMembers>(`/spend/members?days=${days}`, EMPTY_SPEND_MEMBERS)

/* ── Directory ────────────────────────────────────────── */

export type DirectoryEntry = {
  userId: string
  name: string | null
  email: string
  companyRole: string
  larkLinked: boolean
  googleConnected: boolean
  larkOpenId: string | null
  larkDisplayName: string | null
  departmentCount: number
  managerDepartmentCount: number
  departmentNames: string[]
  createdAt: string
  updatedAt: string
}

export const useDirectory = () => useAdminResource<DirectoryEntry[]>('/company/directory', [])

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

export const useCompanyDepartments = () => useAdminResource<CompanyDepartment[]>('/departments', [])

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
  const [tools, setTools] = useState<CeilingTool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) { setLoading(false); return }
    try {
      const inventory = await api.get<{ tools: { tool: { toolId: string }; managementScopes: { kind: string }[] }[] }>(
        '/api/desktop/auth/tools', token, { quiet: true, raw: true },
      )
      // Only tools this admin may actually govern globally — listing one that
      // cannot be edited is a row whose switches silently do nothing.
      const governable = inventory.tools.filter((t) => t.managementScopes.some((s) => s.kind === 'global'))
      const snapshots = await Promise.all(governable.map((t) =>
        api.get<CeilingTool>(
          `/api/desktop/auth/tools/${t.tool.toolId}/manage?scope=global`, token, { quiet: true, raw: true },
        ).catch(() => null),
      ))
      setTools(snapshots.filter((s): s is CeilingTool => s !== null))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the company ceiling.')
      setTools([])
    } finally {
      setLoading(false)
    }
  }, [token])

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

  return { tools, loading, error, refresh: load, setCeiling }
}

/* ── Provider keys and per-person limits ──────────────── */

export type ProxyKeyStatus = {
  provider: string
  configured: boolean
  source: string | null
  scope: 'platform' | 'company' | null
  keyLast4: string | null
  keyMasked: string | null
  status: string | null
  /** Set when the stored key exists but will not decrypt — a false green otherwise. */
  keyError: 'unreadable' | null
  lastUsedAt: string | null
  desktopProxyEnabled: boolean
  upstream: string
  canEncrypt: boolean
}

export const useProxyStatus = (provider: string) =>
  useAdminResource<ProxyKeyStatus | null>(`/proxy/status?provider=${provider}`, null)

export type ProxyPolicy = {
  userId: string
  blocked: boolean
  monthlyBudgetUsd: number | null
  rateLimitRpm: number | null
  allowedModels: string[]
  /** No stored row — this person is on the company default. */
  isDefault: boolean
}

/**
 * Only members with an explicit policy have a row; everyone else is on the
 * default, which is why this returns a list to look up against rather than one
 * entry per person.
 */
export function useProxyPolicies() {
  const { token } = useAdminAuth()
  const resource = useAdminResource<ProxyPolicy[]>('/proxy-policy', [])

  const setPolicy = useCallback(async (userId: string, patch: Partial<Omit<ProxyPolicy, 'userId' | 'isDefault'>>) => {
    if (!token) return
    await api.put(`${base}/proxy-policy/${userId}`, patch, token)
    await resource.refresh()
  }, [token, resource])

  return { ...resource, setPolicy }
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
