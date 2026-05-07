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
  agents: (scope: string) => ["admin", scope, "agents"] as const,
  toolRegistry: (scope: string) => ["admin", scope, "tool-registry"] as const,
  departments: (scope: string) => ["admin", scope, "departments"] as const,
  departmentDetails: (scope: string) =>
    ["admin", scope, "department-details"] as const,
  executionRun: (scope: string, runId: string) =>
    ["admin", scope, "execution-run", runId] as const,
  executionEvents: (scope: string, runId: string) =>
    ["admin", scope, "execution-events", runId] as const,
}
