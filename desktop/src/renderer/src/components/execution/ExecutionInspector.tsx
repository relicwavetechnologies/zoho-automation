import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Clock3, Loader2 } from 'lucide-react'

import { useAuth } from '../../context/AuthContext'
import { cn } from '../../lib/utils'
import type { ExecutionEventItem, ExecutionPhase, ExecutionRunSummary } from '../../types'

type ExecutionResponse = { run: ExecutionRunSummary }
type ExecutionEventsResponse = { items: ExecutionEventItem[] }

const phaseLabel: Record<ExecutionPhase, string> = {
  request: 'Request',
  planning: 'Planning',
  tool: 'Tools',
  synthesis: 'Synthesis',
  delivery: 'Delivery',
  error: 'Errors',
  control: 'Control',
}

const statusTone = (status: string | null | undefined): string => {
  switch (status) {
    case 'completed':
    case 'done':
      return 'text-[hsl(143,61%,60%)] border-[hsl(143,45%,24%)] bg-[hsl(143,26%,10%)]'
    case 'failed':
    case 'blocked':
    case 'cancelled':
      return 'text-[hsl(4,82%,68%)] border-[hsl(4,52%,24%)] bg-[hsl(4,28%,10%)]'
    case 'running':
    case 'pending':
      return 'text-[hsl(43,84%,64%)] border-[hsl(43,46%,24%)] bg-[hsl(43,28%,10%)]'
    default:
      return 'text-[hsl(0,0%,60%)] border-[hsl(0,0%,16%)] bg-[hsl(0,0%,9%)]'
  }
}

const formatDuration = (durationMs: number | null): string => {
  if (!durationMs || durationMs < 1000) return 'under 1s'
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

const formatTimestamp = (value: string): string =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })

const getPlanPayload = (events: ExecutionEventItem[]): Record<string, unknown> | null =>
  events.find((event) => event.eventType === 'plan.created')?.payload ?? null

const getSynthesisEvent = (events: ExecutionEventItem[]): ExecutionEventItem | null =>
  [...events].reverse().find((event) => event.phase === 'synthesis' && event.summary) ?? null

