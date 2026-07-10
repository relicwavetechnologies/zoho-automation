import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"
import { costUsd } from "@/cursor/pricing"
import type { RunStatus, TraceTool } from "@/cursor/data"

/*
 * Run detail — REAL data. Reconstructs the trace view entirely from two existing
 * endpoints (no backend change):
 *   GET /api/admin/executions/:id         → header (RunDetailDto)
 *   GET /api/admin/executions/:id/events  → ordered event stream (EventDto[])
 *
 * Desktop/PI runs persist model calls (with usage) and tool calls (with I/O) as
 * ExecutionEvents; we fold the flat stream back into turns → {model, tools} and
 * sum tokens/cost client-side. Cost is the provider-reported `usage.cost` summed
 * per run (stored at ingest); legit DeepSeek-priced cost is Track B — swap the
 * `costUsd` source here when that lands, the view model stays the same.
 */

// ─── Backend DTOs (from execution-query.service.ts) ──────────────────────────
interface RunDetailDto {
  id: string
  status: string // "running" | "completed" | "failed"
  channel: string
  entrypoint: string
  latestSummary: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  userId: string | null
  userName: string | null
  threadId: string | null
  chatId: string | null
  agentTarget: string | null
}

interface EventDto {
  id: string
  sequence: number
  phase: string
  eventType: string
  actorType: string
  actorKey: string | null
  title: string
  summary: string | null
  status: string | null
  payload: unknown
  createdAt: string
}

interface ModelUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}

// ─── View model the page renders ─────────────────────────────────────────────
export interface RunTurnView {
  model: { modelName: string; input: number; output: number; cacheRead: number; costUsd: number } | null
  tools: TraceTool[]
}

export interface RunDetailView {
  id: string
  shortId: string
  status: RunStatus
  statusLabel: string
  channel: string
  entrypoint: string
  userId: string | null
  userName: string | null
  turns: RunTurnView[]
  totals: { turns: number; tokens: number; costUsd: number }
  composition: { missPct: number; hitPct: number; outPct: number }
  durationLabel: string
  ended: boolean
}

// ─── Pure reconstruction (exported for clarity/testing) ──────────────────────

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Best-effort subtitle for a tool step from its (possibly capped) input payload. */
function toolSubtitle(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>
    const op = rec.op ?? rec.query ?? rec.action ?? rec.path
    if (typeof op === "string") return op
  }
  return undefined
}

/** Map a tool name to one of the pastel timeline stages. */
function stageFor(toolName: string): TraceTool["stage"] {
  const n = toolName.toLowerCase()
  if (/resolve|search|grep|find|lookup|list/.test(n)) return "grep"
  if (/write|create|update|send|delete|edit|patch|insert|move/.test(n)) return "edit"
  return "read"
}

const STATUS: Record<string, { s: RunStatus; label: string }> = {
  completed: { s: "ok", label: "completed" },
  failed: { s: "err", label: "failed" },
  running: { s: "run", label: "running" },
}

export function reconstructRun(detail: RunDetailDto, events: EventDto[]): RunDetailView {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  const turns: RunTurnView[] = []
  let current: RunTurnView | null = null
  let ended = false

  const ensureTurn = () => {
    if (!current) {
      current = { model: null, tools: [] }
      turns.push(current)
    }
    return current
  }

  for (const ev of sorted) {
    if (ev.eventType === "turn_start") {
      current = { model: null, tools: [] }
      turns.push(current)
    } else if (ev.eventType === "model_call") {
      const p = (ev.payload ?? {}) as { model?: string; usage?: ModelUsage }
      const u = p.usage ?? {}
      // Open a fresh turn if none is active or the active one already had a model.
      if (!current || current.model) {
        current = { model: null, tools: [] }
        turns.push(current)
      }
      const modelName = p.model ?? ev.actorKey ?? "model"
      current.model = {
        modelName,
        input: num(u.input),
        output: num(u.output),
        cacheRead: num(u.cacheRead),
        // Priced from tokens (Track B), not the provider-reported usage.cost.
        costUsd: costUsd(modelName, { cacheMissIn: num(u.input), cacheHitIn: num(u.cacheRead), output: num(u.output) }),
      }
    } else if (ev.eventType === "tool_result") {
      const p = (ev.payload ?? {}) as { input?: unknown; output?: unknown; isError?: boolean }
      const toolName = ev.actorKey ?? ev.title ?? "tool"
      const stage = stageFor(toolName)
      const subtitle = toolSubtitle(p.input)
      ensureTurn().tools.push({
        n: toolName,
        stage,
        label: stage === "grep" ? "Resolve" : stage === "edit" ? "Edit" : "Read",
        i: (p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : { value: p.input ?? null }),
        o: (p.output && typeof p.output === "object" ? (p.output as Record<string, unknown>) : { value: p.output ?? null }),
        _error: p.isError === true,
        ...(subtitle ? { _subtitle: subtitle } : {}),
      })
    } else if (ev.eventType === "run_end") {
      ended = true
    }
  }

  let tokens = 0
  let totalCost = 0
  let miss = 0
  let hit = 0
  let out = 0
  for (const t of turns) {
    if (!t.model) continue
    tokens += t.model.input + t.model.output
    totalCost += t.model.costUsd
    miss += t.model.input
    hit += t.model.cacheRead
    out += t.model.output
  }
  const compTotal = miss + hit + out || 1
  const st = STATUS[detail.status] ?? { s: "run" as RunStatus, label: detail.status }

  return {
    id: detail.id,
    shortId: detail.id.slice(0, 8),
    status: st.s,
    statusLabel: st.label,
    channel: detail.channel,
    entrypoint: detail.entrypoint,
    userId: detail.userId,
    userName: detail.userName ?? null,
    turns,
    totals: { turns: turns.length, tokens, costUsd: totalCost },
    composition: {
      missPct: Math.round((miss / compTotal) * 100),
      hitPct: Math.round((hit / compTotal) * 100),
      outPct: Math.round((out / compTotal) * 100),
    },
    durationLabel: detail.durationMs != null ? `${(detail.durationMs / 1000).toFixed(1)}s` : "—",
    ended,
  }
}

export function useRunDetail(runId: string | undefined, token: string | null) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: adminQueryKeys.executionRun(scope, runId ?? "none"),
    enabled: Boolean(token && runId),
    queryFn: async (): Promise<RunDetailView> => {
      const [detail, events] = await Promise.all([
        api.get<RunDetailDto>(`/api/admin/executions/${runId}`, token!),
        api.get<EventDto[]>(`/api/admin/executions/${runId}/events?limit=1000`, token!),
      ])
      return reconstructRun(detail, events)
    },
  })
}
