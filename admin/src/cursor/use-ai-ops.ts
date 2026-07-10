import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { getAdminQueryScope } from "@/lib/query-client"
import type { RunStatus } from "@/cursor/data"

/*
 * AI Ops — REAL data.
 *   Runs table → GET /api/admin/executions (enriched list: userName, turns,
 *                tokens, costUsd per run — see execution-query.service.ts).
 *   KPIs       → GET /api/admin/analytics/overview?days=1 (24h window).
 * Cost is still the backend's blended estimate; legit per-model pricing is
 * Track B. The other AI Ops tabs (Cost/Spend/Token/Models/Runtime) are wired
 * separately.
 */

interface RunSummaryDto {
  id: string
  status: string
  channel: string
  entrypoint: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  userId: string | null
  userName: string | null
  turns: number
  tokens: number
  costUsd: number | null
}

export interface RunRowView {
  id: string
  shortId: string
  user: string
  channel: string
  status: RunStatus
  turns: number
  tokensLabel: string
  costLabel: string
  durationLabel: string
  startedLabel: string
}

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(Math.round(n)))
const toStatus = (s: string): RunStatus => (s === "completed" ? "ok" : s === "failed" ? "err" : "run")
const timeLabel = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function toRow(r: RunSummaryDto): RunRowView {
  return {
    id: r.id,
    shortId: r.id.slice(0, 8),
    user: r.userName ?? "—",
    channel: r.channel,
    status: toStatus(r.status),
    turns: r.turns,
    tokensLabel: compact(r.tokens),
    costLabel: r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "—",
    durationLabel: r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—",
    startedLabel: timeLabel(r.startedAt),
  }
}

export function useRuns(
  token: string | null,
  filters: { channel?: string; status?: string; userId?: string; limit?: number } = {},
) {
  const scope = getAdminQueryScope(token)
  const params = new URLSearchParams({ limit: String(filters.limit ?? 50) })
  if (filters.channel) params.set("channel", filters.channel)
  if (filters.status) params.set("status", filters.status)
  if (filters.userId) params.set("userId", filters.userId)
  const qs = params.toString()

  return useQuery({
    queryKey: ["admin", scope, "ai-ops-runs", qs] as const,
    enabled: Boolean(token),
    queryFn: async (): Promise<RunRowView[]> => {
      const runs = await api.get<RunSummaryDto[]>(`/api/admin/executions?${qs}`, token!)
      return runs.map(toRow)
    },
  })
}

// ─── KPIs (analytics overview, 24h) ──────────────────────────────────────────

interface OverviewDto {
  executions: { total: number }
  successRate: number
  tokens: { estimatedCostUsd: number }
}

export interface AiOpsKpis {
  spend24h: string
  runs24h: number
  avgPerRun: string
  errors: number
  errorPct: string
  cacheNote: string
  avgNote: string
}

// ─── Runtime tab (runs surfaced as "tasks") ──────────────────────────────────
export function useRuntimeTasks(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const suffix = companyId ? `&companyId=${encodeURIComponent(companyId)}` : ""
  return useQuery({
    queryKey: ["admin", scope, "runtime-tasks", companyId ?? ""] as const,
    enabled: Boolean(token),
    queryFn: async (): Promise<RunRowView[]> => {
      const runs = await api.get<RunSummaryDto[]>(`/api/admin/runtime/tasks?limit=50${suffix}`, token!)
      return runs.map(toRow)
    },
  })
}

// ─── Token Usage tab ─────────────────────────────────────────────────────────
export interface TokenUsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  callCount: number
  byModel: { modelId: string; provider: string; calls: number; inputTokens: number; outputTokens: number }[]
}
export interface TokenUsageMember {
  userId: string
  name: string | null
  email: string | null
  totalTokens: number
  calls: number
  monthlyLimit: number
  usagePct: number
}

export function useTokenUsageSummary(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const suffix = companyId ? `&companyId=${encodeURIComponent(companyId)}` : ""
  return useQuery({
    queryKey: ["admin", scope, "token-usage-summary", companyId ?? ""] as const,
    enabled: Boolean(token),
    queryFn: () => api.get<TokenUsageSummary>(`/api/admin/token-usage/summary?days=30${suffix}`, token!),
  })
}

export function useTokenUsageMembers(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const suffix = companyId ? `&companyId=${encodeURIComponent(companyId)}` : ""
  return useQuery({
    queryKey: ["admin", scope, "token-usage-members", companyId ?? ""] as const,
    enabled: Boolean(token),
    queryFn: async (): Promise<TokenUsageMember[]> => {
      const res = await api.get<{ members: TokenUsageMember[] }>(`/api/admin/token-usage/members?days=30${suffix}`, token!)
      return res.members
    },
  })
}

// ─── Models tab (routing targets, super-admin) ───────────────────────────────
export interface ModelTarget {
  id: string
  targetKey: string
  provider: string
  modelId: string
  thinkingLevel?: string | null
  fastProvider?: string | null
  fastModelId?: string | null
  xtremeProvider?: string | null
  xtremeModelId?: string | null
  updatedAt?: string
}

export function useModelTargets(token: string | null) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "model-targets"] as const,
    enabled: Boolean(token),
    queryFn: () => api.get<ModelTarget[]>("/api/admin/ai-models", token!),
  })
}

export function useAiOpsKpis(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const suffix = companyId ? `&companyId=${encodeURIComponent(companyId)}` : ""
  return useQuery({
    queryKey: ["admin", scope, "ai-ops-kpis", companyId ?? ""] as const,
    enabled: Boolean(token),
    queryFn: async (): Promise<AiOpsKpis> => {
      const o = await api.get<OverviewDto>(`/api/admin/analytics/overview?days=1${suffix}`, token!)
      const total = o.executions.total
      const cost = o.tokens.estimatedCostUsd
      // successRate may be a fraction (0–1) or a percent (0–100) depending on
      // the endpoint; normalise defensively before deriving the error count.
      const sr = o.successRate > 1 ? o.successRate / 100 : o.successRate
      const errors = Math.max(0, Math.round(total * (1 - sr)))
      return {
        spend24h: `$${cost.toFixed(2)}`,
        runs24h: total,
        avgPerRun: total > 0 ? `$${(cost / total).toFixed(4)}` : "$0.00",
        errors,
        errorPct: total > 0 ? `${((errors / total) * 100).toFixed(1)}% of runs` : "0% of runs",
        cacheNote: "estimated cost",
        avgNote: "per run · 24h",
      }
    },
  })
}
