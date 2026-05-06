import { useCallback, useEffect, useState } from "react"
import { Activity, Brain, ChevronRight, ClipboardCopy, Cpu, Loader2, X } from "lucide-react"
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
    lines.push(`  [${e.sequence}] ${e.phase} | ${e.title}${e.summary ? ` — ${e.summary}` : ""}`)
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
  const [run, setRun] = useState<RunDetail | null>(null)
  const [events, setEvents] = useState<ExecutionEvent[]>([])
  const [loading, setLoading] = useState(true)

  const fetchDetail = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const [runData, eventsData] = await Promise.all([
        api.get<RunDetail>(`/api/admin/executions/${runId}`, token),
        api.get<ExecutionEvent[]>(`/api/admin/executions/${runId}/events`, token),
      ])
      setRun(runData as RunDetail)
      setEvents(Array.isArray(eventsData) ? eventsData : [])
    } catch {
      /* toast handled by api.ts */
    } finally {
      setLoading(false)
    }
  }, [runId, token])

  useEffect(() => { fetchDetail() }, [fetchDetail])

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
        <span className="flex-1 truncate text-[12px]">{event.title}</span>
        {event.status && <StatusBadge value={event.status} />}
      </div>
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
