/**
 * This person's own usage and runs.
 *
 * Both endpoints pin every query to the signed-in user server-side — there is
 * no userId to pass and no way to ask about somebody else, which is why these
 * hooks take no arguments beyond a window.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

export type UsagePoint = { date: string; spendUsd: number }

export type MyUsage = {
  days: number
  spendUsd: number
  spendTodayUsd: number
  runs: number
  previousRuns: number
  tokensIn: number
  tokensOut: number
  cacheSavingsPct: number
  series: UsagePoint[]
  byModel: { modelId: string; calls: number; costUsd: number }[]
}

export type MyRun = {
  id: string
  channel: string
  entrypoint: string
  status: string
  summary: string | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  costUsd: number
}

const EMPTY: MyUsage = {
  days: 30, spendUsd: 0, spendTodayUsd: 0, runs: 0, previousRuns: 0,
  tokensIn: 0, tokensOut: 0, cacheSavingsPct: 0, series: [], byModel: [],
}

export function useMyUsage(days = 30) {
  const { token } = useAdminAuth()
  const [usage, setUsage] = useState<MyUsage>(EMPTY)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let live = true
    void (async () => {
      try {
        const data = await api.get<MyUsage>(`/api/desktop/me/usage?days=${days}`, token, { quiet: true })
        if (live) setUsage(data)
      } catch {
        // Falls back to zeroes rather than throwing. An empty usage panel is a
        // truthful answer for somebody who has not used Divo yet, and it is
        // also the least alarming thing to show if the query failed.
        if (live) setUsage({ ...EMPTY, days })
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token, days])

  return { usage, loading }
}

export function useMyRuns(limit = 20) {
  const { token } = useAdminAuth()
  const [runs, setRuns] = useState<MyRun[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let live = true
    void (async () => {
      try {
        const data = await api.get<{ runs: MyRun[] }>(`/api/desktop/me/runs?limit=${limit}`, token, { quiet: true })
        if (live) setRuns(data.runs ?? [])
      } catch {
        if (live) setRuns([])
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token, limit])

  return { runs, loading }
}

/** "3m 41s", or null while a run is still going. */
export const durationLabel = (ms: number | null): string | null => {
  if (ms === null) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

/** Percentage change between two windows, guarding the divide by zero. */
export const changePct = (now: number, before: number): number =>
  before === 0 ? (now > 0 ? 100 : 0) : Math.round(((now - before) / before) * 100)

/* ── What Divo may do for me ──────────────────────────── */

export type ToolOrigin = {
  kind: 'global' | 'department' | 'system' | 'local'
  departmentName?: string
  allowedActions?: string[]
}

export type MyTool = {
  tool: { toolId: string; name: string; description: string; category: string; domain: string }
  /** Union of what every origin allows — what this person can actually use. */
  allowedActions: string[]
  actionLabels: Record<string, string>
  origins: ToolOrigin[]
  readiness: string
  /** False for Local/System tools, which are policy-fixed and not grantable. */
  configurable: boolean
}

type InventoryWire = {
  tools: {
    tool: { toolId: string; name: string; description: string; category: string; domain: string }
    origins: { kind: string; department?: { id: string; name: string }; allowedActions?: string[] }[]
    readiness: string
  }[]
}

/**
 * The signed-in person's own tool inventory.
 *
 * Reports, per tool, which actions are in effect for them and which origin each
 * came from — their company role, or a named department. That provenance is the
 * answer to "why can I do this", and it is the only place the product states it
 * for a member rather than for their manager.
 */
export function useMyTools() {
  const { token } = useAdminAuth()
  const [inventory, setInventory] = useState<MyTool[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let live = true
    void (async () => {
      try {
        const data = await api.get<InventoryWire>('/api/desktop/auth/tools', token, { quiet: true, raw: true })
        if (!live) return
        setInventory(data.tools.map((entry) => {
          const actions = Array.from(new Set(entry.origins.flatMap((o) => o.allowedActions ?? [])))
          return {
            tool: entry.tool,
            allowedActions: actions,
            // The catalogue phrases actions per tool; without a label the raw
            // verb is still readable, which beats hiding the row.
            actionLabels: Object.fromEntries(actions.map((a) => [a, `${a} ${entry.tool.name.toLowerCase()}`])),
            origins: entry.origins.map((o) => ({
              kind: o.kind as ToolOrigin['kind'],
              ...(o.department ? { departmentName: o.department.name } : {}),
              ...(o.allowedActions ? { allowedActions: o.allowedActions } : {}),
            })),
            readiness: entry.readiness,
            configurable: entry.origins.every((o) => o.kind !== 'system' && o.kind !== 'local'),
          }
        }))
      } catch {
        if (live) setInventory([])
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token])

  return { inventory, loading }
}
