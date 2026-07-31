import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { getAdminQueryScope } from "@/lib/query-client"

export type WebSearchConnectionHealth =
  | "available"
  | "cooling_down"
  | "estimated_depleted"
  | "disabled"
  | "unavailable"

export interface WebSearchConnection {
  id: string
  company: { id: string; name: string }
  label: string
  status: string
  health: WebSearchConnectionHealth
  priority: number
  addedBy: { id: string; name: string | null; email: string } | null
  addedAt: string
  updatedAt: string
  lastTestedAt: string | null
  lastSucceededAt: string | null
  lastFailureAt: string | null
  lastFailureCode: string | null
  lastUsedAt: string | null
  unavailableUntil: string | null
  successfulRequestCount: number
  observedRequestsSinceCreditSync: number
  creditsAtLastSync: number | null
  creditsSyncedAt: string | null
  estimatedCreditsRemaining: number | null
}

export interface WebSearchConnectionsResponse {
  scope: { companyId: string | null; isSuperAdmin: boolean }
  summary: {
    companyCount: number
    connectionCount: number
    availableConnectionCount: number
    observedSearches: number
    balanceTrackedConnectionCount: number
  }
  connections: WebSearchConnection[]
}

export function useWebSearchConnections(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""
  return useQuery({
    queryKey: ["admin", scope, "web-search-connections", companyId ?? "all"] as const,
    enabled: Boolean(token),
    queryFn: () => api.get<WebSearchConnectionsResponse>(`/api/admin/web-search/connections${query}`, token!),
  })
}
