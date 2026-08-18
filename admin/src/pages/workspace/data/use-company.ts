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
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, type DepartmentDetailSection } from '@/lib/api'
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
  /**
   * Only a real 404.
   *
   * Screens turn "no data" into a sentence about the world — "no such
   * department". That sentence is only true when the server said the thing does
   * not exist. Any other failure, a 400 from a malformed query most of all,
   * also arrives here as an empty `data`, and reporting it as "no such thing"
   * sends people looking at their database instead of at the request. Worth its
   * own flag rather than being inferred from emptiness.
   */
  const [notFound, setNotFound] = useState(false)

  /**
   * Which request is allowed to write into this state.
   *
   * Open department A, switch to B before A answers, and without this the two
   * responses race: whichever lands last wins. B usually resolves first over a
   * fast link, so A arrives second and paints A's members and permissions under
   * B's heading — with `loading` false, so it reads as settled rather than
   * stale. Every read stamps a generation and drops itself if a newer one has
   * started since.
   */
  const generation = useRef(0)

  const load = useCallback(async () => {
    if (!token || !path) {
      // A cleared selection must clear the answer too — otherwise the previous
      // department stays on screen as though it were the current one.
      generation.current += 1
      setData(fallback)
      setLoading(false)
      return
    }
    const gen = ++generation.current
    setLoading(true)
    try {
      const next = await api.get<T>(`${base}${path}`, token, { quiet: true })
      if (generation.current !== gen) return
      setData(next)
      setError(null)
      setRefused(false)
      setNotFound(false)
    } catch (e) {
      if (generation.current !== gen) return
      setError(e instanceof Error ? e.message : 'Could not load this.')
      setRefused(e instanceof ApiError && (e.status === 403 || e.status === 401))
      setNotFound(e instanceof ApiError && e.status === 404)
      setData(fallback)
    } finally {
      if (generation.current === gen) setLoading(false)
    }
    // `fallback` is a literal at every call site; including it would reload forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, path])

  useEffect(() => { void load() }, [load])

  return { data, loading, error, refused, notFound, refresh: load }
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
/**
 * Typed, not a hand-written string.
 *
 * This list used to be spelled out inline and said `memberships` where the
 * backend's enum says `members`. The route parses each section with `z.enum`
 * and throws on anything it does not recognise, so every department detail
 * page 400'd — and the screen reported that as "No such department". Naming the
 * union here makes a typo a compile error instead of a lie about the data.
 */
const DETAIL_SECTIONS: DepartmentDetailSection[] = ['roles', 'members', 'permissions', 'config']

export const useDepartmentDetail = (departmentId?: string) =>
  useAdminResource<DepartmentDetail | null>(
    departmentId ? `/departments/${departmentId}?sections=${DETAIL_SECTIONS.join(',')}` : null,
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
