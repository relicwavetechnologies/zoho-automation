import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  Brain,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Layers,
  MessageSquare,
  Search,
  Sparkles,
  Wand2,
  Wrench,
} from 'lucide-react'

import { useAdminAuth } from '../auth/AdminAuthProvider'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../components/ui/resizable'
import { ScrollArea } from '../components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Separator } from '../components/ui/separator'
import { Skeleton } from '../components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'
import { toast } from '../components/ui/use-toast'
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

type ExecutionDemandInsight = {
  family: string
  demandCount: number
  uniqueUsers: number
  sampleQueries: string[]
  channels: Partial<Record<'desktop' | 'lark', number>>
}

type ExecutionCapabilityGapInsight = {
  gapKey: string
  label: string
  family: string
  gapCount: number
  uniqueUsers: number
  sampleQueries: string[]
  reasons: string[]
  channels: Partial<Record<'desktop' | 'lark', number>>
}

type ExecutionInsightsResponse = {
  topDemandedFamilies: ExecutionDemandInsight[]
  topCapabilityGaps: ExecutionCapabilityGapInsight[]
}

type InspectorSection = {
  key: string
  title: string
  content: string
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'accent'
}

const DEFAULT_PAGE_SIZE = 25
const phaseLabel: Record<ExecutionPhase, string> = {
  request: 'Request',
  planning: 'Planning',
  tool: 'Tools',
  synthesis: 'Synthesis',
  delivery: 'Delivery',
  error: 'Errors',
  control: 'Control',
}

const toneClasses: Record<NonNullable<InspectorSection['tone']>, string> = {
  default: 'border-border/30 bg-muted/10 text-foreground',
  accent: 'border-primary/20 bg-primary/5 text-foreground',
  success: 'border-emerald-500/20 bg-emerald-500/5 text-foreground',
  warning: 'border-amber-500/20 bg-amber-500/5 text-foreground',
  danger: 'border-red-500/20 bg-red-500/5 text-foreground',
}

