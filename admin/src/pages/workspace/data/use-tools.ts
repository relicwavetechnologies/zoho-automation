/**
 * The signed-in person's tool inventory — read once, read here.
 *
 * Two very different screens need this payload: a member asking what Divo may
 * do for them, and an admin asking which tools they may govern at company
 * level. Both were fetching `/api/desktop/auth/tools` separately, which is two
 * answers to one question and two chances to disagree. The fetch lives here and
 * the two views are derived from it.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

export type ToolOrigin = {
  kind: 'global' | 'department' | 'system' | 'local'
  department?: { id: string; name: string }
  allowedActions?: string[]
}

export type InventoryEntry = {
  tool: { toolId: string; name: string; description: string; category: string; domain: string }
  origins: ToolOrigin[]
  managementScopes: { kind: string; department?: { id: string; name: string } }[]
  readiness: string
}

export function useToolInventory() {
  const { token } = useAdminAuth()
  const [tools, setTools] = useState<InventoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  // Distinct from an empty list: "the fetch failed" and "you may govern nothing"
  // look identical downstream otherwise, and one of those is retryable.
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!token) return
    let live = true
    void (async () => {
      try {
        const data = await api.get<{ tools: InventoryEntry[] }>(
          '/api/desktop/auth/tools', token, { quiet: true, raw: true },
        )
        if (live) { setTools(data.tools); setFailed(false) }
      } catch {
        // The route answers every signed-in member, so a failure here is never a
        // permission problem — it is something to retry.
        if (live) { setTools([]); setFailed(true) }
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token])

  return { tools, loading, failed }
}
