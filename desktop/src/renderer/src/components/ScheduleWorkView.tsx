import { useEffect, useState } from 'react'
import {
  AlarmClock,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  CopyPlus,
  FolderClock,
  Layers3,
  Mail,
  MessageSquareShare,
  PanelTop,
  PencilLine,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  Workflow,
} from 'lucide-react'

import { useAuth } from '../context/AuthContext'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'one_time'
type WorkflowDraftStatus = 'draft' | 'reviewed' | 'published'
type ToolActionGroup = 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'

type WorkflowDraft = {
  id: string
  name: string
  userIntent: string
  frequency: ScheduleFrequency
  timezone: string
  time: string
  dayOfWeek: string
  dayOfMonth: number
  runDate: string
  desktopInbox: boolean
  desktopThread: boolean
  desktopThreadLabel: string
  larkChat: boolean
  larkChatLabel: string
  compiledPrompt?: string
  compilerNotes?: string
  compiledWorkflowSpec?: CompiledWorkflowSpec | null
  compiledCapabilitySummary?: CompiledWorkflowCapabilitySummary | null
  compiledModelId?: string | null
  lastCompiledAt?: string | null
  lastCompiledSourceFingerprint?: string | null
  publishedWorkflowId?: string | null
  publishedThreadId?: string | null
  publishedThreadTitle?: string | null
  lastPublishedAt?: string | null
  nextRunAt?: string | null
  lastPublishedSourceFingerprint?: string | null
  status: WorkflowDraftStatus
  updatedAt: string
}

type WorkflowCapabilityRef = {
  toolId: string
  actionGroup: ToolActionGroup
  operation: string
}

type CompiledWorkflowNode = {
  id: string
  kind: string
  title: string
  instructions?: string
  expectedOutput?: string
  capability?: WorkflowCapabilityRef
  destinationIds?: string[]
  approvalJustification?: string
}

type CompiledWorkflowSpec = {
  version: 'v1'
  name: string
  description?: string
  nodes: CompiledWorkflowNode[]
  edges: Array<{ sourceId: string; targetId: string; condition: string; label?: string }>
}

type CompiledWorkflowCapabilitySummary = {
  version: 'v1'
  requiredTools: string[]
  requiredActionGroupsByTool: Record<string, ToolActionGroup[]>
  operationsByTool: Record<string, string[]>
  expectedDestinationIds: string[]
  requiresPublishApproval: boolean
  capabilityFingerprint: string
}

type CompileWorkflowResponse = {
  workflowSpec: CompiledWorkflowSpec
  compiledPrompt: string
  compilerNotes: string
  capabilitySummary: CompiledWorkflowCapabilitySummary
  model: {
    provider: string
    modelId: string
  }
}

type PublishWorkflowResponse = {
  workflowId: string
  status: 'active'
  nextRunAt: string | null
  publishedAt: string
  primaryThreadId: string
  primaryThreadTitle: string | null
  capabilitySummary: CompiledWorkflowCapabilitySummary
}

type RunWorkflowResponse = {
  workflowId: string
  runId: string
  executionId: string | null
  status: 'succeeded' | 'failed' | 'blocked'
  threadId: string
  threadTitle: string | null
  resultSummary: string | null
  errorSummary: string | null
}

type PublishedWorkflowSummary = {
  id: string
  name: string
  status: 'draft' | 'active' | 'paused' | 'archived'
  userIntent: string
  workflowSpec: CompiledWorkflowSpec
  compiledPrompt: string
  capabilitySummary: CompiledWorkflowCapabilitySummary
  schedule: {
    type: 'daily' | 'weekly' | 'monthly' | 'one_time'
    timezone: string
    time?: { hour: number; minute: number }
    daysOfWeek?: string[]
    dayOfMonth?: number
    runAt?: string
  }
  outputConfig: {
    version: 'v1'
    destinations: Array<
      | { id: string; kind: 'desktop_inbox'; label?: string }
      | { id: string; kind: 'desktop_thread'; label?: string; threadId: string }
      | { id: string; kind: 'lark_chat'; label?: string; chatId: string }
    >
    defaultDestinationIds: string[]
  }
  publishedAt: string | null
  nextRunAt: string | null
  updatedAt: string
}

const STORAGE_KEY = 'cursorr_schedule_work_drafts_v1'
const WEEKDAY_OPTIONS = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
] as const

