/**
 * The signed-in person's tool inventory — read once, read here.
 *
 * Two very different screens need this payload: a member asking what Divo may
 * do for them, and an admin asking which tools they may govern at company
 * level. Both were fetching `/api/desktop/auth/tools` separately, which is two
 * answers to one question and two chances to disagree. The fetch lives here and
 * the two views are derived from it.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

/**
 * Where every tool route lives — and it is not where it looks like it should be.
 *
 * The tools router is mounted under `/api/desktop/auth`, not `/api/desktop`,
 * because the desktop client prefixes `/auth` onto every tool path and moving
 * the router would take `GET /api/desktop/auth/tools` off the air mid-session.
 * server.ts says so where it mounts it.
 *
 * That surprise is exactly why this is a constant. The Team screens had built
 * their tool paths off a plain `/api/desktop`, so every permission read and
 * every toggle 404'd — and the matrix rendered the failure as "no configurable
 * tools", which reads as a fact about the team rather than a broken request.
 */
export const TOOLS_BASE = '/api/desktop/auth'

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

  // Bumped by `refresh`, which is the whole point of telling somebody a read
  // failed: the message is only worth showing if it comes with a way out.
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => { setAttempt((n) => n + 1) }, [])

  useEffect(() => {
    if (!token) return
    let live = true
    setLoading(true)
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
  }, [token, attempt])

  return { tools, loading, failed, refresh }
}
