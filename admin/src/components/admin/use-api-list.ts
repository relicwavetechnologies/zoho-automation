import { useEffect, useState } from "react"
import { api } from "@/lib/api"
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
  const [state, setState] = useState<ApiListState<T>>({ data: [], loading: Boolean(path && token), error: null })
  const keySignature = keys.join(",")

  useEffect(() => {
    let cancelled = false
    if (!path || !token) {
      setState({ data: [], loading: false, error: null })
      return
    }

    setState((current) => ({ ...current, loading: true, error: null }))
    api
      .get<unknown>(path, token)
      .then((value) => {
        if (!cancelled) setState({ data: unwrapArray<T>(value, keySignature ? keySignature.split(",") : []), loading: false, error: null })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Request failed"
        if (!cancelled) setState({ data: [], loading: false, error: message })
      })

    return () => {
      cancelled = true
    }
  }, [keySignature, path, token])

  return state
}