export function ExecutionInspector({
  executionId,
  defaultOpen = false,
  live = false,
  compact = false,
}: {
  executionId: string
  defaultOpen?: boolean
  live?: boolean
  compact?: boolean
}): JSX.Element | null {
  const { token } = useAuth()
  const [run, setRun] = useState<ExecutionRunSummary | null>(null)
  const [events, setEvents] = useState<ExecutionEventItem[]>([])
  const [open, setOpen] = useState(defaultOpen)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen, executionId])

  useEffect(() => {
    if (!token || !executionId) return

    let cancelled = false

    const load = async () => {
      try {
        if (!cancelled) {
          setLoading(true)
          setError(null)
        }

        const [runResponse, eventsResponse] = await Promise.all([
          window.desktopAPI.fetch(`/api/desktop/executions/${executionId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          window.desktopAPI.fetch(`/api/desktop/executions/${executionId}/events`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ])

        if (cancelled) return
        if (runResponse.status < 200 || runResponse.status >= 300) {
          throw new Error(`Failed to load execution ${executionId}`)
        }
        if (eventsResponse.status < 200 || eventsResponse.status >= 300) {
          throw new Error(`Failed to load execution events for ${executionId}`)
        }

        const runBody = JSON.parse(runResponse.body) as { data: ExecutionResponse }
        const eventsBody = JSON.parse(eventsResponse.body) as { data: ExecutionEventsResponse }
        setRun(runBody.data.run)
        setEvents(eventsBody.data.items)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load execution')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()

    if (!live) {
      return () => {
        cancelled = true
      }
    }

    const interval = window.setInterval(() => {
      if (!cancelled && (!run || run.status === 'running')) {
        void load()
      }
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [executionId, live, run, token])

  const planPayload = useMemo(() => getPlanPayload(events), [events])
  const synthesisEvent = useMemo(() => getSynthesisEvent(events), [events])

  if (!token || !executionId) return null

  return (
    <div
      className={cn(
        'rounded-2xl border border-[hsl(0,0%,14%)] bg-[linear-gradient(180deg,rgba(18,18,19,0.96),rgba(10,10,11,0.98))]',
        compact ? 'mt-3' : 'mt-4',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown size={15} className="text-[hsl(0,0%,50%)]" /> : <ChevronRight size={15} className="text-[hsl(0,0%,50%)]" />}
            <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-[hsl(0,0%,50%)]">
              Execution Trace
            </span>
            {loading ? <Loader2 size={13} className="animate-spin text-[hsl(0,0%,55%)]" /> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[hsl(0,0%,64%)]">
            <span className="font-mono text-[hsl(0,0%,82%)]">{executionId.slice(0, 8)}</span>
            {run?.mode ? (
              <span className="rounded-full border border-[hsl(0,0%,18%)] bg-[hsl(0,0%,8%)] px-2 py-0.5 uppercase tracking-[0.12em]">
                {run.mode}
              </span>
            ) : null}
            {run?.status ? (
              <span className={cn('rounded-full border px-2 py-0.5 capitalize', statusTone(run.status))}>
                {run.status}
              </span>
            ) : null}
            {typeof run?.eventCount === 'number' ? <span>{run.eventCount} events</span> : null}
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-[hsl(0,0%,44%)]">
          <Clock3 size={12} />
          <span>{run ? formatDuration(run.durationMs) : 'Loading...'}</span>
        </div>
      </button>

      {open ? (
        <div className="border-t border-[hsl(0,0%,12%)] px-4 py-4">
          {error ? (
            <div className="rounded-xl border border-[hsl(0,44%,20%)] bg-[hsl(0,28%,10%)] px-3 py-2 text-sm text-[hsl(0,72%,68%)]">
              {error}
            </div>
          ) : null}

          {run ? (
            <div className="grid gap-2 text-[12px] text-[hsl(0,0%,62%)] md:grid-cols-2">
              <div className="rounded-xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,7%)] px-3 py-2">
                <span className="text-[hsl(0,0%,42%)]">Started</span>
                <div className="mt-1 text-[hsl(0,0%,84%)]">{formatTimestamp(run.startedAt)}</div>
              </div>
              <div className="rounded-xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,7%)] px-3 py-2">
                <span className="text-[hsl(0,0%,42%)]">Agent target</span>
                <div className="mt-1 text-[hsl(0,0%,84%)]">{run.agentTarget ?? 'n/a'}</div>
              </div>
              <div className="rounded-xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,7%)] px-3 py-2">
                <span className="text-[hsl(0,0%,42%)]">Thread</span>
                <div className="mt-1 font-mono text-[hsl(0,0%,84%)]">{run.threadId ?? 'n/a'}</div>
              </div>
              <div className="rounded-xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,7%)] px-3 py-2">
                <span className="text-[hsl(0,0%,42%)]">Latest summary</span>
                <div className="mt-1 text-[hsl(0,0%,84%)]">{run.latestSummary ?? 'No summary captured yet.'}</div>
              </div>
            </div>
          ) : null}

          {planPayload ? (
            <div className="mt-4 rounded-2xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,7%)] px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[hsl(0,0%,48%)]">Plan</div>
              <div className="mt-2 text-sm text-[hsl(0,0%,82%)]">
                {typeof planPayload.goal === 'string' ? planPayload.goal : 'Execution plan'}
              </div>
              {Array.isArray(planPayload.tasks) ? (
                <div className="mt-3 space-y-2">
                  {planPayload.tasks.map((task, index) => {
                    const entry = task as { title?: string; ownerAgent?: string; status?: string }
                    return (
                      <div key={`${index}-${entry.title ?? 'task'}`} className="rounded-xl border border-[hsl(0,0%,11%)] bg-[hsl(0,0%,5%)] px-3 py-2 text-sm">
                        <div className="text-[hsl(0,0%,84%)]">{index + 1}. {entry.title ?? 'Untitled task'}</div>
                        <div className="mt-1 text-[12px] text-[hsl(0,0%,48%)]">
                          {entry.ownerAgent ?? 'planner'} · {entry.status ?? 'pending'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {synthesisEvent?.summary ? (
            <div className="mt-4 rounded-2xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,7%)] px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[hsl(0,0%,48%)]">Final Synthesis</div>
              <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[hsl(0,0%,82%)]">
                {synthesisEvent.summary}
              </div>
            </div>
          ) : null}

          <div className="mt-4 rounded-2xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,6%)]">
            <div className="border-b border-[hsl(0,0%,11%)] px-4 py-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[hsl(0,0%,48%)]">
              Timeline
            </div>
            <div className="max-h-[420px] overflow-y-auto px-4 py-3">
              {events.length === 0 && !loading ? (
                <div className="text-sm text-[hsl(0,0%,48%)]">No execution events recorded yet.</div>
              ) : null}

              <div className="space-y-3">
                {events.map((event) => {
                  const payloadOpen = expandedPayloads[event.id] ?? (live && (event.status === 'failed' || event.status === 'running'))
                  return (
                    <div key={event.id} className="rounded-2xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,7%)] px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,9%)] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[hsl(0,0%,50%)]">
                              {phaseLabel[event.phase]}
                            </span>
                            {event.status ? (
                              <span className={cn('rounded-full border px-2 py-0.5 text-[10px] capitalize', statusTone(event.status))}>
                                {event.status}
                              </span>
                            ) : null}
                            <span className="text-[11px] text-[hsl(0,0%,44%)]">#{event.sequence}</span>
                          </div>
                          <div className="mt-2 text-sm font-medium text-[hsl(0,0%,88%)]">{event.title}</div>
                          {event.summary ? (
                            <div className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-[hsl(0,0%,64%)]">
                              {event.summary}
                            </div>
                          ) : null}
                          <div className="mt-2 text-[11px] text-[hsl(0,0%,42%)]">
                            {formatTimestamp(event.createdAt)}
                            {event.actorKey ? ` · ${event.actorKey}` : ''}
                          </div>
                        </div>

                        {event.payload ? (
                          <button
                            type="button"
                            onClick={() => setExpandedPayloads((prev) => ({ ...prev, [event.id]: !payloadOpen }))}
                            className="rounded-lg border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,9%)] px-2 py-1 text-[11px] text-[hsl(0,0%,62%)] hover:text-[hsl(0,0%,82%)]"
                          >
                            {payloadOpen ? 'Hide payload' : 'Show payload'}
                          </button>
                        ) : null}
                      </div>

                      {payloadOpen && event.payload ? (
                        <pre className="mt-3 overflow-x-auto rounded-xl border border-[hsl(0,0%,11%)] bg-[hsl(0,0%,4%)] px-3 py-3 text-[11px] leading-6 text-[hsl(0,0%,58%)]">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
