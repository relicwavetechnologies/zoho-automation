import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { getAdminQueryScope } from "@/lib/query-client"

/*
 * Proxy control plane — REAL data from /api/admin/proxy.
 *
 * Provider keys live encrypted server-side, one per provider, and the desktop
 * never holds one. These hooks drive the Guardrails key cards + header status. `companyId` is only needed
 * for SUPER_ADMIN callers (use useCompanyScope()).
 */

export type KeyScope = "platform" | "company"
/* A key an admin saved is the only key — there is no server-env fallback. */
export type KeySource = "company" | "platform"

/** A provider an admin can hold a key for. One key card per entry. */
export type KeyProvider = "deepseek" | "openai"
export const KEY_PROVIDERS: ReadonlyArray<{ id: KeyProvider; label: string; hint: string }> = [
  { id: "deepseek", label: "DeepSeek", hint: "Serves Flash and Pro." },
  { id: "openai", label: "OpenAI", hint: "Serves Luna, the only model that can read an image." },
]

export interface ProxyModel {
  id: string
  label: string
  provider: KeyProvider
  vision: boolean
  inputPerMillionUsd: number
  outputPerMillionUsd: number
}

export interface ProxyStatus {
  provider: KeyProvider
  enabled: boolean
  desktopProxyEnabled: boolean
  larkEnabled: boolean
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

const scoped = (path: string, companyId?: string, provider?: KeyProvider): string => {
  const params = new URLSearchParams()
  if (companyId) params.set("companyId", companyId)
  if (provider) params.set("provider", provider)
  return params.size ? `${path}?${params}` : path
}

const statusKey = (scope: string, provider: KeyProvider, companyId?: string) =>
  ["admin", scope, "proxy-status", provider, companyId ?? ""] as const

export function useProxyStatus(token: string | null, provider: KeyProvider, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: statusKey(scope, provider, companyId),
    enabled: Boolean(token),
    queryFn: () => api.get<ProxyStatus>(scoped("/api/admin/proxy/status", companyId, provider), token!),
  })
}

/**
 * The models an admin can grant, best first.
 *
 * Served by the backend rather than listed here so that adding a model is one
 * edit. A second copy in the panel is how a member ends up granted something
 * the proxy has never heard of.
 */
export function useProxyModels(token: string | null) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "proxy-models"] as const,
    enabled: Boolean(token),
    staleTime: 5 * 60_000,
    queryFn: () => api.get<ProxyModel[]>("/api/admin/proxy/models", token!),
  })
}

export function useSaveProxyKey(token: string | null, provider: KeyProvider, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, keyScope }: { key: string; keyScope: KeyScope }) =>
      api.put<ProxyStatus>("/api/admin/proxy/key", { key, provider, scope: keyScope, companyId }, token!),
    onSuccess: (data) => {
      qc.setQueryData(statusKey(scope, provider, companyId), data)
      void qc.invalidateQueries({ queryKey: statusKey(scope, provider, companyId) })
    },
  })
}

export function useRemoveProxyKey(token: string | null, provider: KeyProvider, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ keyScope }: { keyScope: KeyScope }) =>
      api.delete<ProxyStatus>("/api/admin/proxy/key", { provider, scope: keyScope, companyId }, token!),
    onSuccess: (data) => {
      qc.setQueryData(statusKey(scope, provider, companyId), data)
      void qc.invalidateQueries({ queryKey: statusKey(scope, provider, companyId) })
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

export function useProxyMetrics(token: string | null, companyId?: string, channel?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "proxy-metrics", companyId ?? "", channel ?? "all"] as const,
    enabled: Boolean(token),
    refetchInterval: 15_000,
    queryFn: () => {
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      if (channel) params.set("channel", channel)
      return api.get<ProxyMetrics>(`/api/admin/proxy/metrics${params.size ? `?${params}` : ""}`, token!)
    },
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
  channel: string
  provider: string
  agentTarget: string
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
  opts?: { limit?: number; decision?: AuditDecision; userId?: string; channel?: string },
) {
  const scope = getAdminQueryScope(token)
  const params = new URLSearchParams()
  if (companyId) params.set("companyId", companyId)
  if (opts?.limit) params.set("limit", String(opts.limit))
  if (opts?.decision) params.set("decision", opts.decision)
  if (opts?.userId) params.set("userId", opts.userId)
  if (opts?.channel) params.set("channel", opts.channel)
  const qs = params.toString()
  return useQuery({
    queryKey: ["admin", scope, "proxy-audit", companyId ?? "", opts?.decision ?? "all", opts?.userId ?? "all", opts?.channel ?? "all", opts?.limit ?? 50] as const,
    enabled: Boolean(token),
    refetchInterval: 15_000,
    queryFn: () => api.get<AuditEntry[]>(`/api/admin/proxy/audit${qs ? `?${qs}` : ""}`, token!),
  })
}