const isoDate = (offsetDays: number): string => {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

const formatDateTime = (value: string): string =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

const formatTime = (value: string): string =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

const formatDuration = (durationMs?: number | null): string => {
  if (!durationMs || durationMs < 1000) return 'under 1s'
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

const truncate = (value: string | null | undefined, maxChars: number): string => {
  const trimmed = value?.trim()
  if (!trimmed) return ''
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed
}

const stringifyValue = (value: unknown, fallback = 'None'): string => {
  if (value == null) return fallback
  if (typeof value === 'string') return value.trim() || fallback
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

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

const eventIcon = (event: ExecutionEvent) => {
  if (event.payload?.failureDetail || event.phase === 'error' || event.status === 'failed') {
    return AlertTriangle
  }
  if (event.payload?.toolResult || event.phase === 'tool') {
    return Wrench
  }
  if (event.payload?.modelInput || event.actorType === 'model') {
    return Brain
  }
  if (event.payload?.finalOutcome || event.phase === 'synthesis') {
    return Sparkles
  }
  if (event.payload?.decisionState || event.eventType.startsWith('plan.')) {
    return Wand2
  }
  return Layers
}

const buildRequestPreview = (run: ExecutionRun | null, events: ExecutionEvent[]): string => {
  const requestEvent = events.find((event) => event.phase === 'request')
  const requestContext = recordOf(requestEvent?.payload?.requestContext)
  const requestSummary = recordOf(requestEvent?.payload?.requestSummary)
  return (
    (typeof requestContext?.originalPrompt === 'string' ? requestContext.originalPrompt : null) ||
    (typeof requestSummary?.originalPromptPreview === 'string' ? requestSummary.originalPromptPreview : null) ||
    run?.latestSummary ||
    'No prompt captured.'
  )
}

const buildDecisionSummary = (events: ExecutionEvent[]): string | null => {
  const finalOutcome = [...events].reverse().find((event) => recordOf(event.payload?.finalOutcome))
  if (finalOutcome?.summary) return finalOutcome.summary

  const decisionEvent = [...events].reverse().find((event) => recordOf(event.payload?.decisionState) || event.eventType.startsWith('plan.'))
  if (!decisionEvent) return null
  const decisionState = recordOf(decisionEvent.payload?.decisionState)
  return (
    (typeof decisionState?.summary === 'string' ? decisionState.summary : null) ||
    decisionEvent.summary ||
    null
  )
}

const buildFailureSummary = (run: ExecutionRun | null, events: ExecutionEvent[]): string | null => {
  const failedEvent = [...events].reverse().find((event) => recordOf(event.payload?.failureDetail) || event.phase === 'error' || event.status === 'failed')
  if (!failedEvent) return run?.errorMessage ?? null
  const failure = recordOf(failedEvent.payload?.failureDetail)
  return (
    (typeof failure?.errorMessage === 'string' ? failure.errorMessage : null) ||
    failedEvent.summary ||
    run?.errorMessage ||
    null
  )
}

const buildInspectorSections = (event: ExecutionEvent | null): InspectorSection[] => {
  if (!event) return []
  const payload = event.payload ?? {}
  const sections: InspectorSection[] = []
  const requestContext = recordOf(payload.requestContext)
  const requestSummary = recordOf(payload.requestSummary)
  const modelInput = recordOf(payload.modelInput)
  const modelInputSummary = recordOf(payload.modelInputSummary)
  const decisionState = recordOf(payload.decisionState)
  const toolCall = recordOf(payload.toolCall)
  const toolCallSummary = recordOf(payload.toolCallSummary)
  const toolResult = recordOf(payload.toolResult)
  const toolResultSummary = recordOf(payload.toolResultSummary)
  const failureDetail = recordOf(payload.failureDetail)
  const finalOutcome = recordOf(payload.finalOutcome)

  if (requestContext || requestSummary) {
    sections.push({
      key: 'request',
      title: 'What the user asked',
      tone: 'accent',
      content: [
        typeof requestContext?.originalPrompt === 'string'
          ? requestContext.originalPrompt
          : typeof requestSummary?.originalPromptPreview === 'string'
            ? requestSummary.originalPromptPreview
            : event.summary || '',
        typeof requestSummary?.channel === 'string' ? `\nChannel: ${requestSummary.channel}` : '',
      ].join('').trim(),
    })
  }

  if (modelInput || modelInputSummary) {
    const messages = Array.isArray(modelInput?.messages) ? modelInput.messages : []
    const formattedMessages = messages
      .map((message) => {
        const record = recordOf(message)
        if (!record) return null
        return `[${String(record.index ?? '?')}] ${String(record.role ?? 'message')}\n${String(record.content ?? '')}`
      })
      .filter(Boolean)
      .join('\n\n')

    sections.push({
      key: 'model-input',
      title: 'What the AI saw',
      tone: 'accent',
      content: [
        typeof modelInputSummary?.label === 'string' ? `Input: ${modelInputSummary.label}` : '',
        modelInputSummary?.contextSummary ? `Context summary:\n${stringifyValue(modelInputSummary.contextSummary)}` : '',
        typeof modelInput?.systemPrompt === 'string' ? `System prompt:\n${modelInput.systemPrompt}` : '',
        formattedMessages ? `Messages:\n${formattedMessages}` : '',
      ].filter(Boolean).join('\n\n'),
    })
  }

  if (decisionState || event.eventType.startsWith('plan.')) {
    sections.push({
      key: 'decision',
      title: 'Decision / system state',
      tone: 'default',
      content: [
        typeof decisionState?.summary === 'string' ? decisionState.summary : event.summary || '',
        decisionState?.details ? `Details:\n${stringifyValue(decisionState.details)}` : '',
        event.eventType.startsWith('plan.') && payload.plan ? `Plan:\n${stringifyValue(payload.plan)}` : '',
      ].filter(Boolean).join('\n\n'),
    })
  }

  if (toolCall || toolCallSummary) {
    sections.push({
      key: 'tool-call',
      title: 'Tool call',
      tone: 'default',
      content: [
        typeof toolCallSummary?.title === 'string' ? toolCallSummary.title : event.title,
        toolCall?.toolInput ? `Tool input:\n${stringifyValue(toolCall.toolInput)}` : '',
        toolCall?.sourceContext ? `Source context:\n${stringifyValue(toolCall.sourceContext)}` : '',
      ].filter(Boolean).join('\n\n'),
    })
  }

  if (toolResult || toolResultSummary) {
    sections.push({
      key: 'tool-result',
      title: 'Tool result',
      tone: toolResultSummary?.success === false ? 'danger' : 'success',
      content: [
        typeof toolResult?.summary === 'string'
          ? toolResult.summary
          : typeof toolResultSummary?.summary === 'string'
            ? toolResultSummary.summary
            : event.summary || '',
        toolResult?.resultExcerpt ? `Result excerpt:\n${stringifyValue(toolResult.resultExcerpt)}` : '',
        toolResult?.error ? `Error:\n${stringifyValue(toolResult.error)}` : '',
        toolResult?.pendingApprovalAction ? `Pending approval:\n${stringifyValue(toolResult.pendingApprovalAction)}` : '',
      ].filter(Boolean).join('\n\n'),
    })
  }

  if (failureDetail) {
    sections.push({
      key: 'failure',
      title: 'Failure / fallback',
      tone: 'danger',
      content: [
        typeof failureDetail.errorMessage === 'string' ? failureDetail.errorMessage : event.summary || '',
        typeof failureDetail.stage === 'string' ? `Stage: ${failureDetail.stage}` : '',
        failureDetail.details ? `Details:\n${stringifyValue(failureDetail.details)}` : '',
      ].filter(Boolean).join('\n\n'),
    })
  }

  if (finalOutcome) {
    sections.push({
      key: 'outcome',
      title: 'Final outcome',
      tone: 'success',
      content: [
        typeof finalOutcome.finalText === 'string' ? finalOutcome.finalText : event.summary || '',
        finalOutcome.details ? `Details:\n${stringifyValue(finalOutcome.details)}` : '',
      ].filter(Boolean).join('\n\n'),
    })
  }

  if (sections.length === 0 && event.summary) {
    sections.push({
      key: 'summary',
      title: 'Step summary',
      content: event.summary,
    })
  }

  return sections
}

const formatRunSummaryText = (run: ExecutionRun | null, events: ExecutionEvent[]): string => [
  `Execution ${run?.id ?? ''}`,
  `Status: ${run?.status ?? 'unknown'}`,
  `Channel: ${run?.channel ?? 'unknown'}`,
  `Mode: ${run?.mode ?? 'unknown'}`,
  `Started: ${run?.startedAt ? formatDateTime(run.startedAt) : 'unknown'}`,
  `Duration: ${formatDuration(run?.durationMs)}`,
  '',
  'Prompt',
  buildRequestPreview(run, events),
  '',
  'Final Decision',
  buildDecisionSummary(events) ?? 'No final decision captured.',
  '',
  'Failure',
  buildFailureSummary(run, events) ?? 'No failure captured.',
].join('\n')

const formatEventExport = (event: ExecutionEvent): string => {
  const sections = buildInspectorSections(event)
  return [
    `Step ${event.sequence}: ${event.title}`,
    `Phase: ${phaseLabel[event.phase]} | Actor: ${event.actorType}${event.actorKey ? ` (${event.actorKey})` : ''} | Status: ${event.status ?? 'unknown'} | Time: ${formatTime(event.createdAt)}`,
    event.summary ? `Summary: ${event.summary}` : null,
    '',
    ...sections.map((section) => `${section.title}\n${section.content}`),
    event.payload ? `Raw payload\n${JSON.stringify(event.payload, null, 2)}` : null,
  ].filter(Boolean).join('\n\n')
}

const formatFullRunExport = (run: ExecutionRun | null, events: ExecutionEvent[]): string => [
  formatRunSummaryText(run, events),
  '',
  'Timeline',
  ...events.map((event) => formatEventExport(event)),
].join('\n\n')

const compactInsightText = (items: Array<{ label: string; detail: string }>, emptyText: string) =>
  items.length > 0 ? items : [{ label: 'No signals', detail: emptyText }]

export const ExecutionsPage = () => {
  const { token } = useAdminAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [runs, setRuns] = useState<ExecutionRun[]>([])
  const [summary, setSummary] = useState<ExecutionListResponse['summary'] | null>(null)
  const [insights, setInsights] = useState<ExecutionInsightsResponse | null>(null)
  const [total, setTotal] = useState(0)
  const [detailById, setDetailById] = useState<Record<string, ExecutionRun>>({})
  const [eventsById, setEventsById] = useState<Record<string, ExecutionEvent[]>>({})
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingDetailById, setLoadingDetailById] = useState<Record<string, boolean>>({})
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({})

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

  const updateFilters = useCallback((updates: Record<string, string | null>, options?: { preservePage?: boolean }) => {
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
  }, [searchParams, setSearchParams])

  const activeExecutionId = filters.selected
  const activeDetail = activeExecutionId ? detailById[activeExecutionId] ?? runs.find((run) => run.id === activeExecutionId) ?? null : null
  const activeEvents = activeExecutionId ? eventsById[activeExecutionId] ?? [] : []
  const activeLoadingDetail = activeExecutionId ? loadingDetailById[activeExecutionId] ?? false : false
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE))

  const activeEvent = useMemo(() => {
    if (activeEvents.length === 0) return null
    return activeEvents.find((event) => event.id === selectedEventId) ?? activeEvents[activeEvents.length - 1] ?? null
  }, [activeEvents, selectedEventId])

  const activeSections = useMemo(() => buildInspectorSections(activeEvent), [activeEvent])
  const demandItems = compactInsightText(
    (insights?.topDemandedFamilies ?? []).slice(0, 3).map((item) => ({
      label: `${item.family} (${item.demandCount})`,
      detail: item.sampleQueries[0] ?? `${item.uniqueUsers} users`,
    })),
    'No demanded tool families in this range.',
  )
  const gapItems = compactInsightText(
    (insights?.topCapabilityGaps ?? []).slice(0, 3).map((item) => ({
      label: `${item.family} (${item.gapCount})`,
      detail: item.reasons[0] ?? item.label,
    })),
    'No capability gaps in this range.',
  )

  const copyText = useCallback(async (title: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title, description: 'Copied to clipboard.', variant: 'success' })
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard access is unavailable.', variant: 'destructive' })
    }
  }, [])

  const loadRuns = useCallback(async () => {
    if (!token) return
    setLoadingRuns(true)
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
      if (!filters.selected && response.items[0]) {
        updateFilters({ selected: response.items[0].id }, { preservePage: true })
      }
    } finally {
      setLoadingRuns(false)
    }
  }, [filters.actorType, filters.channel, filters.dateFrom, filters.dateTo, filters.mode, filters.page, filters.phase, filters.query, filters.selected, filters.status, token, updateFilters])

  const loadInsights = useCallback(async () => {
    if (!token) return
    const query = new URLSearchParams({
      page: '1',
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
    const response = await api.get<ExecutionInsightsResponse>(`/api/admin/executions/insights?${query.toString()}`, token)
    setInsights(response)
  }, [filters.actorType, filters.channel, filters.dateFrom, filters.dateTo, filters.mode, filters.phase, filters.query, filters.status, token])

  const loadDetail = useCallback(async (executionId: string) => {
    if (!token || !executionId) return
    setLoadingDetailById((prev) => ({ ...prev, [executionId]: true }))
    try {
      const [runResponse, eventsResponse] = await Promise.all([
        api.get<{ run: ExecutionRun }>(`/api/admin/executions/${executionId}`, token),
        api.get<{ items: ExecutionEvent[] }>(`/api/admin/executions/${executionId}/events`, token),
      ])
      setDetailById((prev) => ({ ...prev, [executionId]: runResponse.run }))
      setEventsById((prev) => ({ ...prev, [executionId]: eventsResponse.items }))
      setSelectedEventId((current) => current && eventsResponse.items.some((item) => item.id === current)
        ? current
        : (eventsResponse.items[eventsResponse.items.length - 1]?.id ?? null))
    } finally {
      setLoadingDetailById((prev) => ({ ...prev, [executionId]: false }))
    }
  }, [token])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  useEffect(() => {
    void loadInsights()
  }, [loadInsights])

  useEffect(() => {
    if (activeExecutionId) {
      void loadDetail(activeExecutionId)
    }
  }, [activeExecutionId, loadDetail])

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col gap-6 p-4 md:p-6 lg:p-8 rounded-3xl border border-border/40 bg-card/30 backdrop-blur-xl shadow-2xl min-w-0">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
            <Input
              value={filters.query}
              onChange={(event) => updateFilters({ query: event.target.value || null })}
              placeholder="Search execution runs..."
              className="bg-background/50 border-border/30 h-11 pl-12 rounded-xl"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Select value={filters.channel} onValueChange={(value) => updateFilters({ channel: value })}>
              <SelectTrigger className="bg-background/50 border-border/30 h-11 w-[150px] rounded-xl text-xs font-bold uppercase tracking-widest">
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                <SelectItem value="desktop">Desktop</SelectItem>
                <SelectItem value="lark">Lark</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.status} onValueChange={(value) => updateFilters({ status: value })}>
              <SelectTrigger className="bg-background/50 border-border/30 h-11 w-[150px] rounded-xl text-xs font-bold uppercase tracking-widest">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2 bg-background/50 border border-border/30 rounded-xl px-3 h-11">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground/60" />
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(event) => updateFilters({ dateFrom: event.target.value })}
                className="bg-transparent text-[10px] font-bold uppercase tracking-wider outline-none text-foreground w-[92px]"
              />
              <Separator orientation="vertical" className="h-4 bg-border/40" />
              <input
                type="date"
                value={filters.dateTo}
                onChange={(event) => updateFilters({ dateTo: event.target.value })}
                className="bg-transparent text-[10px] font-bold uppercase tracking-wider outline-none text-foreground w-[92px]"
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          {[
            { label: 'Total', value: summary?.totalRuns ?? 0 },
            { label: 'Failures', value: summary?.failedRuns ?? 0, color: 'text-red-500' },
            { label: 'Active', value: summary?.activeRuns ?? 0, color: 'text-amber-500' },
            { label: 'Desktop', value: summary?.byChannel.desktop ?? 0 },
            { label: 'Lark', value: summary?.byChannel.lark ?? 0 },
            { label: 'Xtreme', value: summary?.byMode.xtreme ?? 0, color: 'text-primary' },
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-border/30 bg-muted/10 px-4 py-3 space-y-1.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">{item.label}</div>
              <div className={cn('text-xl font-bold tracking-tight', item.color)}>{item.value}</div>
            </div>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="bg-card/20 border-border/40 rounded-3xl">
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-bold tracking-tight">Demand snapshot</CardTitle>
              <CardDescription>Top requested tool families in the selected window.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {demandItems.map((item) => (
                <div key={`${item.label}-${item.detail}`} className="rounded-2xl border border-border/30 bg-muted/10 px-4 py-3">
                  <div className="text-sm font-semibold">{item.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">{item.detail}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-card/20 border-border/40 rounded-3xl">
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-bold tracking-tight">Capability gaps</CardTitle>
              <CardDescription>Where selection or execution still misses the ask.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {gapItems.map((item) => (
                <div key={`${item.label}-${item.detail}`} className="rounded-2xl border border-border/30 bg-muted/10 px-4 py-3">
                  <div className="text-sm font-semibold">{item.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">{item.detail}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <ResizablePanelGroup direction="horizontal" className="mt-8 h-[calc(100vh-340px)] min-h-[680px] min-w-0">
        <ResizablePanel defaultSize={28} minSize={22} className="min-w-0">
          <Card className="h-full rounded-3xl border-border/40 bg-card/20 shadow-2xl overflow-hidden">
            <CardHeader className="border-b border-border/40 bg-muted/20 p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle className="text-lg font-bold tracking-tight">Recent prompts</CardTitle>
                  <CardDescription>Every recorded run in the current filter window.</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 rounded-xl border-border/40 bg-background/50"
                    disabled={filters.page <= 1}
                    onClick={() => updateFilters({ page: String(filters.page - 1) }, { preservePage: true })}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="rounded-xl border border-border/20 bg-muted/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em]">
                    {filters.page} / {totalPages}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 rounded-xl border-border/40 bg-background/50"
                    disabled={filters.page >= totalPages}
                    onClick={() => updateFilters({ page: String(filters.page + 1) }, { preservePage: true })}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0 h-[calc(100%-88px)]">
              <ScrollArea className="h-full">
                <div className="divide-y divide-border/30">
                  {loadingRuns ? (
                    Array.from({ length: 8 }).map((_, index) => (
                      <div key={index} className="p-5 space-y-3">
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="h-4 w-full" />
                      </div>
                    ))
                  ) : runs.length > 0 ? (
                    runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => updateFilters({ selected: run.id }, { preservePage: true })}
                        className={cn(
                          'w-full text-left px-5 py-4 transition-colors hover:bg-primary/[0.04]',
                          activeExecutionId === run.id && 'bg-primary/[0.06]',
                        )}
                      >
                        <div className="flex items-start gap-4">
                          <div className={cn(
                            'mt-1 flex h-11 w-11 items-center justify-center rounded-2xl border shrink-0',
                            activeExecutionId === run.id
                              ? 'border-primary/20 bg-primary/10 text-primary'
                              : 'border-border/30 bg-muted/20 text-muted-foreground',
                          )}>
                            {run.channel === 'lark' ? <MessageSquare className="h-5 w-5" /> : <Activity className="h-5 w-5" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="font-semibold truncate">{run.userEmail || run.userName || 'System Auth'}</div>
                              {statusBadge(run.status)}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground line-clamp-2">
                              {buildRequestPreview(run, eventsById[run.id] ?? [])}
                            </div>
                            <div className="mt-3 flex items-center gap-3 flex-wrap text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60 font-bold">
                              <span>{formatDuration(run.durationMs)}</span>
                              <span>{run.eventCount} events</span>
                              <span>{formatDateTime(run.startedAt)}</span>
                              {run.mode ? <Badge variant="outline" className="h-5 bg-primary/5 border-primary/20 text-primary">{run.mode}</Badge> : null}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="p-16 text-center text-sm text-muted-foreground">No execution runs found in this range.</div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={72} minSize={35} className="min-w-0">
          <Card className="h-full rounded-3xl border-border/40 bg-card/30 shadow-2xl overflow-hidden">
            {!activeExecutionId ? (
              <div className="flex h-full items-center justify-center p-16 text-center">
                <div>
                  <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[2rem] border border-border/30 bg-muted/20">
                    <Activity className="h-10 w-10 text-muted-foreground/30" />
                  </div>
                  <h3 className="text-xl font-bold tracking-tight">Agent Run Inspector</h3>
                  <p className="mt-3 max-w-sm text-sm text-muted-foreground">Select a run to inspect what the model saw, what each tool returned, what the system decided, and what broke.</p>
                </div>
              </div>
            ) : activeLoadingDetail ? (
              <div className="p-8 space-y-6">
                <Skeleton className="h-10 w-72" />
                <Skeleton className="h-[500px] w-full rounded-3xl" />
              </div>
            ) : (
              <>
                <div className="border-b border-border/40 bg-muted/20 p-6">
                  <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h2 className="text-xl font-bold tracking-tight">Run {activeDetail?.id.slice(0, 12)}</h2>
                        {statusBadge(activeDetail?.status)}
                        <Badge variant="outline" className="h-5 uppercase tracking-[0.2em] text-[10px]">{activeDetail?.channel}</Badge>
                      </div>
                      <div className="mt-2 text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-bold flex flex-wrap gap-3">
                        <span>{activeDetail?.companyName || activeDetail?.companyId}</span>
                        <span>{activeDetail?.userEmail || activeDetail?.userName || 'System Auth'}</span>
                        <span>{formatDuration(activeDetail?.durationMs)}</span>
                        <span>{formatDateTime(activeDetail?.startedAt ?? new Date().toISOString())}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        className="rounded-xl border-border/40 bg-background/50"
                        onClick={() => void copyText('Run summary copied', formatRunSummaryText(activeDetail, activeEvents))}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        Copy run summary
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-xl border-border/40 bg-background/50"
                        onClick={() => void copyText('Full run copied', formatFullRunExport(activeDetail, activeEvents))}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        Copy full run
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-xl border-border/40 bg-background/50"
                        disabled={!activeEvent}
                        onClick={() => activeEvent ? void copyText('Current step copied', formatEventExport(activeEvent)) : undefined}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        Copy current step
                      </Button>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 xl:grid-cols-[1.3fr,1fr,1fr]">
                    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Original prompt</div>
                      <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{buildRequestPreview(activeDetail, activeEvents)}</div>
                    </div>
                    <div className="rounded-2xl border border-border/30 bg-muted/10 p-4">
                      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">Final decision</div>
                      <div className="mt-2 text-sm leading-relaxed">{buildDecisionSummary(activeEvents) ?? 'No decision event captured.'}</div>
                    </div>
                    <div className="rounded-2xl border border-border/30 bg-muted/10 p-4">
                      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">What broke</div>
                      <div className="mt-2 text-sm leading-relaxed">{buildFailureSummary(activeDetail, activeEvents) ?? 'No failure captured for this run.'}</div>
                    </div>
                  </div>
                </div>

                <ResizablePanelGroup direction="horizontal" className="h-[calc(100%-240px)] min-h-0">
                  <ResizablePanel defaultSize={34} minSize={24} className="min-w-0 border-r border-border/30">
                    <div className="flex h-full flex-col min-h-0">
                      <div className="px-5 py-4 border-b border-border/30">
                        <div className="text-sm font-semibold">Step timeline</div>
                        <div className="text-xs text-muted-foreground mt-1">Select a step to inspect its live context, tool state, and output.</div>
                      </div>
                      <ScrollArea className="flex-1">
                        <div className="divide-y divide-border/20">
                          {activeEvents.map((event) => {
                            const Icon = eventIcon(event)
                            return (
                              <button
                                key={event.id}
                                type="button"
                                onClick={() => setSelectedEventId(event.id)}
                                className={cn(
                                  'w-full text-left px-5 py-4 hover:bg-primary/[0.04] transition-colors',
                                  activeEvent?.id === event.id && 'bg-primary/[0.06]',
                                )}
                              >
                                <div className="flex items-start gap-3">
                                  <div className={cn(
                                    'mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border shrink-0',
                                    activeEvent?.id === event.id
                                      ? 'border-primary/20 bg-primary/10 text-primary'
                                      : 'border-border/30 bg-muted/20 text-muted-foreground',
                                  )}>
                                    <Icon className="h-4 w-4" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <div className="font-medium truncate">{event.title}</div>
                                      {statusBadge(event.status)}
                                    </div>
                                    <div className="mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-bold flex flex-wrap gap-2">
                                      <span>{phaseLabel[event.phase]}</span>
                                      <span>{event.actorType}</span>
                                      <span>{formatTime(event.createdAt)}</span>
                                    </div>
                                    {event.summary ? (
                                      <div className="mt-2 text-sm text-muted-foreground line-clamp-3">{event.summary}</div>
                                    ) : null}
                                  </div>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </ScrollArea>
                    </div>
                  </ResizablePanel>

                  <ResizableHandle withHandle />

                  <ResizablePanel defaultSize={66} minSize={34} className="min-w-0">
                    <div className="flex h-full flex-col min-h-0">
                      {activeEvent ? (
                        <>
                          <div className="px-6 py-5 border-b border-border/30">
                            <div className="flex items-center justify-between gap-4">
                              <div className="min-w-0">
                                <div className="flex items-center gap-3 flex-wrap">
                                  <div className="text-lg font-bold tracking-tight truncate">{activeEvent.title}</div>
                                  {statusBadge(activeEvent.status)}
                                </div>
                                <div className="mt-2 text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-bold flex flex-wrap gap-3">
                                  <span>Step {activeEvent.sequence}</span>
                                  <span>{phaseLabel[activeEvent.phase]}</span>
                                  <span>{activeEvent.actorType}{activeEvent.actorKey ? ` • ${activeEvent.actorKey}` : ''}</span>
                                  <span>{formatTime(activeEvent.createdAt)}</span>
                                </div>
                              </div>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="rounded-xl border-border/40 bg-background/50"
                                    onClick={() => void copyText('Current step copied', formatEventExport(activeEvent))}
                                  >
                                    <Copy className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copy current step</TooltipContent>
                              </Tooltip>
                            </div>
                            {activeEvent.summary ? (
                              <div className="mt-4 rounded-2xl border border-border/30 bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
                                {activeEvent.summary}
                              </div>
                            ) : null}
                          </div>

                          <ScrollArea className="flex-1">
                            <div className="p-6 space-y-4">
                              {activeSections.map((section) => (
                                <div key={section.key} className={cn('rounded-2xl border p-4', toneClasses[section.tone ?? 'default'])}>
                                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] mb-3">{section.title}</div>
                                  <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed font-sans">
                                    {section.content}
                                  </pre>
                                </div>
                              ))}

                              <div className="rounded-2xl border border-border/30 bg-muted/10 p-4">
                                <div className="flex items-center justify-between gap-4">
                                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">Raw payload</div>
                                  {activeEvent.payload ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 px-3 text-[10px] uppercase tracking-[0.2em]"
                                      onClick={() => setExpandedPayloads((prev) => ({ ...prev, [activeEvent.id]: !prev[activeEvent.id] }))}
                                    >
                                      {expandedPayloads[activeEvent.id] ? 'Hide' : 'Show'}
                                    </Button>
                                  ) : null}
                                </div>
                                {expandedPayloads[activeEvent.id] && activeEvent.payload ? (
                                  <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/20 bg-black/30 p-4 text-xs text-zinc-300">
                                    {JSON.stringify(activeEvent.payload, null, 2)}
                                  </pre>
                                ) : (
                                  <div className="mt-3 text-sm text-muted-foreground">
                                    {activeEvent.payload ? 'Expand to inspect the raw event payload.' : 'No payload captured for this step.'}
                                  </div>
                                )}
                              </div>
                            </div>
                          </ScrollArea>
                        </>
                      ) : (
                        <div className="flex h-full items-center justify-center p-16 text-center text-sm text-muted-foreground">
                          Select a step from the timeline to inspect it.
                        </div>
                      )}
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>

                <div className="border-t border-border/30 bg-muted/20 px-6 py-4 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60 font-bold">
                  <div className="flex flex-wrap items-center gap-4">
                    <span>Request {activeDetail?.requestId?.slice(0, 12) || 'N/A'}</span>
                    <span>Task {activeDetail?.taskId?.slice(0, 12) || 'N/A'}</span>
                    <span>Thread {activeDetail?.threadId?.slice(0, 12) || 'N/A'}</span>
                    <span>Events {activeEvents.length}</span>
                  </div>
                </div>
              </>
            )}
          </Card>
        </ResizablePanel>
      </ResizablePanelGroup>
    </TooltipProvider>
  )
}
