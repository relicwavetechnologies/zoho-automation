import { QueryClient } from "@tanstack/react-query"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
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
