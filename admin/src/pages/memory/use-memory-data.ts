import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { memoriesApi } from "@/lib/api"

export type MemoryEntry = {
  id: string
  memory: string
  score?: number
  createdAt?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
}

export type MemoryStats = {
  totalUser: number
  totalDepartment: number
  totalCompany: number
}

export type MemoryFilters = {
  scope?: string
  userId?: string
  departmentId?: string
}

export type MemoryDataState = {
  memories: MemoryEntry[]
  stats: MemoryStats | null
  loading: boolean
  error: string | null
  filters: MemoryFilters
  setFilters: (f: MemoryFilters) => void
  refresh: () => void
  deleteMemory: (id: string) => Promise<void>
  deleteAllForUser: (userId: string) => Promise<void>
}

export function useMemoryData(): MemoryDataState {
  const { token } = useAdminAuth()
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFiltersState] = useState<MemoryFilters>({})

  const fetchAll = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string> = { limit: "100" }
      if (filters.scope) params.scope = filters.scope
      if (filters.userId) params.userId = filters.userId
      if (filters.departmentId) params.departmentId = filters.departmentId

      const [memData, statsData] = await Promise.all([
        memoriesApi.list(token, params),
        memoriesApi.stats(token),
      ])
      setMemories(Array.isArray(memData) ? memData : [])
      setStats(statsData && typeof statsData === "object" ? statsData : null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load memories"
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [token, filters])

  useEffect(() => { fetchAll() }, [fetchAll])

  const setFilters = (f: MemoryFilters) => {
    setFiltersState(f)
  }

  const deleteMemory = async (id: string) => {
    if (!token) return
    try {
      await memoriesApi.delete(id, token)
      toast.success("Memory deleted")
      await fetchAll()
    } catch { /* toast handled by api.ts */ }
  }

  const deleteAllForUser = async (userId: string) => {
    if (!token) return
    try {
      await memoriesApi.deleteAllForUser(userId, token)
      toast.success("All memories for user deleted")
      await fetchAll()
    } catch { /* toast handled by api.ts */ }
  }

  return { memories, stats, loading, error, filters, setFilters, refresh: fetchAll, deleteMemory, deleteAllForUser }
}
