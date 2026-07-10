import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { getAdminQueryScope } from "@/lib/query-client"

/*
 * Proxy control plane — REAL data from /api/admin/proxy.
 *
 * The DeepSeek key lives encrypted server-side; the desktop never holds it. These
 * hooks drive the Guardrails key card + header status. `companyId` is only needed
 * for SUPER_ADMIN callers (use useCompanyScope()).
 */

export type KeyScope = "platform" | "company"
export type KeySource = "company" | "platform" | "env"

export interface ProxyStatus {
  enabled: boolean
  configured: boolean
  source: KeySource | null
  scope: KeyScope | null
  keyLast4: string | null
  keyMasked: string | null
  status: "active" | "disabled" | null
  keyError: "unreadable" | null
  lastUsedAt: string | null
  upstream: string
  canEncrypt: boolean
}

/** Derived, human-facing status the header pill + key card render from. */
export type ProxyState = "not_configured" | "active" | "paused" | "disabled"
export function proxyState(s: ProxyStatus | undefined): ProxyState {
  if (!s) return "disabled"
  if (!s.enabled) return "disabled"
  if (!s.configured) return "not_configured"
  return s.status === "disabled" ? "paused" : "active"
}

const scoped = (path: string, companyId?: string): string =>
  companyId ? `${path}?companyId=${encodeURIComponent(companyId)}` : path

const statusKey = (scope: string, companyId?: string) =>
  ["admin", scope, "proxy-status", companyId ?? ""] as const

export function useProxyStatus(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: statusKey(scope, companyId),
    enabled: Boolean(token),
    queryFn: () => api.get<ProxyStatus>(scoped("/api/admin/proxy/status", companyId), token!),
  })
}

export function useSaveProxyKey(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, keyScope }: { key: string; keyScope: KeyScope }) =>
      api.put<ProxyStatus>("/api/admin/proxy/key", { key, scope: keyScope, companyId }, token!),
    onSuccess: (data) => {
      qc.setQueryData(statusKey(scope, companyId), data)
      void qc.invalidateQueries({ queryKey: statusKey(scope, companyId) })
    },
  })
}

export function useRemoveProxyKey(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ keyScope }: { keyScope: KeyScope }) =>
      api.delete<ProxyStatus>("/api/admin/proxy/key", { scope: keyScope, companyId }, token!),
    onSuccess: (data) => {
      qc.setQueryData(statusKey(scope, companyId), data)
      void qc.invalidateQueries({ queryKey: statusKey(scope, companyId) })
    },
  })
}

// ─── Proxy health metrics ─────────────────────────────────────────────────────
export interface ProxyMetrics {
  requests24h: number
  requestsToday: number
  errorRatePct: number
  avgLatencyMs: number
  tokensPerMin: number
  lastUsedAt: string | null
}

export function useProxyMetrics(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "proxy-metrics", companyId ?? ""] as const,
    enabled: Boolean(token),
    refetchInterval: 15_000,
    queryFn: () => api.get<ProxyMetrics>(scoped("/api/admin/proxy/metrics", companyId), token!),
  })
}

// ─── Live audit feed ──────────────────────────────────────────────────────────
export type AuditDecision = "allowed" | "denied"
export interface AuditEntry {
  id: string
  createdAt: string
  userId: string
  user: string
  model: string
  tokens: number
  costUsd: number
  latencyMs: number
  decision: AuditDecision
  reason: string | null
  httpStatus: number
}

export function useProxyAudit(
  token: string | null,
  companyId?: string,
  opts?: { limit?: number; decision?: AuditDecision; userId?: string },
) {
  const scope = getAdminQueryScope(token)
  const params = new URLSearchParams()
  if (companyId) params.set("companyId", companyId)
  if (opts?.limit) params.set("limit", String(opts.limit))
  if (opts?.decision) params.set("decision", opts.decision)
  if (opts?.userId) params.set("userId", opts.userId)
  const qs = params.toString()
  return useQuery({
    queryKey: ["admin", scope, "proxy-audit", companyId ?? "", opts?.decision ?? "all", opts?.userId ?? "all", opts?.limit ?? 50] as const,
    enabled: Boolean(token),
    refetchInterval: 15_000,
    queryFn: () => api.get<AuditEntry[]>(`/api/admin/proxy/audit${qs ? `?${qs}` : ""}`, token!),
  })
}
