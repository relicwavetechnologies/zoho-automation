import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { X, Search, Filter, Calendar, Cpu, Zap, Activity, Clock, ChevronRight, ChevronLeft, ArrowUpRight, MessageSquare, Terminal, Layout, Share2, Shield, Info, Layers } from 'lucide-react'

import { useAdminAuth } from '../auth/AdminAuthProvider'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { ScrollArea } from '../components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'

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

const statusBadge = (status: string | null | undefined) => {
  switch (status) {
    case 'completed':
    case 'done':
      return <Badge variant="secondary" className="bg-emerald-500/5 text-emerald-500 border-emerald-500/10 text-[10px] font-bold uppercase tracking-tight h-5">Completed</Badge>
    case 'failed':
    case 'error':
      return <Badge variant="secondary" className="bg-red-500/5 text-red-500 border-red-500/10 text-[10px] font-bold uppercase tracking-tight h-5">Failed</Badge>
    case 'running':
    case 'pending':
      return <Badge variant="secondary" className="bg-amber-500/5 text-amber-500 border-amber-500/10 text-[10px] font-bold uppercase tracking-tight h-5">Running</Badge>
    case 'cancelled':
      return <Badge variant="secondary" className="bg-zinc-500/5 text-zinc-500 border-zinc-500/10 text-[10px] font-bold uppercase tracking-tight h-5">Cancelled</Badge>
    default:
      return <Badge variant="outline" className="text-[10px] font-bold uppercase tracking-tight h-5">{status || 'Unknown'}</Badge>
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
  truncate(run?.latestSummary, 40) || truncate(run?.errorMessage, 40) || `Execution ${executionId.slice(0, 8)}`

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

  const loadRuns = useCallback(async (options?: { silent?: boolean }) => {
    if (!token) return
    if (!options?.silent) setLoadingRuns(true)
    try {
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
      setLoadingRuns(false)
    }
  }, [filters, activeExecutionId, openedExecutionIds, token])

  const loadDetail = useCallback(async (executionId: string, options?: { silent?: boolean }) => {
    if (!token || !executionId) return
    if (!options?.silent) setLoadingDetailById((prev) => ({ ...prev, [executionId]: true }))
    try {
      const [runResponse, eventsResponse] = await Promise.all([
        api.get<{ run: ExecutionRun }>(`/api/admin/executions/${executionId}`, token),
        api.get<{ items: ExecutionEvent[] }>(`/api/admin/executions/${executionId}/events`, token),
      ])
      setDetailById((prev) => ({ ...prev, [executionId]: runResponse.run }))
      setEventsById((prev) => ({ ...prev, [executionId]: eventsResponse.items }))
    } finally {
      setLoadingDetailById((prev) => ({ ...prev, [executionId]: false }))
    }
  }, [token])

  useEffect(() => {
    void loadRuns()
  }, [
    filters.actorType,
    filters.channel,
    filters.dateFrom,
    filters.dateTo,
    filters.mode,
    filters.page,
    filters.phase,
    filters.query,
    filters.status,
    token
  ])

  useEffect(() => {
    if (activeExecutionId) {
      void loadDetail(activeExecutionId)
    }
  }, [activeExecutionId, token])

  useEffect(() => {
    if (!filters.selected) return
    setOpenedExecutionIds((prev) => (prev.includes(filters.selected) ? prev : [...prev, filters.selected]))
  }, [filters.selected])

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col gap-8 p-4 md:p-6 lg:p-8 rounded-3xl border border-border/40 bg-card/30 backdrop-blur-xl shadow-2xl min-w-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 min-w-0">
          <div className="relative group flex-1 max-w-lg min-w-0">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 group-focus-within:text-primary transition-colors" />
            <Input
              value={filters.query}
              onChange={(event) => updateFilters({ query: event.target.value || null })}
              placeholder="Search traces..."
              className="bg-background/50 border-border/30 h-11 pl-12 rounded-xl focus-visible:ring-primary/20 w-full"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Select value={filters.channel} onValueChange={(value) => updateFilters({ channel: value })}>
              <SelectTrigger className="bg-background/50 border-border/30 h-11 w-[140px] text-xs font-bold uppercase tracking-widest rounded-xl shadow-sm">
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                <SelectItem value="desktop">Desktop</SelectItem>
                <SelectItem value="lark">Lark</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2 bg-background/50 border border-border/30 rounded-xl px-3 h-11 shadow-sm shrink-0">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground/60" />
              <input 
                type="date" 
                value={filters.dateFrom} 
                onChange={(e) => updateFilters({ dateFrom: e.target.value })}
                className="bg-transparent text-[10px] font-bold uppercase tracking-tighter outline-none text-foreground w-[90px]"
              />
              <Separator orientation="vertical" className="h-4 bg-border/40" />
              <input 
                type="date" 
                value={filters.dateTo} 
                onChange={(e) => updateFilters({ dateTo: e.target.value })}
                className="bg-transparent text-[10px] font-bold uppercase tracking-tighter outline-none text-foreground w-[90px]"
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6 min-w-0">
          {[
            { label: 'Total', value: summary?.totalRuns, color: 'text-foreground' },
            { label: 'Failures', value: summary?.failedRuns, color: 'text-red-500' },
            { label: 'Active', value: summary?.activeRuns, color: 'text-amber-500' },
            { label: 'Desktop', value: summary?.byChannel.desktop, color: 'text-foreground' },
            { label: 'Lark', value: summary?.byChannel.lark, color: 'text-foreground' },
            { label: 'Xtreme', value: summary?.byMode.xtreme, color: 'text-primary' },
          ].map((stat, i) => (
            <div key={i} className="p-4 rounded-2xl border border-border/30 bg-muted/10 space-y-1.5 group hover:border-primary/20 transition-all min-w-0 overflow-hidden">
              <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 group-hover:text-primary transition-colors truncate block">{stat.label}</span>
              <div className={cn("text-xl font-bold tracking-tight truncate", stat.color)}>{stat.value ?? 0}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6 2xl:grid-cols-[1fr_460px] h-[calc(100vh-340px)] min-h-[600px] min-w-0 mt-8">
        <div className="flex flex-col min-h-0 min-w-0">
          <Card className="bg-card/20 border-border/40 shadow-2xl overflow-hidden backdrop-blur-sm rounded-3xl flex-1 flex flex-col min-w-0">
            <CardHeader className="border-b border-border/40 bg-muted/20 p-4 md:p-6 lg:p-8 flex flex-row items-center justify-between shrink-0 min-w-0">
              <div className="min-w-0">
                <CardTitle className="text-xl font-bold tracking-tight truncate">Execution Timeline</CardTitle>
                <CardDescription className="text-sm font-medium text-muted-foreground/70 truncate">Platform telemetry nodes.</CardDescription>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button 
                  variant="outline" 
                  size="icon" 
                  className="h-9 w-9 rounded-xl border-border/40 bg-background/50 shadow-sm"
                  disabled={filters.page <= 1}
                  onClick={() => updateFilters({ page: String(filters.page - 1) })}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="bg-muted/30 px-3 py-1.5 rounded-xl border border-border/20 shadow-inner">
                  <span className="text-[10px] font-bold text-foreground tracking-widest uppercase tabular-nums">{filters.page} / {totalPages}</span>
                </div>
                <Button 
                  variant="outline" 
                  size="icon" 
                  className="h-9 w-9 rounded-xl border-border/40 bg-background/50 shadow-sm"
                  disabled={filters.page >= totalPages}
                  onClick={() => updateFilters({ page: String(filters.page + 1) })}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 min-h-0 min-w-0">
              <ScrollArea className="h-full">
                <div className="divide-y divide-border/40 min-w-0">
                  {loadingRuns ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="p-6 md:p-8 space-y-4">
                        <Skeleton className="h-5 w-1/4 rounded-lg opacity-40" />
                        <Skeleton className="h-4 w-1/2 rounded-lg opacity-20" />
                      </div>
                    ))
                  ) : runs.length > 0 ? (
                    runs.map((run) => (
                      <button
                        key={run.id}
                        onClick={() => openExecution(run)}
                        className={cn(
                          "w-full p-6 md:p-8 text-left transition-all hover:bg-primary/[0.03] flex items-start justify-between group relative overflow-hidden min-w-0",
                          activeExecutionId === run.id && "bg-primary/[0.05]"
                        )}
                      >
                        {activeExecutionId === run.id && <div className="absolute top-0 left-0 w-1.5 h-full bg-primary shadow-[0_0_15px_rgba(var(--primary),0.5)]" />}
                        <div className="flex items-start gap-4 md:gap-6 min-w-0">
                          <div className={cn(
                            "h-12 w-12 md:h-14 md:w-14 rounded-2xl border flex items-center justify-center shrink-0 transition-all duration-500 shadow-sm",
                            activeExecutionId === run.id ? "bg-primary/10 border-primary/30 text-primary scale-105 shadow-lg" : "bg-muted/50 border-border/40 text-muted-foreground group-hover:bg-background group-hover:text-foreground"
                          )}>
                            {run.channel === 'lark' ? <MessageSquare className="h-5 w-5 md:h-6 md:w-6" /> : <Activity className="h-5 w-5 md:h-6 md:w-6" />}
                          </div>
                          <div className="min-w-0 space-y-1.5 md:space-y-2">
                            <div className="flex items-center gap-2 md:gap-3 flex-wrap min-w-0">
                              <span className="text-sm md:text-base font-bold text-foreground truncate tracking-tight">
                                {run.userEmail || run.userName || 'System Auth'}
                              </span>
                              <Badge variant="outline" className="text-[9px] md:text-[10px] font-mono border-border/40 h-5 px-2 bg-muted/20 shrink-0">{run.id.slice(0, 8)}</Badge>
                              {statusBadge(run.status)}
                            </div>
                            <p className="text-xs md:text-sm text-muted-foreground/80 font-medium line-clamp-1 italic min-w-0">
                              {run.latestSummary ? `"${run.latestSummary}"` : 'Initializing execution flow...'}
                            </p>
                            <div className="flex items-center gap-3 md:gap-4 pt-1 flex-wrap min-w-0">
                              <div className="flex items-center gap-1.5 text-[10px] md:text-[11px] font-bold uppercase tracking-tighter text-muted-foreground/60">
                                <Clock className="h-3 w-3 md:h-3.5 md:w-3.5" />
                                {formatDuration(run.durationMs)}
                              </div>
                              <Separator orientation="vertical" className="h-3 bg-border/40 hidden md:block" />
                              <div className="flex items-center gap-1.5 text-[10px] md:text-[11px] font-bold uppercase tracking-tighter text-muted-foreground/60">
                                <Terminal className="h-3 w-3 md:h-3.5 md:w-3.5" />
                                {run.eventCount} Events
                              </div>
                              {run.mode && (
                                <Badge variant="outline" className="text-[8px] md:text-[9px] font-bold uppercase tracking-widest h-5 bg-primary/5 text-primary border-primary/20 shrink-0">{run.mode}</Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2 md:gap-3 shrink-0 pt-1 ml-4">
                          <span className="text-[10px] md:text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50 tabular-nums">{formatDateTime(run.startedAt)}</span>
                          <ChevronRight className={cn(
                            "h-4 w-4 md:h-5 md:w-5 transition-all duration-500 opacity-0 group-hover:opacity-100",
                            activeExecutionId === run.id ? "text-primary opacity-100 translate-x-1" : "text-muted-foreground"
                          )} />
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="p-20 md:p-32 text-center flex flex-col items-center gap-6 min-w-0">
                      <div className="h-16 w-16 md:h-20 md:w-20 rounded-3xl bg-muted/20 border border-border/30 flex items-center justify-center shadow-inner">
                        <Activity className="h-8 w-8 md:h-10 md:w-10 text-muted-foreground/20" />
                      </div>
                      <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground/50">No operational data.</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        <div className="hidden 2xl:flex flex-col min-h-0 min-w-0">
          <Card ref={detailCardRef} className="bg-card/30 border-border/40 shadow-2xl overflow-hidden flex-1 flex flex-col backdrop-blur-xl rounded-3xl min-w-0">
            {!activeExecutionId ? (
              <div className="flex-1 flex flex-col items-center justify-center p-16 text-center bg-muted/5 min-w-0">
                <div className="h-24 w-24 rounded-[2.5rem] bg-muted/20 border border-border/20 flex items-center justify-center mb-8 shadow-inner">
                  <Zap className="h-12 w-12 text-muted-foreground/30" />
                </div>
                <h3 className="text-xl font-bold tracking-tight">Trace Inspector</h3>
                <p className="text-sm text-muted-foreground/70 font-medium max-w-[280px] mt-3 leading-relaxed">
                  Select an operational flow to perform deep-packet inspection.
                </p>
              </div>
            ) : activeLoadingDetail ? (
              <div className="p-10 space-y-10 flex-1 min-w-0">
                <div className="flex items-center gap-6">
                  <Skeleton className="h-16 w-16 rounded-2xl opacity-40" />
                  <div className="space-y-3">
                    <Skeleton className="h-6 w-56 opacity-40" />
                    <Skeleton className="h-4 w-32 opacity-20" />
                  </div>
                </div>
                <Skeleton className="h-[400px] w-full rounded-3xl opacity-10" />
              </div>
            ) : (
              <>
                <div className="p-6 md:p-8 border-b border-border/40 bg-muted/20 flex items-center justify-between backdrop-blur-sm shrink-0 min-w-0">
                  <div className="flex items-center gap-4 md:gap-6 min-w-0">
                    <div className="h-12 w-12 md:h-16 md:w-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-lg shrink-0">
                      <Activity className="h-6 w-6 md:h-8 md:w-8" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-base md:text-lg font-bold truncate pr-4 tracking-tight">{activeDetail?.id.slice(0, 16)}...</div>
                      <div className="flex items-center gap-3 mt-1.5">
                        {statusBadge(activeDetail?.status)}
                        <Badge variant="outline" className="text-[10px] font-bold uppercase tracking-widest bg-muted/30 border-border/20">{activeDetail?.channel}</Badge>
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-10 w-10 rounded-full hover:bg-accent/50 transition-colors shrink-0" onClick={() => updateFilters({ selected: null })}>
                    <X className="h-5 w-5" />
                  </Button>
                </div>

                <div className="px-6 md:px-8 py-4 md:py-6 border-b border-border/40 flex items-center gap-6 md:gap-8 bg-muted/10 shrink-0 min-w-0">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 truncate">Operator</div>
                    <div className="text-sm font-bold truncate text-foreground/90">{activeDetail?.userEmail || 'System Core'}</div>
                  </div>
                  <Separator orientation="vertical" className="h-10 bg-border/40" />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 truncate">Runtime</div>
                    <div className="text-sm font-bold text-foreground/90 truncate">{formatDuration(activeDetail?.durationMs)}</div>
                  </div>
                </div>

                <ScrollArea className="flex-1 min-h-0 min-w-0">
                  <div className="p-6 md:p-8 space-y-8 md:space-y-10 min-w-0">
                    {activeSynthesisEvent && (
                      <div className="space-y-4 min-w-0">
                        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
                          <ArrowUpRight className="h-4 w-4 shrink-0" />
                          Final Synthesis
                        </div>
                        <div className="p-5 md:p-6 rounded-2xl bg-primary/5 border border-primary/10 text-sm font-medium leading-relaxed text-foreground whitespace-pre-wrap italic shadow-inner min-w-0">
                          "{activeSynthesisEvent.summary}"
                        </div>
                      </div>
                    )}

                    <div className="space-y-6 min-w-0">
                      <div className="flex items-center justify-between gap-4 min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60 truncate">Event Log</div>
                        <Badge variant="secondary" className="text-[10px] h-5 font-bold px-2 bg-muted/30 border-border/20 shrink-0">{activeEvents.length} Sequence Nodes</Badge>
                      </div>

                      <div className="relative pl-6 border-l-2 border-border/40 space-y-8 ml-3 min-w-0">
                        {activeEvents.map((event, i) => {
                          const isOpen = expandedPayloads[event.id]
                          return (
                            <div key={event.id} className="relative group/event min-w-0">
                              <div className={cn(
                                "absolute -left-[33px] top-1 h-4 w-4 rounded-full bg-background border-4 transition-all duration-500 shadow-sm",
                                isOpen ? "border-primary scale-125 shadow-[0_0_10px_rgba(var(--primary),0.5)]" : "border-border group-hover/event:border-primary/50"
                              )} />
                              <div className="space-y-2 min-w-0">
                                <div className="flex items-center justify-between gap-4 min-w-0">
                                  <span className="text-sm font-bold text-foreground/90 leading-tight truncate">{event.title}</span>
                                  <span className="text-[10px] font-bold text-muted-foreground/50 tabular-nums uppercase shrink-0">{new Date(event.createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                </div>
                                {event.summary && (
                                  <p className="text-[13px] text-muted-foreground/80 font-medium leading-relaxed pr-2 min-w-0">{event.summary}</p>
                                )}
                                <div className="flex items-center gap-3 min-w-0 flex-wrap">
                                  <Badge variant="outline" className="text-[9px] font-bold h-4 px-1.5 uppercase tracking-widest border-border/40 text-muted-foreground/70 bg-muted/10 font-mono shrink-0">
                                    {event.phase}
                                  </Badge>
                                  {event.payload && (
                                    <button 
                                      onClick={() => setExpandedPayloads(prev => ({ ...prev, [event.id]: !isOpen }))}
                                      className="text-[10px] font-bold text-primary hover:underline uppercase tracking-widest decoration-2 underline-offset-4 shrink-0"
                                    >
                                      {isOpen ? 'Close' : 'Payload'}
                                    </button>
                                  )}
                                </div>
                                {isOpen && event.payload && (
                                  <div className="mt-4 p-4 md:p-5 rounded-2xl bg-black/40 border border-border/40 overflow-hidden shadow-2xl animate-in zoom-in-95 duration-300 min-w-0">
                                    <pre className="text-[10px] font-mono text-zinc-400 overflow-auto max-h-[400px] custom-scrollbar leading-relaxed">
                                      {JSON.stringify(event.payload, null, 2)}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </ScrollArea>

                <div className="p-4 md:p-6 border-t border-border/40 bg-muted/20 shrink-0 min-w-0">
                  <div className="flex items-center justify-between gap-4 text-[10px] text-muted-foreground/50 font-bold uppercase tracking-[0.2em] min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Shield className="h-3 w-3 shrink-0" />
                      <span className="truncate">REQ: {activeDetail?.requestId?.slice(0, 12) || 'N/A'}</span>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <Layers className="h-3 w-3 shrink-0" />
                      <span className="truncate">THRD: {activeDetail?.threadId?.slice(0, 12) || 'N/A'}</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </TooltipProvider>
  )
}
