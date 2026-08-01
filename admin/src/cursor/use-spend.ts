import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { getAdminQueryScope } from "@/lib/query-client"
import { useAdminAuth } from "@/auth/AdminAuthProvider"

/** companyId to send on admin queries — required for SUPER_ADMIN, omitted otherwise. */
export function useCompanyScope(): string | undefined {
  const { session } = useAdminAuth()
  return session?.role === "SUPER_ADMIN" ? session.companyId ?? undefined : undefined
}

/*
 * Spend / directory data hooks — REAL data from /api/admin/spend + /company/directory.
 * Cost is reconstructed from canonical per-model pricing in the backend.
 *
 * `companyId` is only needed for SUPER_ADMIN callers (the backend's
 * resolveCompanyId requires it); company-admins resolve from their session. Use
 * useCompanyScope() in a page to derive it from the session.
 */

export const usd = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
export const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(Math.round(n)))

const scoped = (path: string, params: Record<string, string | number | undefined>): string => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v))
  const q = u.toString()
  return q ? `${path}?${q}` : path
}

// ─── Directory (identity) ─────────────────────────────────────────────────────
/**
 * The whole directory row, not a slice of it.
 *
 * It was declared as the five fields one page happened to read, which meant the
 * next screen that needed `larkLinked` had to either widen this or build a
 * second hook over the same route. The route returns all of this; the type says
 * so now.
 */
export interface DirectoryMember {
  userId: string
  name: string | null
  email: string
  companyRole: string
  /** No Lark identity means Divo in Lark cannot recognise them. */
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

export function useDirectory(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "directory", companyId ?? ""] as const,
    enabled: Boolean(token),
    queryFn: () => api.get<DirectoryMember[]>(scoped("/api/admin/company/directory", { companyId }), token!),
  })
}

// ─── Company daily (Overview) ─────────────────────────────────────────────────
export interface CompanyDaily {
  today: { spendUsd: number; runs: number }
  series: { date: string; spendUsd: number }[]
  cacheSavingsPct: number
}

export function useCompanyDaily(token: string | null, days = 14, companyId?: string, channel?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "spend-company-daily", days, companyId ?? "", channel ?? "all"] as const,
    enabled: Boolean(token),
    queryFn: () => api.get<CompanyDaily>(scoped("/api/admin/spend/company-daily", { days, companyId, channel }), token!),
  })
}

// ─── Per-model (AI Ops Cost) ──────────────────────────────────────────────────
export interface ModelSpend {
  modelId: string
  provider: string
  calls: number
  cacheMissIn: number
  cacheHitIn: number
  output: number
  costUsd: number
}

export function useSpendByModel(token: string | null, days = 30, companyId?: string, channel?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "spend-by-model", days, companyId ?? "", channel ?? "all"] as const,
    enabled: Boolean(token),
    queryFn: () => api.get<ModelSpend[]>(scoped("/api/admin/spend/by-model", { days, companyId, channel }), token!),
  })
}

// ─── Per-member (People list + AI Ops Spend) ──────────────────────────────────
export interface MemberSpend {
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
export interface MembersSpendResponse {
  members: MemberSpend[]
  totals: {
    memberCount: number
    spend30d: number
    topSpender: { name: string; amount: number } | null
    overLimit: { count: number; name: string | null; pct: number | null }
  }
}

export function useSpendMembers(token: string | null, days = 30, companyId?: string, channel?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "spend-members", days, companyId ?? "", channel ?? "all"] as const,
    enabled: Boolean(token),
    queryFn: () => api.get<MembersSpendResponse>(scoped("/api/admin/spend/members", { days, companyId, channel }), token!),
  })
}

// ─── Single member (Person detail) ────────────────────────────────────────────
export interface MemberDetailSpend {
  userId: string
  name: string | null
  email: string | null
  spendToday: number
  spend30d: number
  spendMtd: number
  avgPerRun: number
  tokens: number
  runs: number
  monthlyLimit: number
  usagePct: number
  sparkline: number[]
  costByModel: { modelId: string; runs: number; costUsd: number }[]
}

export function useMemberSpend(token: string | null, userId: string | undefined, days = 30, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "member-spend", userId ?? "none", days, companyId ?? ""] as const,
    enabled: Boolean(token && userId),
    queryFn: () => api.get<MemberDetailSpend>(scoped(`/api/admin/spend/members/${userId}`, { days, companyId }), token!),
  })
}
