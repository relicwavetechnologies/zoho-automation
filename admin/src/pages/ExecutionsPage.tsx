import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { X } from 'lucide-react'

import { useAdminAuth } from '../auth/AdminAuthProvider'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { ScrollArea } from '../components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { api } from '../lib/api'
import { cn } from '../lib/utils'

type ExecutionMode = 'fast' | 'high' | 'xtreme' | null
type ExecutionRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
type ExecutionPhase = 'request' | 'planning' | 'tool' | 'synthesis' | 'delivery' | 'error' | 'control'
type ExecutionActorType = 'system' | 'planner' | 'agent' | 'tool' | 'model' | 'delivery'

type ExecutionRun = {
  id: string
  companyId: string
  companyName: string | null
  userId: string | null
  userName: string | null
  userEmail: string | null
  channel: 'desktop' | 'lark'
  entrypoint: string
  requestId: string | null
  taskId: string | null
  threadId: string | null
  chatId: string | null
  messageId: string | null
  mode: ExecutionMode
  agentTarget: string | null
  status: ExecutionRunStatus
  latestSummary: string | null
  errorCode: string | null
  errorMessage: string | null
  eventCount: number
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

type ExecutionEvent = {
  id: string
  executionId: string
  sequence: number
  phase: ExecutionPhase
  eventType: string
  actorType: ExecutionActorType
  actorKey: string | null
  title: string
  summary: string | null
  status: string | null
  payload: Record<string, unknown> | null
  createdAt: string
}

type ExecutionListResponse = {
  items: ExecutionRun[]
  total: number
  page: number
  pageSize: number
  summary: {
    totalRuns: number
    failedRuns: number
    activeRuns: number
    byChannel: Partial<Record<'desktop' | 'lark', number>>
    byMode: Partial<Record<'fast' | 'high' | 'xtreme' | 'unknown', number>>
  }
}

const DEFAULT_PAGE_SIZE = 25

const formatDateTime = (value: string): string =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

const formatDuration = (durationMs: number | null): string => {
  if (!durationMs || durationMs < 1000) return 'under 1s'
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

const statusTone = (status: string | null | undefined): string => {
  switch (status) {
    case 'completed':
    case 'done':
      return 'border-[#17311f] bg-[#0e1712] text-emerald-400'
    case 'failed':
    case 'cancelled':
    case 'blocked':
      return 'border-[#311717] bg-[#190f0f] text-rose-400'
    case 'running':
    case 'pending':
      return 'border-[#32260e] bg-[#171109] text-amber-300'
    default:
      return 'border-[#222] bg-[#111] text-zinc-400'
  }
}

const phaseLabel: Record<ExecutionPhase, string> = {
  request: 'Request',
  planning: 'Planning',
  tool: 'Tools',
  synthesis: 'Synthesis',
  delivery: 'Delivery',
  error: 'Errors',
  control: 'Control',
}

const isoDate = (offsetDays: number): string => {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

const truncate = (value: string | null | undefined, maxChars: number): string => {
  const trimmed = value?.trim()
  if (!trimmed) return ''
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed
}

const buildTabLabel = (run: ExecutionRun | null | undefined, executionId: string): string =>
  truncate(run?.latestSummary, 58) || truncate(run?.errorMessage, 58) || `Prompt ${executionId.slice(0, 8)}`

export const ExecutionsPage = () => {
  const { token, session } = useAdminAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [runs, setRuns] = useState<ExecutionRun[]>([])
  const [summary, setSummary] = useState<ExecutionListResponse['summary'] | null>(null)
  const [total, setTotal] = useState(0)
  const [openedExecutionIds, setOpenedExecutionIds] = useState<string[]>([])
  const [detailById, setDetailById] = useState<Record<string, ExecutionRun>>({})
  const [eventsById, setEventsById] = useState<Record<string, ExecutionEvent[]>>({})
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingDetailById, setLoadingDetailById] = useState<Record<string, boolean>>({})
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({})
  const detailCardRef = useRef<HTMLDivElement>(null)

  const filters = useMemo(() => {
    const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1)
    return {
      query: searchParams.get('query') ?? '',
      channel: searchParams.get('channel') ?? 'all',
      mode: searchParams.get('mode') ?? 'all',
      status: searchParams.get('status') ?? 'all',
      phase: searchParams.get('phase') ?? 'all',
      actorType: searchParams.get('actorType') ?? 'all',
      dateFrom: searchParams.get('dateFrom') ?? isoDate(-7),
      dateTo: searchParams.get('dateTo') ?? isoDate(0),
      selected: searchParams.get('selected') ?? '',
      page,
    }
  }, [searchParams])

  const updateFilters = (updates: Record<string, string | null>, options?: { preservePage?: boolean }) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(updates).forEach(([key, value]) => {
      if (!value || value === 'all') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    })
    if (!options?.preservePage && !('page' in updates)) {
      next.set('page', '1')
    }
    setSearchParams(next)
  }

  const activeExecutionId = filters.selected || openedExecutionIds[0] || ''
  const activeDetail = activeExecutionId ? detailById[activeExecutionId] ?? runs.find((run) => run.id === activeExecutionId) ?? null : null
  const activeEvents = activeExecutionId ? eventsById[activeExecutionId] ?? [] : []
  const activeLoadingDetail = activeExecutionId ? loadingDetailById[activeExecutionId] ?? false : false
  const activePlanPayload = activeEvents.find((event) => event.eventType === 'plan.created')?.payload ?? null
  const activeSynthesisEvent = [...activeEvents].reverse().find((event) => event.phase === 'synthesis' && event.summary) ?? null
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE))

  const openExecution = (run: ExecutionRun) => {
    setDetailById((prev) => ({ ...prev, [run.id]: prev[run.id] ?? run }))
    setOpenedExecutionIds((prev) => (prev.includes(run.id) ? prev : [...prev, run.id]))
    updateFilters({ selected: run.id }, { preservePage: true })
    window.requestAnimationFrame(() => {
      detailCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const closeExecution = (executionId: string) => {
    setOpenedExecutionIds((prev) => {
      const next = prev.filter((id) => id !== executionId)
      if (activeExecutionId === executionId) {
        updateFilters({ selected: next[next.length - 1] ?? null }, { preservePage: true })
      }
      return next
    })
  }

  useEffect(() => {
    if (!token) return

    let cancelled = false

    const loadRuns = async () => {
      try {
        setLoadingRuns(true)
        const query = new URLSearchParams({
          page: String(filters.page),
          pageSize: String(DEFAULT_PAGE_SIZE),
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
        })
        if (filters.query) query.set('query', filters.query)
        if (filters.channel !== 'all') query.set('channel', filters.channel)
        if (filters.mode !== 'all') query.set('mode', filters.mode)
        if (filters.status !== 'all') query.set('status', filters.status)
        if (filters.phase !== 'all') query.set('phase', filters.phase)
        if (filters.actorType !== 'all') query.set('actorType', filters.actorType)

        const response = await api.get<ExecutionListResponse>(`/api/admin/executions?${query.toString()}`, token)
        if (cancelled) return
        setRuns(response.items)
        setSummary(response.summary)
        setTotal(response.total)
        setDetailById((prev) => {
          const next = { ...prev }
          for (const run of response.items) {
            if (openedExecutionIds.includes(run.id) || run.id === activeExecutionId) {
              next[run.id] = { ...next[run.id], ...run }
            }
          }
          return next
        })
      } finally {
        if (!cancelled) {
          setLoadingRuns(false)
        }
      }
    }

    void loadRuns()

    return () => {
      cancelled = true
    }
  }, [
    activeExecutionId,
    filters.actorType,
    filters.channel,
    filters.dateFrom,
    filters.dateTo,
    filters.mode,
    filters.page,
    filters.phase,
    filters.query,
    filters.status,
    openedExecutionIds,
    token,
  ])

  useEffect(() => {
    if (!filters.selected) return
    setOpenedExecutionIds((prev) => (prev.includes(filters.selected) ? prev : [...prev, filters.selected]))
  }, [filters.selected])

  useEffect(() => {
    if (!token || !activeExecutionId) return

    let cancelled = false

    const loadDetail = async () => {
      try {
        setLoadingDetailById((prev) => ({ ...prev, [activeExecutionId]: true }))
        const [runResponse, eventsResponse] = await Promise.all([
          api.get<{ run: ExecutionRun }>(`/api/admin/executions/${activeExecutionId}`, token),
          api.get<{ items: ExecutionEvent[] }>(`/api/admin/executions/${activeExecutionId}/events`, token),
        ])
        if (cancelled) return
        setDetailById((prev) => ({ ...prev, [activeExecutionId]: runResponse.run }))
        setEventsById((prev) => ({ ...prev, [activeExecutionId]: eventsResponse.items }))
      } finally {
        if (!cancelled) {
          setLoadingDetailById((prev) => ({ ...prev, [activeExecutionId]: false }))
        }
      }
    }

    void loadDetail()

    return () => {
      cancelled = true
    }
  }, [activeExecutionId, token])

  return (
    <div className="flex max-w-[1500px] flex-col gap-6">
      <Card className="border-[#1a1a1a] bg-[#111] text-zinc-300 shadow-md shadow-black/20">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">AI Executions</CardTitle>
          <CardDescription className="mt-1 text-zinc-500">
            Unified desktop and Lark execution timelines with scoped filtering for user, mode, status, and lifecycle events.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Input
              value={filters.query}
              onChange={(event) => updateFilters({ query: event.target.value || null })}
              placeholder="Search execution, request, task, thread, user"
              className="border-[#222] bg-[#0a0a0a]"
            />
            <Select value={filters.channel} onValueChange={(value) => updateFilters({ channel: value })}>
              <SelectTrigger className="border-[#222] bg-[#0a0a0a]">
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent className="border-[#222] bg-[#111] text-zinc-300">
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="desktop">Desktop</SelectItem>
                <SelectItem value="lark">Lark</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.mode} onValueChange={(value) => updateFilters({ mode: value })}>
              <SelectTrigger className="border-[#222] bg-[#0a0a0a]">
                <SelectValue placeholder="Mode" />
              </SelectTrigger>
              <SelectContent className="border-[#222] bg-[#111] text-zinc-300">
                <SelectItem value="all">All modes</SelectItem>
                <SelectItem value="fast">Fast</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="xtreme">Xtreme</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.status} onValueChange={(value) => updateFilters({ status: value })}>
              <SelectTrigger className="border-[#222] bg-[#0a0a0a]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent className="border-[#222] bg-[#111] text-zinc-300">
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.phase} onValueChange={(value) => updateFilters({ phase: value })}>
              <SelectTrigger className="border-[#222] bg-[#0a0a0a]">
                <SelectValue placeholder="Phase" />
              </SelectTrigger>
              <SelectContent className="border-[#222] bg-[#111] text-zinc-300">
                <SelectItem value="all">All phases</SelectItem>
                <SelectItem value="request">Request</SelectItem>
                <SelectItem value="planning">Planning</SelectItem>
                <SelectItem value="tool">Tool</SelectItem>
                <SelectItem value="synthesis">Synthesis</SelectItem>
                <SelectItem value="delivery">Delivery</SelectItem>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="control">Control</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.actorType} onValueChange={(value) => updateFilters({ actorType: value })}>
              <SelectTrigger className="border-[#222] bg-[#0a0a0a]">
                <SelectValue placeholder="Actor type" />
              </SelectTrigger>
              <SelectContent className="border-[#222] bg-[#111] text-zinc-300">
                <SelectItem value="all">All actors</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="planner">Planner</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="tool">Tool</SelectItem>
                <SelectItem value="model">Model</SelectItem>
                <SelectItem value="delivery">Delivery</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={filters.dateFrom}
              onChange={(event) => updateFilters({ dateFrom: event.target.value })}
              className="border-[#222] bg-[#0a0a0a]"
            />
            <Input
              type="date"
              value={filters.dateTo}
              onChange={(event) => updateFilters({ dateTo: event.target.value })}
              className="border-[#222] bg-[#0a0a0a]"
            />
          </div>

          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Total</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">{summary?.totalRuns ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Failures</div>
              <div className="mt-2 text-2xl font-semibold text-rose-400">{summary?.failedRuns ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Running</div>
              <div className="mt-2 text-2xl font-semibold text-amber-300">{summary?.activeRuns ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Desktop</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">{summary?.byChannel.desktop ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Lark</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">{summary?.byChannel.lark ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Modes</div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-300">
                <span>fast {summary?.byMode.fast ?? 0}</span>
                <span>high {summary?.byMode.high ?? 0}</span>
                <span>xtreme {summary?.byMode.xtreme ?? 0}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[#1a1a1a] bg-[#111] text-zinc-300 shadow-md shadow-black/20">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">Execution Runs</CardTitle>
          <CardDescription className="mt-1 text-zinc-500">
            Open a run below to explore it in the full-page prompt tabs. {session?.role === 'COMPANY_ADMIN' ? 'Scoped to your company.' : 'Cross-company super-admin view.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="space-y-3">
            {loadingRuns ? (
              Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-2 h-3 w-64" />
                  <Skeleton className="mt-3 h-3 w-32" />
                </div>
              ))
            ) : runs.length > 0 ? (
              runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => openExecution(run)}
                  className={cn(
                    'w-full rounded-xl border bg-[#0a0a0a] p-4 text-left transition-colors',
                    activeExecutionId === run.id ? 'border-[#333] bg-[#121212]' : 'border-[#1a1a1a] hover:border-[#252525] hover:bg-[#101010]',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-mono text-sm text-zinc-100">{run.id.slice(0, 8)}</div>
                        <Badge variant="outline" className="border-[#222] bg-transparent text-zinc-400">
                          {run.channel}
                        </Badge>
                        {run.mode ? (
                          <Badge variant="outline" className="border-[#222] bg-transparent text-zinc-400">
                            {run.mode}
                          </Badge>
                        ) : null}
                        <span className={cn('rounded-full border px-2 py-0.5 text-[11px] capitalize', statusTone(run.status))}>
                          {run.status}
                        </span>
                      </div>
                      <div className="mt-2 text-sm text-zinc-300">
                        {run.userEmail ?? run.userName ?? run.userId ?? 'Unknown user'}
                        <span className="text-zinc-500"> · {run.companyName ?? run.companyId}</span>
                      </div>
                      <div className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-500">
                        {run.latestSummary ?? 'No summary captured.'}
                      </div>
                    </div>
                    <div className="text-right text-xs text-zinc-500">
                      <div>{formatDateTime(run.startedAt)}</div>
                      <div className="mt-1">{formatDuration(run.durationMs)}</div>
                      <div className="mt-1">{run.eventCount} events</div>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-[#222] bg-[#0a0a0a] px-4 py-6 text-sm text-zinc-500">
                No executions found for the current filters.
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-[#1a1a1a] pt-4 text-sm text-zinc-500">
            <span>Page {filters.page} of {totalPages}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={filters.page <= 1}
                onClick={() => updateFilters({ page: String(filters.page - 1) })}
                className="rounded-lg border border-[#222] px-3 py-1.5 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={filters.page >= totalPages}
                onClick={() => updateFilters({ page: String(filters.page + 1) })}
                className="rounded-lg border border-[#222] px-3 py-1.5 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card ref={detailCardRef} className="border-[#1a1a1a] bg-[#111] text-zinc-300 shadow-md shadow-black/20">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">Prompt Explorer</CardTitle>
          <CardDescription className="mt-1 text-zinc-500">
            Open prompts appear as tabs. Switch between them without losing your place in the timeline.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          {openedExecutionIds.length > 0 ? (
            <div className="space-y-5">
              <ScrollArea className="w-full whitespace-nowrap rounded-xl border border-[#1a1a1a] bg-[#0a0a0a]">
                <div className="flex min-w-full gap-2 p-3">
                  {openedExecutionIds.map((executionId) => {
                    const run = detailById[executionId] ?? runs.find((entry) => entry.id === executionId) ?? null
                    const isActive = activeExecutionId === executionId
                    return (
                      <div
                        key={executionId}
                        className={cn(
                          'flex min-w-[240px] max-w-[360px] items-center gap-2 rounded-xl border px-3 py-2',
                          isActive ? 'border-[#3a3a3a] bg-[#151515]' : 'border-[#202020] bg-[#0f0f0f]',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => updateFilters({ selected: executionId }, { preservePage: true })}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate text-sm font-medium text-zinc-100">
                            {buildTabLabel(run, executionId)}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                            <span className="font-mono">{executionId.slice(0, 8)}</span>
                            {run?.status ? (
                              <span className={cn('rounded-full border px-2 py-0.5 capitalize', statusTone(run.status))}>
                                {run.status}
                              </span>
                            ) : null}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => closeExecution(executionId)}
                          className="rounded-lg border border-[#222] p-1.5 text-zinc-500 hover:text-zinc-200"
                          aria-label={`Close ${executionId}`}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>

              {activeLoadingDetail ? (
                <div className="space-y-3">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-40 w-full" />
                  <Skeleton className="h-48 w-full" />
                </div>
              ) : activeDetail ? (
                <div className="space-y-4">
                  <div className="grid gap-3 xl:grid-cols-4">
                    <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Execution</div>
                      <div className="mt-2 font-mono text-sm text-zinc-100">{activeDetail.id}</div>
                      <div className="mt-2 text-sm text-zinc-500">{activeDetail.entrypoint}</div>
                    </div>
                    <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">User / Company</div>
                      <div className="mt-2 text-sm text-zinc-100">{activeDetail.userEmail ?? activeDetail.userName ?? activeDetail.userId ?? 'Unknown user'}</div>
                      <div className="mt-2 text-sm text-zinc-500">{activeDetail.companyName ?? activeDetail.companyId}</div>
                    </div>
                    <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Started</div>
                      <div className="mt-2 text-sm text-zinc-100">{formatDateTime(activeDetail.startedAt)}</div>
                      <div className="mt-2 text-sm text-zinc-500">Duration {formatDuration(activeDetail.durationMs)}</div>
                    </div>
                    <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Identifiers</div>
                      <div className="mt-2 space-y-1 text-sm text-zinc-500">
                        <div>request {activeDetail.requestId ?? 'n/a'}</div>
                        <div>task {activeDetail.taskId ?? 'n/a'}</div>
                        <div>thread {activeDetail.threadId ?? 'n/a'}</div>
                      </div>
                    </div>
                  </div>

                  {activePlanPayload ? (
                    <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Execution Plan</div>
                      <div className="mt-2 text-sm text-zinc-100">
                        {typeof activePlanPayload.goal === 'string' ? activePlanPayload.goal : 'Execution plan'}
                      </div>
                      {Array.isArray(activePlanPayload.tasks) ? (
                        <div className="mt-3 grid gap-2 xl:grid-cols-2">
                          {activePlanPayload.tasks.map((task, index) => {
                            const entry = task as { title?: string; ownerAgent?: string; status?: string }
                            return (
                              <div key={`${index}-${entry.title ?? 'task'}`} className="rounded-lg border border-[#1a1a1a] bg-[#101010] px-3 py-3">
                                <div className="text-sm text-zinc-200">{index + 1}. {entry.title ?? 'Untitled task'}</div>
                                <div className="mt-1 text-xs text-zinc-500">{entry.ownerAgent ?? 'planner'} · {entry.status ?? 'pending'}</div>
                              </div>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {activeSynthesisEvent?.summary ? (
                    <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.14em] text-zinc-500">Final Synthesis</div>
                      <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                        {activeSynthesisEvent.summary}
                      </div>
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a]">
                    <div className="border-b border-[#1a1a1a] px-4 py-3 text-xs uppercase tracking-[0.14em] text-zinc-500">
                      Lifecycle Timeline
                    </div>
                    <ScrollArea className="h-[720px]">
                      <div className="space-y-3 p-4">
                        {activeEvents.map((event) => {
                          const payloadOpen = expandedPayloads[event.id] ?? (event.status === 'failed' || event.status === 'running')
                          return (
                            <div key={event.id} className="rounded-xl border border-[#1a1a1a] bg-[#101010] px-4 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="outline" className="border-[#222] bg-transparent text-zinc-400">
                                      {phaseLabel[event.phase]}
                                    </Badge>
                                    {event.status ? (
                                      <span className={cn('rounded-full border px-2 py-0.5 text-[11px] capitalize', statusTone(event.status))}>
                                        {event.status}
                                      </span>
                                    ) : null}
                                    <span className="text-xs text-zinc-500">#{event.sequence}</span>
                                  </div>
                                  <div className="mt-2 text-sm font-medium text-zinc-100">{event.title}</div>
                                  {event.summary ? (
                                    <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-400">
                                      {event.summary}
                                    </div>
                                  ) : null}
                                  <div className="mt-2 text-xs text-zinc-500">
                                    {formatDateTime(event.createdAt)}
                                    {event.actorKey ? ` · ${event.actorKey}` : ''}
                                  </div>
                                </div>
                                {event.payload ? (
                                  <button
                                    type="button"
                                    onClick={() => setExpandedPayloads((prev) => ({ ...prev, [event.id]: !payloadOpen }))}
                                    className="rounded-lg border border-[#222] px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                                  >
                                    {payloadOpen ? 'Hide payload' : 'Show payload'}
                                  </button>
                                ) : null}
                              </div>
                              {payloadOpen && event.payload ? (
                                <pre className="mt-3 overflow-x-auto rounded-lg border border-[#181818] bg-[#090909] p-3 text-xs leading-6 text-zinc-400">
                                  {JSON.stringify(event.payload, null, 2)}
                                </pre>
                              ) : null}
                            </div>
                          )
                        })}
                        {activeEvents.length === 0 ? (
                          <div className="text-sm text-zinc-500">No events recorded for this execution.</div>
                        ) : null}
                      </div>
                    </ScrollArea>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[#222] bg-[#0a0a0a] px-4 py-6 text-sm text-zinc-500">
                  Select a prompt from the execution list to open it as a full-page exploration tab.
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[#222] bg-[#0a0a0a] px-4 py-6 text-sm text-zinc-500">
              No prompt tabs are open yet. Select an execution run above to explore it.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
