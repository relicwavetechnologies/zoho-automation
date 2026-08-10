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
import { useToolInventory, type InventoryEntry } from './use-tools'

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

/**
 * What to call a run when nothing has named it.
 *
 * Three screens each wrote `summary ?? entrypoint`, and `entrypoint` is the
 * name of the container the work ran in — so a member's Recent list was five
 * rows all reading "pi", which is both meaningless to them and an internal
 * detail they were never meant to see. Every run in the dev database has a null
 * summary, so this is not the rare path: it is the only one.
 *
 * Where it came from is the one true thing left, and it is worth more than the
 * container's name. The wording matches `CHANNEL_WORD` on the run-detail page.
 */
const CHANNEL_TITLE: Record<string, string> = {
  lark: 'Asked in Lark',
  desktop: 'Asked on the desktop',
  api: 'Asked over the API',
}

export const runTitle = (run: { summary: string | null; channel: string }): string =>
  run.summary?.trim() || CHANNEL_TITLE[run.channel] || 'Something you asked Divo'

/** Percentage change between two windows, guarding the divide by zero. */
export const changePct = (now: number, before: number): number =>
  before === 0 ? (now > 0 ? 100 : 0) : Math.round(((now - before) / before) * 100)

/* ── What Divo may do for me ──────────────────────────── */

export type MyTool = {
  tool: InventoryEntry['tool']
  /** Union of what every origin allows — what this person can actually use. */
  allowedActions: string[]
  actionLabels: Record<string, string>
  origins: { kind: string; departmentName?: string }[]
  readiness: string
  /** False for Local/System tools, which are policy-fixed and not grantable. */
  configurable: boolean
}

/**
 * This person's own view of the inventory.
 *
 * Derived from the shared fetch rather than a second request: the origins are
 * the answer to "why can I do this", and they must be the same origins the rest
 * of the app reasons about.
 */
export function useMyTools() {
  // `failed` is carried through, not swallowed. The inventory hook keeps it
  // apart from an empty list for a reason: dropping it here is what let a
  // failed fetch render as "Divo cannot do anything on your behalf yet", which
  // sends someone to their manager about a permission problem they do not have.
  const { tools, loading, failed, refresh } = useToolInventory()
  const inventory: MyTool[] = tools.map((entry) => {
    const actions = Array.from(new Set(entry.origins.flatMap((o) => o.allowedActions ?? [])))
    return {
      tool: entry.tool,
      allowedActions: actions,
      // The catalogue phrases actions per tool; without a label the raw verb is
      // still readable, which beats hiding the row.
      actionLabels: Object.fromEntries(actions.map((a) => [a, `${a} ${entry.tool.name.toLowerCase()}`])),
      origins: entry.origins.map((o) => ({
        kind: o.kind,
        ...(o.department ? { departmentName: o.department.name } : {}),
      })),
      readiness: entry.readiness,
      configurable: entry.origins.every((o) => o.kind !== 'system' && o.kind !== 'local'),
    }
  })
  return { inventory, loading, failed, refresh }
}

/* ── Which models this person may pick ────────────────── */

export type ModelOption = { id: string; label: string; provider: string; vision: boolean }

/**
 * The models the proxy will actually accept for the signed-in person.
 *
 * Intersects the catalogue with their own policy. Offering a model the proxy
 * refuses turns a settings screen into a way to break your own next task, so
 * the list is what is permitted rather than what exists.
 */
export function useMyModelOptions() {
  const { token } = useAdminAuth()
  const [allowedModels, setAllowed] = useState<ModelOption[]>([])
  const [blocked, setBlocked] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let live = true
    void (async () => {
      try {
        // One member-scoped call, labels included.
        //
        // This used to pair `/model-options` with `/api/admin/proxy/models` for
        // the labels — a route behind adminAuth. For a plain member, who is
        // most of this screen's audience, that 403'd into a `.catch(() => [])`
        // and every model rendered as its raw id. The member route now carries
        // the catalogue fields itself.
        const mine = await api.get<{
          allowedModels: string[]
          models?: ModelOption[]
          blocked: boolean
        }>('/api/desktop/auth/model-options', token, { quiet: true })
        if (!live) return
        const byId = new Map((mine.models ?? []).map((m) => [m.id, m]))
        setAllowed(mine.allowedModels.map((id) =>
          byId.get(id) ?? { id, label: id, provider: 'unknown', vision: false }))
        setBlocked(mine.blocked)
      } catch {
        if (live) setAllowed([])
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token])

  return { allowedModels, blocked, loading }
}
