import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Activity, Brain, ChevronRight, ClipboardCopy, Coins, Cpu, Loader2, Pencil, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/admin/data-table"
import { MetricCard } from "@/components/admin/metric-card"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { api } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"
import { cn } from "@/lib/utils"
import type { JsonRecord } from "@/components/admin/types"

type ExecutionRun = JsonRecord & {
  id: string
  status: string
  channel: string
  entrypoint: string
  latestSummary: string | null
  errorCode: string | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

type ExecutionEvent = {
  id: string
  sequence: number
  phase: string
  eventType: string
  actorType: string
  actorKey: string | null
  title: string
  summary: string | null
  status: string | null
  payload: Record<string, unknown>
  createdAt: string
}

type RunDetail = ExecutionRun & {
  userId: string | null
  threadId: string | null
  chatId: string | null
  agentTarget: string | null
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  } catch {
    return iso
  }
}

function payloadString(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key]
  return typeof value === "string" && value.trim() ? value : null
}

function payloadNumber(payload: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = payload?.[key]
  return typeof value === "number" ? value : null
}

function eventPreview(event: ExecutionEvent): string | null {
  return payloadString(event.payload, "error")
    ?? payloadString(event.payload, "resultPreview")
    ?? payloadString(event.payload, "replyPreview")
}

function buildSummaryText(run: RunDetail, events: ExecutionEvent[]): string {
  const lines: string[] = []
  lines.push(`Run: ${run.id}`)
  lines.push(`Status: ${run.status}`)
  lines.push(`Channel: ${run.channel}`)
  lines.push(`Started: ${run.startedAt}`)
  if (run.finishedAt) lines.push(`Finished: ${run.finishedAt}`)
  if (run.durationMs !== null) lines.push(`Duration: ${formatDuration(run.durationMs)}`)
  if (run.latestSummary) lines.push(`Summary: ${run.latestSummary}`)
  if (run.errorMessage) lines.push(`Error: ${run.errorMessage}`)
  lines.push("")
  lines.push(`Events (${events.length}):`)
  for (const e of events) {
    const preview = eventPreview(e)
    const actor = e.actorKey ? ` [${e.actorKey}]` : ""
    const status = e.status ? ` (${e.status})` : ""
    lines.push(`  [${e.sequence}] ${e.phase}${actor} | ${e.title}${status}${e.summary ? ` — ${e.summary}` : ""}`)
    if (preview) lines.push(`      ${preview}`)
  }
  return lines.join("\n")
}

function buildDetailText(run: RunDetail, events: ExecutionEvent[]): string {
  const lines: string[] = []
  lines.push("=== EXECUTION RUN DETAIL ===")
  lines.push(JSON.stringify({ ...run }, null, 2))
  lines.push("")
  lines.push(`=== EVENTS (${events.length}) ===`)
  for (const e of events) {
    lines.push(`--- Event #${e.sequence} [${e.phase}] ---`)
    lines.push(JSON.stringify(e, null, 2))
  }
  return lines.join("\n")
}