function createBlankDraft(): WorkflowDraft {
  const now = new Date()
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  return {
    id: `workflow-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Weekly ops digest',
    userIntent: 'Every Monday morning, review open issues, summarize risks, and send me a concise operations digest.',
    frequency: 'weekly',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
    time: '09:00',
    dayOfWeek: 'monday',
    dayOfMonth: 1,
    runDate: nextWeek.toISOString().slice(0, 10),
    desktopInbox: true,
    desktopThread: false,
    desktopThreadLabel: 'Leadership desk',
    larkChat: false,
    larkChatLabel: 'ops-alerts',
    compiledPrompt: '',
    compilerNotes: '',
    compiledWorkflowSpec: null,
    compiledCapabilitySummary: null,
    compiledModelId: null,
    lastCompiledAt: null,
    lastCompiledSourceFingerprint: null,
    publishedWorkflowId: null,
    publishedThreadId: null,
    publishedThreadTitle: null,
    lastPublishedAt: null,
    nextRunAt: null,
    lastPublishedSourceFingerprint: null,
    status: 'draft',
    updatedAt: new Date().toISOString(),
  }
}

function readDraftsFromStorage(): WorkflowDraft[] {
  if (typeof window === 'undefined') return [createBlankDraft()]

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return [createBlankDraft()]
    const parsed = JSON.parse(raw) as WorkflowDraft[]
    if (!Array.isArray(parsed) || parsed.length === 0) return [createBlankDraft()]
    return parsed
  } catch {
    return [createBlankDraft()]
  }
}

function formatScheduleLabel(draft: WorkflowDraft): string {
  if (draft.frequency === 'daily') {
    return `Daily at ${draft.time} (${draft.timezone})`
  }
  if (draft.frequency === 'weekly') {
    const weekday = WEEKDAY_OPTIONS.find((option) => option.value === draft.dayOfWeek)?.label ?? draft.dayOfWeek
    return `Every ${weekday} at ${draft.time} (${draft.timezone})`
  }
  if (draft.frequency === 'monthly') {
    return `Day ${draft.dayOfMonth} of each month at ${draft.time} (${draft.timezone})`
  }
  return `Once on ${draft.runDate} at ${draft.time} (${draft.timezone})`
}

function statusLabel(status: WorkflowDraftStatus): string {
  if (status === 'published') return 'Published'
  if (status === 'reviewed') return 'Ready'
  return 'Draft'
}

function createDraftSourceFingerprint(draft: WorkflowDraft): string {
  return JSON.stringify({
    name: draft.name,
    userIntent: draft.userIntent,
    frequency: draft.frequency,
    timezone: draft.timezone,
    time: draft.time,
    dayOfWeek: draft.dayOfWeek,
    dayOfMonth: draft.dayOfMonth,
    runDate: draft.runDate,
    desktopInbox: draft.desktopInbox,
    desktopThread: draft.desktopThread,
    desktopThreadLabel: draft.desktopThreadLabel,
    larkChat: draft.larkChat,
    larkChatLabel: draft.larkChatLabel,
  })
}

function buildCompileDestinations(draft: WorkflowDraft): Array<
  { kind: 'desktop_inbox'; label?: string }
  | { kind: 'desktop_thread'; label?: string; value?: string }
  | { kind: 'lark_chat'; label?: string; value?: string }
> {
  const destinations = [
    draft.desktopInbox ? { kind: 'desktop_inbox', label: 'Desktop inbox' as const } : null,
    draft.desktopThread ? { kind: 'desktop_thread', label: draft.desktopThreadLabel || 'Desktop thread', value: draft.desktopThreadLabel || 'desktop-thread' } : null,
    draft.larkChat ? { kind: 'lark_chat', label: draft.larkChatLabel || 'Lark chat', value: draft.larkChatLabel || 'lark-chat' } : null,
  ].filter(Boolean) as Array<
    { kind: 'desktop_inbox'; label?: string }
    | { kind: 'desktop_thread'; label?: string; value?: string }
    | { kind: 'lark_chat'; label?: string; value?: string }
  >

  return destinations.length > 0 ? destinations : [{ kind: 'desktop_inbox', label: 'Desktop inbox' }]
}

function formatDestinationLabels(draft: WorkflowDraft): string[] {
  return [
    draft.desktopInbox ? 'Desktop inbox' : null,
    draft.desktopThread ? `Desktop thread: ${draft.desktopThreadLabel || 'Selected thread'}` : null,
    draft.larkChat ? `Lark chat: ${draft.larkChatLabel || 'Configured chat'}` : null,
  ].filter(Boolean) as string[]
}

function describeCompiledNode(node: CompiledWorkflowNode): string {
  if (node.instructions) return node.instructions
  if (node.expectedOutput) return `Expected output: ${node.expectedOutput}`
  if (node.destinationIds && node.destinationIds.length > 0) return `Deliver to ${node.destinationIds.join(', ')}.`
  if (node.approvalJustification) return node.approvalJustification
  return 'Compiled workflow step.'
}

function isWriteActionGroup(actionGroup?: ToolActionGroup): boolean {
  return ['create', 'update', 'delete', 'send', 'execute'].includes(actionGroup ?? '')
}

function scheduleConfigToDraftFields(schedule: PublishedWorkflowSummary['schedule']): Pick<
  WorkflowDraft,
  'frequency' | 'timezone' | 'time' | 'dayOfWeek' | 'dayOfMonth' | 'runDate'
> {
  if (schedule.type === 'daily') {
    return {
      frequency: 'daily',
      timezone: schedule.timezone,
      time: `${String(schedule.time?.hour ?? 9).padStart(2, '0')}:${String(schedule.time?.minute ?? 0).padStart(2, '0')}`,
      dayOfWeek: 'monday',
      dayOfMonth: 1,
      runDate: new Date().toISOString().slice(0, 10),
    }
  }
  if (schedule.type === 'weekly') {
    const dayCode = schedule.daysOfWeek?.[0] ?? 'MO'
    const dayOfWeek = {
      MO: 'monday',
      TU: 'tuesday',
      WE: 'wednesday',
      TH: 'thursday',
      FR: 'friday',
      SA: 'saturday',
      SU: 'sunday',
    }[dayCode] ?? 'monday'
    return {
      frequency: 'weekly',
      timezone: schedule.timezone,
      time: `${String(schedule.time?.hour ?? 9).padStart(2, '0')}:${String(schedule.time?.minute ?? 0).padStart(2, '0')}`,
      dayOfWeek,
      dayOfMonth: 1,
      runDate: new Date().toISOString().slice(0, 10),
    }
  }
  if (schedule.type === 'monthly') {
    return {
      frequency: 'monthly',
      timezone: schedule.timezone,
      time: `${String(schedule.time?.hour ?? 9).padStart(2, '0')}:${String(schedule.time?.minute ?? 0).padStart(2, '0')}`,
      dayOfWeek: 'monday',
      dayOfMonth: schedule.dayOfMonth ?? 1,
      runDate: new Date().toISOString().slice(0, 10),
    }
  }
  return {
    frequency: 'one_time',
    timezone: schedule.timezone,
    time: schedule.runAt ? new Date(schedule.runAt).toISOString().slice(11, 16) : '09:00',
    dayOfWeek: 'monday',
    dayOfMonth: 1,
    runDate: schedule.runAt ? schedule.runAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
  }
}

function buildDraftFromPublishedWorkflow(workflow: PublishedWorkflowSummary): WorkflowDraft {
  const scheduleFields = scheduleConfigToDraftFields(workflow.schedule)
  const desktopThreadDestination = workflow.outputConfig.destinations.find((destination) => destination.kind === 'desktop_thread')
  const larkDestination = workflow.outputConfig.destinations.find((destination) => destination.kind === 'lark_chat')
  const baseDraft: WorkflowDraft = {
    id: `published-${workflow.id}`,
    name: workflow.name,
    userIntent: workflow.userIntent,
    ...scheduleFields,
    desktopInbox: workflow.outputConfig.destinations.some((destination) => destination.kind === 'desktop_inbox'),
    desktopThread: Boolean(desktopThreadDestination),
    desktopThreadLabel: desktopThreadDestination?.label || workflow.name,
    larkChat: Boolean(larkDestination),
    larkChatLabel: larkDestination?.label || '',
    compiledPrompt: workflow.compiledPrompt,
    compilerNotes: '',
    compiledWorkflowSpec: workflow.workflowSpec,
    compiledCapabilitySummary: workflow.capabilitySummary,
    compiledModelId: null,
    lastCompiledAt: workflow.updatedAt,
    lastCompiledSourceFingerprint: null,
    publishedWorkflowId: workflow.id,
    publishedThreadId: desktopThreadDestination?.threadId ?? null,
    publishedThreadTitle: desktopThreadDestination?.label ?? workflow.name,
    lastPublishedAt: workflow.publishedAt,
    nextRunAt: workflow.nextRunAt,
    lastPublishedSourceFingerprint: null,
    status: workflow.status === 'active' ? 'published' : 'draft',
    updatedAt: workflow.updatedAt,
  }

  const fingerprint = createDraftSourceFingerprint(baseDraft)
  return {
    ...baseDraft,
    lastCompiledSourceFingerprint: fingerprint,
    lastPublishedSourceFingerprint: fingerprint,
  }
}

function reconcileDraftsWithPublished(
  currentDrafts: WorkflowDraft[],
  publishedWorkflows: PublishedWorkflowSummary[],
): WorkflowDraft[] {
  const draftByWorkflowId = new Map(
    currentDrafts
      .filter((draft) => draft.publishedWorkflowId)
      .map((draft) => [draft.publishedWorkflowId as string, draft]),
  )

  const syncedPublishedDrafts = publishedWorkflows.map((workflow) => {
    const localDraft = draftByWorkflowId.get(workflow.id)
    const remoteDraft = buildDraftFromPublishedWorkflow(workflow)
    if (!localDraft) {
      return remoteDraft
    }

    const hasLocalEdits = Boolean(
      localDraft.lastPublishedSourceFingerprint
      && localDraft.lastPublishedSourceFingerprint !== createDraftSourceFingerprint(localDraft),
    )

    return hasLocalEdits
      ? {
        ...remoteDraft,
        ...localDraft,
        publishedWorkflowId: workflow.id,
        lastPublishedAt: workflow.publishedAt,
        nextRunAt: workflow.nextRunAt,
        publishedThreadId: remoteDraft.publishedThreadId,
        publishedThreadTitle: remoteDraft.publishedThreadTitle,
        lastPublishedSourceFingerprint: remoteDraft.lastPublishedSourceFingerprint,
      }
      : remoteDraft
  })

  const unpublishedDrafts = currentDrafts.filter((draft) => !draft.publishedWorkflowId)
  const nextDrafts = [...syncedPublishedDrafts, ...unpublishedDrafts]
  return nextDrafts.length > 0 ? nextDrafts : [createBlankDraft()]
}

export function ScheduleWorkView({ onExit }: { onExit?: () => void }): JSX.Element {
  const { token, selectedDepartmentId } = useAuth()
  const { loadThreads, selectThread } = useChat()
  const { bindThreadToCurrentWorkspace } = useWorkspace()
  const [drafts, setDrafts] = useState<WorkflowDraft[]>(() => readDraftsFromStorage())
  const [selectedDraftId, setSelectedDraftId] = useState<string>(() => readDraftsFromStorage()[0]?.id ?? '')
  const [activePanel, setActivePanel] = useState<'graph' | 'prompt'>('graph')
  const [draftRailOpen, setDraftRailOpen] = useState(true)
  const [isCompiling, setIsCompiling] = useState(false)
  const [compileError, setCompileError] = useState<string | null>(null)
  const [isPublishing, setIsPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [isRunningNow, setIsRunningNow] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  }, [drafts])

  useEffect(() => {
    if (!drafts.find((draft) => draft.id === selectedDraftId) && drafts[0]) {
      setSelectedDraftId(drafts[0].id)
    }
  }, [drafts, selectedDraftId])

  useEffect(() => {
    if (!token) return

    let cancelled = false
    const loadPublishedWorkflows = async (): Promise<void> => {
      try {
        const response = await window.desktopAPI.fetch('/api/desktop/workflows', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        if (response.status < 200 || response.status >= 300) {
          return
        }
        const parsed = JSON.parse(response.body) as { data: PublishedWorkflowSummary[] }
        if (cancelled) return
        setDrafts((current) => reconcileDraftsWithPublished(current, parsed.data ?? []))
      } catch {
        // Keep local drafts if the backend list call fails.
      }
    }

    void loadPublishedWorkflows()
    return () => {
      cancelled = true
    }
  }, [token])

  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? drafts[0]
  const sourceFingerprint = selectedDraft ? createDraftSourceFingerprint(selectedDraft) : ''
  const compiledNodes = selectedDraft?.compiledWorkflowSpec?.nodes ?? []
  const capabilitySummary = selectedDraft?.compiledCapabilitySummary ?? null
  const destinationLabels = selectedDraft ? formatDestinationLabels(selectedDraft) : []
  const hasCompiledPrompt = Boolean(selectedDraft?.compiledPrompt?.trim())
  const hasCompiledWorkflow = compiledNodes.length > 0
  const hasPublishedWorkflow = Boolean(selectedDraft?.publishedWorkflowId)
  const hasUnpublishedChanges = Boolean(
    selectedDraft?.publishedWorkflowId
    && selectedDraft.lastPublishedSourceFingerprint
    && selectedDraft.lastPublishedSourceFingerprint !== sourceFingerprint,
  )
  const compileIsStale = Boolean(
    selectedDraft?.lastCompiledSourceFingerprint
    && selectedDraft.lastCompiledSourceFingerprint !== sourceFingerprint,
  )

  const updateSelectedDraft = (updates: Partial<WorkflowDraft>): void => {
    if (!selectedDraft) return

    setDrafts((current) =>
      current.map((draft) =>
        draft.id === selectedDraft.id
          ? {
            ...draft,
            ...updates,
            status: updates.status ?? draft.status,
            updatedAt: new Date().toISOString(),
          }
          : draft,
      ),
    )
  }

  const updateCompiledPrompt = (compiledPrompt: string): void => {
    if (!selectedDraft) return
    setDrafts((current) =>
      current.map((draft) =>
        draft.id === selectedDraft.id
          ? {
            ...draft,
            compiledPrompt,
          }
          : draft,
      ),
    )
  }

  const createDraft = (): void => {
    const draft = createBlankDraft()
    setDrafts((current) => [draft, ...current])
    setSelectedDraftId(draft.id)
  }

  const duplicateDraft = (): void => {
    if (!selectedDraft) return
    const copy = {
      ...selectedDraft,
      id: `workflow-${Math.random().toString(36).slice(2, 10)}`,
      name: `${selectedDraft.name} copy`,
      publishedWorkflowId: null,
      publishedThreadId: null,
      publishedThreadTitle: null,
      lastPublishedAt: null,
      nextRunAt: null,
      lastPublishedSourceFingerprint: null,
      status: 'draft' as const,
      updatedAt: new Date().toISOString(),
    }
    setDrafts((current) => [copy, ...current])
    setSelectedDraftId(copy.id)
  }

  const deleteDraft = async (): Promise<void> => {
    if (!selectedDraft) return
    if (!window.confirm(`${selectedDraft.publishedWorkflowId ? 'Archive' : 'Delete'} workflow "${selectedDraft.name}"?`)) return

    if (selectedDraft.publishedWorkflowId && token) {
      try {
        const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedDraft.publishedWorkflowId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        if (response.status !== 204) {
          const parsed = response.body ? JSON.parse(response.body) as { message?: string } : {}
          throw new Error(parsed.message || 'Failed to archive deployed workflow')
        }
      } catch (error) {
        setPublishError(error instanceof Error ? error.message : 'Failed to archive deployed workflow')
        return
      }
    }

    setDrafts((current) => {
      const remaining = current.filter((draft) => draft.id !== selectedDraft.id)
      return remaining.length > 0 ? remaining : [createBlankDraft()]
    })
  }

  const reviewDraft = (): void => {
    updateSelectedDraft({ status: 'reviewed' })
  }

  const openWorkflowThread = async (threadId: string): Promise<void> => {
    bindThreadToCurrentWorkspace(threadId)
    await loadThreads()
    await selectThread(threadId)
    onExit?.()
  }

  const publishDraft = async (): Promise<void> => {
    if (!selectedDraft || !token) {
      setPublishError('Sign in again before publishing this workflow.')
      return
    }
    if (!selectedDraft.compiledWorkflowSpec || !selectedDraft.compiledPrompt?.trim()) {
      setPublishError('Compile the workflow before publishing it.')
      return
    }

    setIsPublishing(true)
    setPublishError(null)
    setRunError(null)
    try {
      const response = await window.desktopAPI.fetch('/api/desktop/workflows/publish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: selectedDraft.name,
          userIntent: selectedDraft.userIntent,
          workflowId: selectedDraft.publishedWorkflowId ?? undefined,
          schedule: {
            frequency: selectedDraft.frequency,
            timezone: selectedDraft.timezone,
            time: selectedDraft.time,
            ...(selectedDraft.frequency === 'weekly' ? { dayOfWeek: selectedDraft.dayOfWeek } : {}),
            ...(selectedDraft.frequency === 'monthly' ? { dayOfMonth: selectedDraft.dayOfMonth } : {}),
            ...(selectedDraft.frequency === 'one_time' ? { runDate: selectedDraft.runDate } : {}),
          },
          destinations: buildCompileDestinations(selectedDraft),
          compiledPrompt: selectedDraft.compiledPrompt,
          workflowSpec: selectedDraft.compiledWorkflowSpec,
          capabilitySummary: selectedDraft.compiledCapabilitySummary ?? undefined,
          departmentId: selectedDepartmentId,
        }),
      })

      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Workflow publish failed')
      }

      const parsed = JSON.parse(response.body) as { data: PublishWorkflowResponse }
      const published = parsed.data
      updateSelectedDraft({
        status: 'published',
        publishedWorkflowId: published.workflowId,
        publishedThreadId: published.primaryThreadId,
        publishedThreadTitle: published.primaryThreadTitle,
        lastPublishedAt: published.publishedAt,
        nextRunAt: published.nextRunAt,
        lastPublishedSourceFingerprint: sourceFingerprint,
      })
      bindThreadToCurrentWorkspace(published.primaryThreadId)
      await loadThreads()
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : 'Workflow publish failed')
    } finally {
      setIsPublishing(false)
    }
  }

  const runWorkflowNow = async (): Promise<void> => {
    if (!selectedDraft?.publishedWorkflowId || !token) {
      setRunError('Publish the workflow before running it.')
      return
    }

    setIsRunningNow(true)
    setRunError(null)
    setPublishError(null)
    try {
      const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedDraft.publishedWorkflowId}/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Workflow run failed')
      }

      const parsed = JSON.parse(response.body) as { data: RunWorkflowResponse }
      const run = parsed.data
      updateSelectedDraft({
        publishedThreadId: run.threadId,
        publishedThreadTitle: run.threadTitle,
      })
      bindThreadToCurrentWorkspace(run.threadId)
      await openWorkflowThread(run.threadId)
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Workflow run failed')
    } finally {
      setIsRunningNow(false)
    }
  }

  const compileWorkflow = async (): Promise<void> => {
    if (!selectedDraft || !token) {
      setCompileError('Sign in again before compiling this workflow.')
      return
    }

    setIsCompiling(true)
    setCompileError(null)
    try {
      const response = await window.desktopAPI.fetch('/api/desktop/workflows/compile', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: selectedDraft.name,
          userIntent: selectedDraft.userIntent,
          schedule: {
            frequency: selectedDraft.frequency,
            timezone: selectedDraft.timezone,
            time: selectedDraft.time,
            ...(selectedDraft.frequency === 'weekly' ? { dayOfWeek: selectedDraft.dayOfWeek } : {}),
            ...(selectedDraft.frequency === 'monthly' ? { dayOfMonth: selectedDraft.dayOfMonth } : {}),
            ...(selectedDraft.frequency === 'one_time' ? { runDate: selectedDraft.runDate } : {}),
          },
          destinations: buildCompileDestinations(selectedDraft),
        }),
      })

      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Workflow compilation failed')
      }

      const parsed = JSON.parse(response.body) as { data: CompileWorkflowResponse }
      const compiled = parsed.data
      updateSelectedDraft({
        compiledPrompt: compiled.compiledPrompt,
        compilerNotes: compiled.compilerNotes,
        compiledWorkflowSpec: compiled.workflowSpec,
        compiledCapabilitySummary: compiled.capabilitySummary,
        compiledModelId: compiled.model.modelId,
        lastCompiledAt: new Date().toISOString(),
        lastCompiledSourceFingerprint: sourceFingerprint,
        status: 'reviewed',
      })
      setActivePanel('prompt')
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : 'Workflow compilation failed')
    } finally {
      setIsCompiling(false)
    }
  }

  if (!selectedDraft) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No workflow draft available.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_top_right,_rgba(41,121,255,0.12),_transparent_28%),linear-gradient(180deg,_rgba(12,14,17,1)_0%,_rgba(10,10,12,1)_100%)]">
      {draftRailOpen ? (
      <div className="min-h-0 w-[290px] shrink-0 border-r border-white/5 bg-[rgba(8,10,14,0.86)] px-3 py-4">
        <div className="mb-4 flex items-center justify-between px-2">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-cyan-200/55">Schedule Work</div>
            <div className="mt-1 text-sm font-semibold text-white/92">Schedules</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={createDraft}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15"
            >
              <Plus size={14} />
              New
            </button>
            <button
              onClick={() => setDraftRailOpen(false)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
              title="Hide workflow drafts"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
        </div>

        <div className="space-y-2 overflow-y-auto pr-1">
          {drafts.map((draft) => (
            <button
              key={draft.id}
              onClick={() => setSelectedDraftId(draft.id)}
              className={cn(
                'w-full rounded-2xl border px-3 py-3 text-left transition-all',
                selectedDraft.id === draft.id
                  ? 'border-cyan-300/30 bg-cyan-400/10 shadow-[0_10px_30px_rgba(0,0,0,0.25)]'
                  : 'border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.05]',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-white/90">{draft.name || 'Untitled workflow'}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-white/45">{draft.userIntent || 'Describe the recurring work.'}</div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/55">
                    {statusLabel(draft.status)}
                  </span>
                  {draft.publishedWorkflowId && draft.lastPublishedSourceFingerprint && draft.lastPublishedSourceFingerprint !== createDraftSourceFingerprint(draft) ? (
                    <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-amber-100">
                      Unpublished
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-white/45">
                <span>{formatScheduleLabel(draft)}</span>
                <span>{new Date(draft.updatedAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      ) : (
        <div className="shrink-0 px-3 py-5">
          <button
            onClick={() => setDraftRailOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white"
            title="Show workflow drafts"
          >
            <PanelLeftOpen size={17} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-5xl">
            <div className="mb-6 flex items-start justify-between gap-6">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100/80">
                  <Workflow size={12} />
                  Workflow Authoring
                </div>
                <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">Build recurring work in the desktop app</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">
                  Describe the job once, set its cadence, preview the execution graph, and review the tools and approvals it will need before publish.
                </p>
              </div>

              <div className="flex items-center gap-2">
                {onExit ? (
                  <button
                    onClick={onExit}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/75 transition-colors hover:bg-white/[0.08] hover:text-white"
                  >
                    <ArrowLeft size={15} />
                    Chat
                  </button>
                ) : null}
                {!draftRailOpen ? (
                  <button
                    onClick={() => setDraftRailOpen(true)}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/75 transition-colors hover:bg-white/[0.08] hover:text-white"
                  >
                    <PanelLeftOpen size={15} />
                    Drafts
                  </button>
                ) : null}
                <button
                  onClick={duplicateDraft}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                >
                  <CopyPlus size={15} />
                  Duplicate
                </button>
                <button
                  onClick={() => void deleteDraft()}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:border-red-400/25 hover:bg-red-500/10 hover:text-red-100"
                >
                  <Trash2 size={15} />
                  {selectedDraft.publishedWorkflowId ? 'Archive' : 'Delete'}
                </button>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.9fr)]">
              <div className="space-y-6">
                <section className="rounded-[28px] border border-white/6 bg-white/[0.03] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.28)]">
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-white/[0.06] p-3 text-cyan-100">
                      <PencilLine size={18} />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-white">Workflow brief</h2>
                      <p className="text-sm text-white/45">Natural-language intent becomes the source brief for the generated flow.</p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4">
                    <label className="block">
                      <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Workflow name</span>
                      <input
                        value={selectedDraft.name}
                        onChange={(event) => updateSelectedDraft({ name: event.target.value })}
                        placeholder="Quarterly finance summary"
                        className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-cyan-300/40"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">What should this workflow do?</span>
                      <textarea
                        value={selectedDraft.userIntent}
                        onChange={(event) => updateSelectedDraft({ userIntent: event.target.value })}
                        rows={5}
                        placeholder="Every weekday at 8 AM, inspect open incidents, draft the status update, and send it to the ops room."
                        className="w-full rounded-3xl border border-white/10 bg-black/25 px-4 py-4 text-sm leading-6 text-white outline-none transition-colors placeholder:text-white/25 focus:border-cyan-300/40"
                      />
                    </label>

                    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                      <button
                        onClick={() => void compileWorkflow()}
                        disabled={isCompiling}
                        className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400/12 px-4 py-2.5 text-sm font-medium text-cyan-50 transition-colors hover:bg-cyan-400/20"
                      >
                        <Sparkles size={15} />
                        {isCompiling ? 'Compiling…' : hasCompiledWorkflow ? 'Re-compile with AI' : 'Compile with AI'}
                      </button>
                      <div className="text-sm text-white/45">
                        {hasCompiledPrompt
                          ? compileIsStale
                            ? 'Brief changed after the last AI compile. Re-run compile to refresh the graph and prompt.'
                            : `Compiled ${selectedDraft.lastCompiledAt ? new Date(selectedDraft.lastCompiledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'just now'} with ${selectedDraft.compiledModelId ?? 'the backend model'}.`
                          : 'Compile the brief to lock a graph and create an editable structured prompt.'}
                      </div>
                      {compileError ? (
                        <div className="w-full text-sm text-red-300/90">{compileError}</div>
                      ) : null}
                      {hasPublishedWorkflow && hasUnpublishedChanges ? (
                        <div className="w-full text-sm text-amber-100/85">
                          You are editing a deployed workflow. Publish again to update the live schedule. `Run now` still uses the currently deployed version until you update it.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>

                <section className="rounded-[28px] border border-white/6 bg-white/[0.03] p-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-white/[0.06] p-3 text-sky-100">
                      <CalendarClock size={18} />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-white">Schedule</h2>
                      <p className="text-sm text-white/45">Set the exact run pattern inside the desktop app.</p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Frequency</span>
                      <select
                        value={selectedDraft.frequency}
                        onChange={(event) => updateSelectedDraft({ frequency: event.target.value as ScheduleFrequency })}
                        className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/40"
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="one_time">One time</option>
                      </select>
                    </label>

                    <label className="block">
                      <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Timezone</span>
                      <input
                        value={selectedDraft.timezone}
                        onChange={(event) => updateSelectedDraft({ timezone: event.target.value })}
                        className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-300/40"
                      />
                    </label>

                    {selectedDraft.frequency === 'weekly' && (
                      <label className="block">
                        <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Day of week</span>
                        <select
                          value={selectedDraft.dayOfWeek}
                          onChange={(event) => updateSelectedDraft({ dayOfWeek: event.target.value })}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/40"
                        >
                          {WEEKDAY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {selectedDraft.frequency === 'monthly' && (
                      <label className="block">
                        <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Day of month</span>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={selectedDraft.dayOfMonth}
                          onChange={(event) => updateSelectedDraft({ dayOfMonth: Number(event.target.value) || 1 })}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/40"
                        />
                      </label>
                    )}

                    {selectedDraft.frequency === 'one_time' ? (
                      <label className="block">
                        <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Run date</span>
                        <input
                          type="date"
                          value={selectedDraft.runDate}
                          onChange={(event) => updateSelectedDraft({ runDate: event.target.value })}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/40"
                        />
                      </label>
                    ) : null}

                    <label className="block">
                      <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Run time</span>
                      <input
                        type="time"
                        value={selectedDraft.time}
                        onChange={(event) => updateSelectedDraft({ time: event.target.value })}
                        className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/40"
                      />
                    </label>
                  </div>

                  <div className="mt-4 rounded-2xl border border-sky-300/10 bg-sky-400/5 px-4 py-3 text-sm text-sky-100/75">
                    Next schedule summary: <span className="font-medium text-white">{formatScheduleLabel(selectedDraft)}</span>
                  </div>
                </section>

                <section className="rounded-[28px] border border-white/6 bg-white/[0.03] p-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-white/[0.06] p-3 text-emerald-100">
                      <PanelTop size={18} />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-white">Delivery destinations</h2>
                      <p className="text-sm text-white/45">Choose where runs should land after execution.</p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-3">
                    <DestinationToggle
                      title="Desktop inbox"
                      subtitle="Write results to the desktop activity inbox."
                      checked={selectedDraft.desktopInbox}
                      onChange={(checked) => updateSelectedDraft({ desktopInbox: checked })}
                      icon={<FolderClock size={18} />}
                    />
                    <DestinationToggle
                      title="Desktop thread"
                      subtitle="Deliver the output into a named desktop conversation."
                      checked={selectedDraft.desktopThread}
                      onChange={(checked) => updateSelectedDraft({ desktopThread: checked })}
                      icon={<MessageSquareShare size={18} />}
                    />
                    <DestinationToggle
                      title="Lark chat"
                      subtitle="Post the final message into a configured Lark chat."
                      checked={selectedDraft.larkChat}
                      onChange={(checked) => updateSelectedDraft({ larkChat: checked })}
                      icon={<Mail size={18} />}
                    />
                  </div>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    {selectedDraft.desktopThread && (
                      <label className="block">
                        <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Desktop thread label</span>
                        <input
                          value={selectedDraft.desktopThreadLabel}
                          onChange={(event) => updateSelectedDraft({ desktopThreadLabel: event.target.value })}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-300/40"
                        />
                      </label>
                    )}

                    {selectedDraft.larkChat && (
                      <label className="block">
                        <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">Lark chat</span>
                        <input
                          value={selectedDraft.larkChatLabel}
                          onChange={(event) => updateSelectedDraft({ larkChatLabel: event.target.value })}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-300/40"
                        />
                      </label>
                    )}
                  </div>
                </section>
              </div>

              <div className="space-y-6">
                <section className="rounded-[28px] border border-white/6 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-white/50">
                        <Sparkles size={12} />
                        Visual workflow
                      </div>
                      <h2 className="mt-3 text-lg font-semibold text-white">Generated execution map</h2>
                      <p className="mt-1 text-sm text-white/45">Compile the workflow brief into an execution map, then edit the prompt if needed.</p>
                    </div>

                    <div className="inline-flex rounded-full border border-white/10 bg-black/20 p-1 text-xs">
                      <button
                        onClick={() => setActivePanel('graph')}
                        className={cn(
                          'rounded-full px-3 py-1.5 transition-colors',
                          activePanel === 'graph' ? 'bg-white/10 text-white' : 'text-white/45',
                        )}
                      >
                        Graph
                      </button>
                      <button
                        onClick={() => setActivePanel('prompt')}
                        className={cn(
                          'rounded-full px-3 py-1.5 transition-colors',
                          activePanel === 'prompt' ? 'bg-white/10 text-white' : 'text-white/45',
                        )}
                      >
                        Prompt
                      </button>
                    </div>
                  </div>

                  {activePanel === 'graph' ? (
                    hasCompiledWorkflow ? (
                    <div className="mt-6 space-y-3">
                      {compiledNodes.map((node, index) => (
                        <div key={node.id}>
                          <div className="rounded-3xl border border-white/8 bg-black/20 p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-100/55">{node.kind}</div>
                                <div className="mt-1 text-sm font-semibold text-white">{node.title}</div>
                                <p className="mt-2 text-sm leading-6 text-white/50">{describeCompiledNode(node)}</p>
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                {node.capability ? (
                                  <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-white/60">
                                    {node.capability.toolId}.{node.capability.actionGroup}
                                  </span>
                                ) : null}
                                <span
                                  className={cn(
                                    'rounded-full px-3 py-1 text-[11px] font-medium',
                                    isWriteActionGroup(node.capability?.actionGroup)
                                      ? 'border border-amber-300/20 bg-amber-400/10 text-amber-100'
                                      : 'border border-emerald-300/20 bg-emerald-400/10 text-emerald-100',
                                  )}
                                >
                                  {isWriteActionGroup(node.capability?.actionGroup) ? 'Needs publish approval' : 'Read-only'}
                                </span>
                              </div>
                            </div>
                          </div>
                          {index < compiledNodes.length - 1 && (
                            <div className="flex justify-center py-2 text-white/20">
                              <ChevronRight className="rotate-90" size={16} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    ) : (
                      <div className="mt-6 rounded-3xl border border-dashed border-white/10 bg-black/20 p-6">
                        <div className="text-base font-medium text-white">No compiled workflow yet</div>
                        <p className="mt-2 max-w-md text-sm leading-6 text-white/45">
                          Send the brief to the AI compiler to transform it into a graph and structured execution prompt.
                        </p>
                        <button
                          onClick={() => void compileWorkflow()}
                          disabled={isCompiling}
                          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400/12 px-4 py-2.5 text-sm font-medium text-cyan-50 transition-colors hover:bg-cyan-400/20"
                        >
                          <Sparkles size={15} />
                          {isCompiling ? 'Compiling…' : 'Compile now'}
                        </button>
                      </div>
                    )
                  ) : (
                    <div className="mt-6">
                      {hasCompiledPrompt ? (
                        <>
                          <textarea
                            value={selectedDraft.compiledPrompt ?? ''}
                            onChange={(event) => updateCompiledPrompt(event.target.value)}
                            rows={16}
                            className="w-full rounded-3xl border border-white/8 bg-black/30 p-4 text-xs leading-6 text-white/75 outline-none transition-colors focus:border-cyan-300/35"
                          />
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                            <div className="text-sm text-white/45">
                              {selectedDraft.compilerNotes || 'You can edit the compiled prompt directly before publishing.'}
                            </div>
                            {selectedDraft.compiledModelId ? (
                              <div className="text-sm text-white/35">{selectedDraft.compiledModelId}</div>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <div className="rounded-3xl border border-dashed border-white/10 bg-black/20 p-6">
                          <div className="text-base font-medium text-white">No structured prompt yet</div>
                          <p className="mt-2 max-w-md text-sm leading-6 text-white/45">
                            Compile the brief first. After that, this prompt becomes editable so you can tune the AI instructions directly.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="rounded-[28px] border border-white/6 bg-white/[0.03] p-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-white/[0.06] p-3 text-amber-100">
                      <ShieldCheck size={18} />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-white">Publish review</h2>
                      <p className="text-sm text-white/45">Review capability scope before this workflow is activated.</p>
                    </div>
                  </div>

                  {capabilitySummary ? (
                    <>
                      <div className="mt-5 grid gap-4">
                        <SummaryStrip icon={<Layers3 size={15} />} label="Likely tools" values={capabilitySummary.requiredTools.length > 0 ? capabilitySummary.requiredTools : ['No tools selected']} />
                        <SummaryStrip
                          icon={<AlarmClock size={15} />}
                          label="Action groups"
                          values={Array.from(new Set(Object.values(capabilitySummary.requiredActionGroupsByTool).flat())).length > 0
                            ? Array.from(new Set(Object.values(capabilitySummary.requiredActionGroupsByTool).flat()))
                            : ['read']}
                        />
                        <SummaryStrip icon={<Clock3 size={15} />} label="Destinations" values={destinationLabels.length > 0 ? destinationLabels : ['No destination selected']} />
                      </div>

                      <div className="mt-5 rounded-3xl border border-white/8 bg-black/20 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-sm font-semibold text-white">
                              {capabilitySummary.requiresPublishApproval ? 'Publish approval required' : 'Ready to publish'}
                            </div>
                            <p className="mt-1 text-sm text-white/45">
                              {capabilitySummary.requiresPublishApproval
                                ? 'This workflow includes send, update, or execute capabilities and should capture approval at publish time.'
                                : 'This workflow is currently read-only and can be activated without extra write approval.'}
                            </p>
                          </div>
                          <div className="rounded-full border border-white/10 px-3 py-2 text-xs uppercase tracking-[0.18em] text-white/55">
                            {statusLabel(selectedDraft.status)}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 text-sm text-white/35">
                        Capability fingerprint: {capabilitySummary.capabilityFingerprint.slice(0, 16)}…
                      </div>

                      {selectedDraft.lastPublishedAt ? (
                        <div className="mt-3 rounded-2xl border border-emerald-300/10 bg-emerald-400/[0.06] px-4 py-3 text-sm text-emerald-50/80">
                          Published {new Date(selectedDraft.lastPublishedAt).toLocaleString()}
                          {selectedDraft.nextRunAt ? ` • Next run ${new Date(selectedDraft.nextRunAt).toLocaleString()}` : ''}
                        </div>
                      ) : null}

                      {hasPublishedWorkflow && hasUnpublishedChanges ? (
                        <div className="mt-3 rounded-2xl border border-amber-300/10 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-50/85">
                          This draft has unpublished changes. Updating it will replace the currently deployed schedule instead of creating a mystery duplicate.
                        </div>
                      ) : null}

                      {selectedDraft.publishedThreadId ? (
                        <div className="mt-3 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-white/65">
                          Result thread: <span className="font-medium text-white">{selectedDraft.publishedThreadTitle || selectedDraft.publishedThreadId}</span>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="mt-5 rounded-3xl border border-dashed border-white/10 bg-black/20 p-6">
                      <div className="text-base font-medium text-white">Compile before publish review</div>
                      <p className="mt-2 max-w-md text-sm leading-6 text-white/45">
                        The approval scope, tool list, and destination review are generated from the compiled workflow, not from the raw brief alone.
                      </p>
                    </div>
                  )}

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <button
                      onClick={reviewDraft}
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                    >
                      <Save size={15} />
                      {hasPublishedWorkflow ? 'Save local edits' : 'Mark ready'}
                    </button>
                    <button
                      onClick={() => void publishDraft()}
                      disabled={isPublishing || !hasCompiledWorkflow || !hasCompiledPrompt}
                      className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/25 bg-cyan-400/12 px-4 py-3 text-sm font-medium text-cyan-50 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <CheckCircle2 size={15} />
                      {isPublishing ? 'Publishing…' : hasPublishedWorkflow ? 'Update deployed workflow' : 'Publish workflow'}
                    </button>
                    {selectedDraft.publishedWorkflowId ? (
                      <button
                        onClick={() => void runWorkflowNow()}
                        disabled={isRunningNow}
                        className="inline-flex items-center gap-2 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 px-4 py-3 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-400/18 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Sparkles size={15} />
                        {isRunningNow ? 'Running…' : 'Run now in thread'}
                      </button>
                    ) : null}
                    {selectedDraft.publishedThreadId ? (
                      <button
                        onClick={() => void openWorkflowThread(selectedDraft.publishedThreadId!)}
                        className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                      >
                        <MessageSquareShare size={15} />
                        Open thread
                      </button>
                    ) : null}
                  </div>

                  {publishError ? (
                    <div className="mt-3 text-sm text-red-300/90">{publishError}</div>
                  ) : null}
                  {runError ? (
                    <div className="mt-3 text-sm text-red-300/90">{runError}</div>
                  ) : null}
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function DestinationToggle({
  title,
  subtitle,
  checked,
  onChange,
  icon,
}: {
  title: string
  subtitle: string
  checked: boolean
  onChange: (value: boolean) => void
  icon: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'rounded-3xl border p-4 text-left transition-all',
        checked
          ? 'border-cyan-300/25 bg-cyan-400/10'
          : 'border-white/8 bg-black/15 hover:border-white/15 hover:bg-black/20',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={cn('rounded-2xl p-3', checked ? 'bg-cyan-300/15 text-cyan-50' : 'bg-white/[0.05] text-white/70')}>
          {icon}
        </div>
        <div
          className={cn(
            'mt-1 h-5 w-10 rounded-full border p-[2px] transition-colors',
            checked ? 'border-cyan-300/30 bg-cyan-400/25' : 'border-white/10 bg-white/[0.05]',
          )}
        >
          <div className={cn('h-full w-4 rounded-full bg-white transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
        </div>
      </div>
      <div className="mt-4 text-sm font-medium text-white">{title}</div>
      <div className="mt-2 text-sm leading-6 text-white/45">{subtitle}</div>
    </button>
  )
}

function SummaryStrip({
  icon,
  label,
  values,
}: {
  icon: JSX.Element
  label: string
  values: string[]
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/15 p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
        {icon}
        {label}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {values.map((value) => (
          <span key={value} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/70">
            {value}
          </span>
        ))}
      </div>
    </div>
  )
}
