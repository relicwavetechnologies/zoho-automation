import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"
import type { ApiListState, JsonRecord } from "@/components/admin/types"

const unwrapArray = <T extends JsonRecord>(value: unknown, keys: string[] = []): T[] => {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as T[]
    }
    for (const fallback of ["items", "rows", "data", "runs", "logs", "departments"]) {
      if (Array.isArray(record[fallback])) return record[fallback] as T[]
    }
  }
  return []
}

export function useApiList<T extends JsonRecord>(path: string | null, token: string | null, keys: string[] = []): ApiListState<T> {
  const keySignature = keys.join(",")
  const scope = getAdminQueryScope(token)
  const query = useQuery({
    queryKey: adminQueryKeys.apiList(scope, path, keySignature),
    enabled: Boolean(path && token),
    queryFn: async () => {
      const value = await api.get<unknown>(path!, token!)
      return unwrapArray<T>(value, keySignature ? keySignature.split(",") : [])
    },
  })

  return {
    data: query.data ?? [],
    loading: query.isPending,
    refreshing: query.isFetching && !query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: async () => {
      await query.refetch()
    },
  }
}