function copyToClipboard(text: string, label: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${label} copied to clipboard`),
    () => toast.error("Failed to copy"),
  )
}

export function AiOpsPage() {
  const { token, session } = useAdminAuth()
  const isSuperAdmin = session?.role === "SUPER_ADMIN"

  const executions = useApiList<JsonRecord>("/api/admin/executions?limit=25", token, ["items", "runs"])
  const models = useApiList<JsonRecord>(isSuperAdmin ? "/api/admin/ai-models" : null, token, ["items", "targets"])
  const tasks = useApiList<JsonRecord>("/api/admin/runtime/tasks?limit=25", token, ["items", "tasks"])
  const scope = getAdminQueryScope(token)
  const tokenSummary = useQuery({
    queryKey: adminQueryKeys.apiList(scope, "/api/admin/token-usage/summary", "summary"),
    enabled: Boolean(token),
    queryFn: () => api.get<TokenUsageSummary>("/api/admin/token-usage/summary", token!),
  })
  const tokenMembers = useQuery({
    queryKey: adminQueryKeys.apiList(scope, "/api/admin/token-usage/members", "members"),
    enabled: Boolean(token),
    queryFn: () => api.get<TokenUsageMemberResponse>("/api/admin/token-usage/members", token!),
  })

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  return (
    <>
      <PageHeader
        eyebrow="AI Ops"
        title="Runtime and model operations"
        description="Execution traces, model targets, and runtime controls."
      />
      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Executions" value={String(executions.data.length)} detail="Visible in current query" icon={Activity} tone="emphasis" />
        <MetricCard label="Model targets" value={isSuperAdmin ? String(models.data.length) : "—"} detail={isSuperAdmin ? "Configured model routes" : "Super admin only"} icon={Brain} tone="accent" />
        <MetricCard label="Runtime tasks" value={String(tasks.data.length)} detail="Recent control surface" icon={Cpu} />
      </section>
      <Tabs defaultValue="executions">
        <TabsList className="rounded-full">
          <TabsTrigger value="executions" className="rounded-full">Executions</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="models" className="rounded-full">Models</TabsTrigger>}
          <TabsTrigger value="runtime" className="rounded-full">Runtime</TabsTrigger>
          <TabsTrigger value="token-usage" className="rounded-full">Token Usage</TabsTrigger>
        </TabsList>
        <TabsContent value="executions">
          <SectionCard title="Execution traces" description="Click a row to inspect the full event timeline.">
            <DataTable
              rows={executions.data}
              loading={executions.loading}
              emptyTitle="No executions"
              emptyDescription="Execution traces will appear after agent runs complete."
              columns={[
                {
                  key: "status",
                  header: "Status",
                  render: (row) => <StatusBadge value={String(row.status ?? "")} />,
                },
                { key: "channel", header: "Channel" },
                {
                  key: "latestSummary",
                  header: "Summary",
                  render: (row) => (
                    <span className="block max-w-xs truncate text-[12px]">
                      {String(row.latestSummary ?? row.errorMessage ?? "—")}
                    </span>
                  ),
                },
                {
                  key: "durationMs",
                  header: "Duration",
                  render: (row) => <span className="font-mono text-[11px]">{formatDuration(row.durationMs as number | null)}</span>,
                },
                {
                  key: "startedAt",
                  header: "Time",
                  render: (row) => <span className="font-mono text-[11px]">{formatTime(String(row.startedAt ?? ""))}</span>,
                },
                {
                  key: "_action",
                  header: "",
                  render: (row) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedRunId(String(row.id))
                      }}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  ),
                },
              ]}
              onRowClick={(row) => setSelectedRunId(String(row.id))}
            />
          </SectionCard>
        </TabsContent>
        {isSuperAdmin && (
          <TabsContent value="models">
            <SectionCard title="Model targets" description="Provider and model routing from the admin AI models API.">
              <DataTable
                rows={models.data}
                loading={models.loading}
                emptyTitle="No model targets"
                emptyDescription="Model configuration rows will appear when the backend exposes them."
                columns={[
                  { key: "targetKey", header: "Target" },
                  { key: "provider", header: "Provider" },
                  { key: "modelId", header: "Model" },
                  { key: "updatedAt", header: "Updated" },
                ]}
              />
            </SectionCard>
          </TabsContent>
        )}
        <TabsContent value="runtime">
          <SectionCard title="Runtime tasks" description="Recent queue/runtime tasks with control status.">
            <DataTable
              rows={tasks.data}
              loading={tasks.loading}
              emptyTitle="No runtime tasks"
              emptyDescription="Runtime tasks will appear as orchestration work is queued."
              columns={[
                { key: "taskId", header: "Task" },
                { key: "status", header: "Status", render: (row) => <StatusBadge value={String(row.status ?? "")} /> },
                { key: "engine", header: "Engine" },
                { key: "updatedAt", header: "Updated" },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="token-usage">
          <TokenUsageTab
            summary={tokenSummary.data ?? null}
            members={tokenMembers.data?.members ?? []}
            loading={tokenSummary.isPending || tokenMembers.isPending}
            token={token}
          />
        </TabsContent>
      </Tabs>

      {selectedRunId && (
        <ExecutionDetailDrawer
          runId={selectedRunId}
          token={token}
          onClose={() => setSelectedRunId(null)}
        />
      )}
    </>
  )
}

function ExecutionDetailDrawer({
  runId,
  token,
  onClose,
}: {
  runId: string
  token: string | null
  onClose: () => void
}) {
  const scope = getAdminQueryScope(token)
  const runQuery = useQuery({
    queryKey: adminQueryKeys.executionRun(scope, runId),
    enabled: Boolean(token),
    queryFn: () => api.get<RunDetail>(`/api/admin/executions/${runId}`, token!),
  })
  const eventsQuery = useQuery({
    queryKey: adminQueryKeys.executionEvents(scope, runId),
    enabled: Boolean(token),
    queryFn: async () => {
      const eventsData = await api.get<ExecutionEvent[]>(`/api/admin/executions/${runId}/events`, token!)
      return Array.isArray(eventsData) ? eventsData : []
    },
  })
  const run = runQuery.data ?? null
  const events = eventsQuery.data ?? []
  const loading = runQuery.isPending || eventsQuery.isPending

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-border/40 bg-mat shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border/40 bg-card px-5 py-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-accent">Execution detail</p>
            <p className="font-mono text-[12px] text-muted-foreground">{runId.slice(0, 8)}…</p>
          </div>
          <div className="flex items-center gap-1.5">
            {run && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 rounded-md text-[11px]"
                  onClick={() => copyToClipboard(buildSummaryText(run, events), "Summary")}
                >
                  <ClipboardCopy className="h-3 w-3" />
                  Copy summary
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 rounded-md text-[11px]"
                  onClick={() => copyToClipboard(buildDetailText(run, events), "Detail")}
                >
                  <ClipboardCopy className="h-3 w-3" />
                  Copy detail
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : run ? (
            <div className="space-y-4 p-5">
              {/* Run summary card */}
              <div className="overflow-hidden rounded-md bg-card shadow-soft">
                <KV label="Status" value={run.status} badge />
                <KV label="Channel" value={run.channel} />
                <KV label="Duration" value={formatDuration(run.durationMs)} mono />
                <KV label="Started" value={formatTime(run.startedAt)} mono />
                {run.finishedAt && <KV label="Finished" value={formatTime(run.finishedAt)} mono />}
                {run.agentTarget && <KV label="Agent target" value={run.agentTarget} mono />}
                {run.chatId && <KV label="Chat ID" value={run.chatId} mono />}
              </div>

              {/* Summary */}
              {run.latestSummary && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reply</p>
                  <div className="rounded-md bg-card p-3 shadow-soft">
                    <p className="whitespace-pre-wrap text-[12px] leading-5 text-foreground/85">{run.latestSummary}</p>
                  </div>
                </div>
              )}

              {/* Error */}
              {run.errorMessage && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-destructive">Error</p>
                  <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
                    <p className="font-mono text-[11px] text-destructive">{run.errorMessage}</p>
                  </div>
                </div>
              )}

              {/* Event timeline */}
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Events ({events.length})
                </p>
                <div className="space-y-1">
                  {events.map((evt) => (
                    <EventRow key={evt.id} event={evt} />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center text-[12px] text-muted-foreground">
              Run not found
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function EventRow({ event }: { event: ExecutionEvent }) {
  const [expanded, setExpanded] = useState(false)

  const phaseColor: Record<string, string> = {
    init: "bg-blue-500",
    plan: "bg-violet-500",
    execute: "bg-amber-500",
    complete: "bg-emerald-500",
    error: "bg-destructive",
  }

  const payload = event.payload && typeof event.payload === "object" && Object.keys(event.payload).length > 0
    ? event.payload
    : null
  const preview = eventPreview(event)
  const durationMs = payloadNumber(payload, "durationMs")

  return (
    <div
      className={cn(
        "rounded-md bg-card shadow-soft transition-colors",
        payload && "cursor-pointer hover:ring-1 hover:ring-accent/30",
      )}
      onClick={() => payload && setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground">{event.sequence}</span>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", phaseColor[event.phase] ?? "bg-secondary")} />
        <span className="text-[10px] font-medium uppercase text-muted-foreground">{event.phase}</span>
        {event.actorKey && (
          <span className="max-w-[120px] truncate rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {event.actorKey}
          </span>
        )}
        <span className="flex-1 truncate text-[12px]">{event.title}</span>
        {durationMs !== null && <span className="font-mono text-[10px] text-muted-foreground">{formatDuration(durationMs)}</span>}
        {event.status && <StatusBadge value={event.status} />}
      </div>
      {preview && (
        <div className="px-3 pb-2">
          <p className="max-h-16 overflow-hidden whitespace-pre-wrap rounded-md bg-secondary/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground/75">
            {preview}
          </p>
        </div>
      )}
      {expanded && payload && (
        <div className="border-t border-border/40 px-3 py-2">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground/70">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Token Usage Types & Tab ──────────────────────────────────────────────────

type TokenUsageSummary = {
  period: { days: number }
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  callCount: number
  estimatedCostUsd: number
  byModel: Array<{ modelId: string; provider: string; calls: number; inputTokens: number; outputTokens: number }>
}

type TokenUsageMember = {
  userId: string
  name: string | null
  email: string | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  monthlyLimit: number
  usagePct: number
}

type TokenUsageMemberResponse = {
  period: { days: number }
  members: TokenUsageMember[]
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function TokenUsageTab({
  summary,
  members,
  loading,
  token,
}: {
  summary: TokenUsageSummary | null
  members: TokenUsageMember[]
  loading: boolean
  token: string | null
}) {
  const queryClient = useQueryClient()
  const scope = getAdminQueryScope(token)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editLimit, setEditLimit] = useState("")

  const limitMutation = useMutation({
    mutationFn: async ({ userId, limit }: { userId: string; limit: number }) => {
      await api.put(`/api/admin/token-usage/members/${userId}/limit`, { monthlyTokenLimit: limit }, token!)
    },
    onSuccess: () => {
      setEditingUserId(null)
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.apiList(scope, "/api/admin/token-usage/members", "members") })
      toast.success("Token limit updated")
    },
  })

  if (loading) {
    return (
      <SectionCard title="Token usage" description="Loading token consumption data...">
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse rounded-md bg-secondary" />)}
        </div>
      </SectionCard>
    )
  }

  const totalTokens = summary?.totalTokens ?? 0
  const costUsd = summary?.estimatedCostUsd ?? 0
  const activeUsers = members.length
  const avgPerUser = activeUsers > 0 ? Math.round(totalTokens / activeUsers) : 0

  return (
    <>
      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Total tokens (30d)" value={fmtTokens(totalTokens)} detail={`${summary?.callCount ?? 0} LLM calls`} icon={Coins} tone="accent" />
        <MetricCard label="Est. cost (30d)" value={`$${costUsd.toFixed(2)}`} detail="input × rate + output × rate" icon={Activity} />
        <MetricCard label="Active users" value={String(activeUsers)} detail="DISTINCT users in period" icon={Brain} />
        <MetricCard label="Avg / user" value={fmtTokens(avgPerUser)} detail="tokens per active user" icon={Cpu} tone="emphasis" />
      </section>

      <SectionCard title="Usage by member" description="Token consumption per member with monthly limits.">
        <DataTable
          rows={members.map(m => ({ ...m, id: m.userId }))}
          loading={false}
          emptyTitle="No token usage"
          emptyDescription="Token usage will appear after AI agent runs."
          columns={[
            {
              key: "name",
              header: "Member",
              render: (row) => (
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold">{String(row.name ?? row.email ?? "Unknown")}</p>
                  {row.email ? <p className="truncate text-[11px] text-muted-foreground">{String(row.email)}</p> : null}
                </div>
              ),
            },
            {
              key: "inputTokens",
              header: "Input",
              render: (row) => <span className="font-mono text-[12px]">{fmtTokens(Number(row.inputTokens))}</span>,
            },
            {
              key: "outputTokens",
              header: "Output",
              render: (row) => <span className="font-mono text-[12px]">{fmtTokens(Number(row.outputTokens))}</span>,
            },
            {
              key: "totalTokens",
              header: "Total",
              render: (row) => <span className="font-mono text-[12px] font-semibold">{fmtTokens(Number(row.totalTokens))}</span>,
            },
            {
              key: "usagePct",
              header: "Limit usage",
              render: (row) => {
                const pct = Number(row.usagePct)
                const over = pct > 90
                return (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-secondary">
                      <div
                        className={cn("h-full rounded-full", over ? "bg-destructive" : "bg-emerald-500")}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    <span className={cn("text-[11px] font-semibold", over ? "text-destructive" : "text-emerald-500")}>
                      {pct}%
                    </span>
                  </div>
                )
              },
            },
            {
              key: "monthlyLimit",
              header: "Monthly limit",
              render: (row) => {
                const userId = String(row.userId)
                if (editingUserId === userId) {
                  return (
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="h-7 w-24 bg-card font-mono text-[11px]"
                        value={editLimit}
                        onChange={(e) => setEditLimit(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const val = Number(editLimit)
                            if (Number.isFinite(val) && val >= 0) limitMutation.mutate({ userId, limit: val })
                          }
                          if (e.key === "Escape") setEditingUserId(null)
                        }}
                      />
                      <Button
                        size="sm"
                        className="h-7 bg-emphasis px-2 text-[10px] text-emphasis-foreground"
                        disabled={limitMutation.isPending}
                        onClick={() => {
                          const val = Number(editLimit)
                          if (Number.isFinite(val) && val >= 0) limitMutation.mutate({ userId, limit: val })
                        }}
                      >
                        Save
                      </Button>
                    </div>
                  )
                }
                return (
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[12px] text-muted-foreground">{fmtTokens(Number(row.monthlyLimit))}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingUserId(userId)
                        setEditLimit(String(row.monthlyLimit))
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </div>
                )
              },
            },
          ]}
        />
      </SectionCard>

      <SectionCard title="Usage by model" description="Token consumption grouped by AI model.">
        <DataTable
          rows={(summary?.byModel ?? []).map((m, i) => ({ ...m, id: `${m.modelId}-${i}` }))}
          loading={false}
          emptyTitle="No model data"
          emptyDescription="Model usage data will appear after AI runs."
          columns={[
            { key: "modelId", header: "Model", render: (row) => <span className="font-mono text-[12px]">{String(row.modelId)}</span> },
            { key: "provider", header: "Provider" },
            { key: "calls", header: "Calls", render: (row) => <span className="font-mono text-[12px]">{String(row.calls)}</span> },
            { key: "inputTokens", header: "Input tokens", render: (row) => <span className="font-mono text-[12px]">{fmtTokens(Number(row.inputTokens))}</span> },
            { key: "outputTokens", header: "Output tokens", render: (row) => <span className="font-mono text-[12px]">{fmtTokens(Number(row.outputTokens))}</span> },
          ]}
        />
      </SectionCard>
    </>
  )
}

function KV({ label, value, mono, badge, last }: { label: string; value: string; mono?: boolean; badge?: boolean; last?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 px-3 py-2 text-[12px]", !last && "border-b border-border/40")}>
      <span className="text-muted-foreground">{label}</span>
      {badge ? (
        <span className="ml-auto"><StatusBadge value={value} /></span>
      ) : (
        <span className={cn("ml-auto truncate font-medium", mono && "font-mono text-[11px]")}>{value}</span>
      )}
    </div>
  )
}
