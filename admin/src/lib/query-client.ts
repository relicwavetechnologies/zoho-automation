import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/api"

/**
 * Retry only what retrying can fix.
 *
 * `retry: 1` retried everything, including the answers that are settled: a 403
 * is a boundary and a 404 is a thing that is not there, and asking twice
 * returns the same answer twice. It cost a wasted round trip on every refused
 * query — and because the api layer speaks on each failed call, it also
 * produced two identical toasts a beat apart, which is what a page full of
 * refused reads looked like from the outside.
 *
 * 408 and 429 are the exceptions: both are the server saying "not now" rather
 * than "no".
 */
const RETRY_WORTH_IT = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 1) return false
  if (error instanceof ApiError) {
    if (error.status === 408 || error.status === 429) return true
    if (error.status >= 400 && error.status < 500) return false
  }
  return true
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: RETRY_WORTH_IT,
    },
    mutations: {
      retry: 0,
    },
  },
})

export function getAdminQueryScope(token: string | null) {
  return token ?? "anonymous"
}

export const adminQueryKeys = {
  apiList: (scope: string, path: string | null, keySignature: string) =>
    ["admin", scope, "api-list", path ?? "disabled", keySignature] as const,
  agentModelCatalog: (scope: string) =>
    ["admin", scope, "agent-model-catalog"] as const,
  aiProviderStatus: (scope: string) =>
    ["admin", scope, "ai-provider-status"] as const,
  toolRegistry: (scope: string) => ["admin", scope, "tool-registry"] as const,
  departments: (scope: string) => ["admin", scope, "departments"] as const,
  departmentDetails: (scope: string) =>
    ["admin", scope, "department-details"] as const,
  executionRun: (scope: string, runId: string) =>
    ["admin", scope, "execution-run", runId] as const,
  executionEvents: (scope: string, runId: string) =>
    ["admin", scope, "execution-events", runId] as const,
  skillRegistryTree: (scope: string, companyId: string, includeArchived: boolean) =>
    ["admin", scope, "skill-registry-tree", companyId, includeArchived] as const,
  skillDetail: (scope: string, skillId: string) =>
    ["admin", scope, "skill-detail", skillId] as const,
  skillAccess: (scope: string, skillId: string) =>
    ["admin", scope, "skill-access", skillId] as const,
  skillAudit: (scope: string, skillId: string) =>
    ["admin", scope, "skill-audit", skillId] as const,
}
