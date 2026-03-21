import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import ReactFlow, { Background, Controls, MarkerType, Position, ReactFlowProvider, type Edge, type Node, type NodeProps } from 'reactflow'
import 'reactflow/dist/style.css'
import {
  Archive,
  ArrowRight,
  AtSign,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  CopyPlus,
  FileJson2,
  FileText,
  Image as ImageIcon,
  Loader2,
  PencilLine,
  Paperclip,
  Plus,
  Save,
  Sparkles,
  Workflow,
  X,
  Target,
} from 'lucide-react'

import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'
import { FilesDrawer, type FileAssetRecord } from './FilesDrawer'
import { Logo } from './Logo'
import { MarkdownContent } from './MarkdownContent'

type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'one_time'
type WorkflowStatus = 'draft' | 'published' | 'scheduled_active' | 'paused' | 'archived'
type ToolActionGroup = 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'

type WorkflowAuthorMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  referenceContext?: string | null
  planningState?: WorkflowPlanningState | null
  clarificationQuestions?: WorkflowPlanningQuestion[]
}

type WorkflowPlanningQuestionOption = {
  label: string
  value: string
  description?: string
}

type WorkflowPlanningQuestion = {
  id: string
  field: 'source' | 'schedule' | 'destination' | 'approval' | 'execution_order' | 'delivery' | 'other'
  label: string
  question: string
  options?: WorkflowPlanningQuestionOption[]
}

type WorkflowPlanningState = {
  version: 'v1'
  phase: 'planning' | 'ready' | 'built'
  readyToBuild: boolean
  objective: string
  intentSummary: string
  executionOrder?: 'sequential' | 'parallel'
  unitOfWork?: 'rows' | 'tasks' | 'records' | 'documents' | 'single' | 'general'
  sourceSummary?: string
  outputSummary?: string
  approvalSummary?: string
  planningFindings?: string[]
  suggestedToolFamilies?: string[]
  openQuestions: WorkflowPlanningQuestion[]
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

type WorkflowSchedule =
  | {
      type: 'hourly'
      timezone: string
      intervalHours: number
      minute: number
    }
  | {
      type: 'daily'
      timezone: string
      time: { hour: number; minute: number }
    }
  | {
      type: 'weekly'
      timezone: string
      daysOfWeek: string[]
      time: { hour: number; minute: number }
    }
  | {
      type: 'monthly'
      timezone: string
      dayOfMonth: number
      time: { hour: number; minute: number }
    }
  | {
      type: 'one_time'
      timezone: string
      runAt: string
    }

type WorkflowDestination =
  | { id: string; kind: 'desktop_inbox'; label?: string }
  | { id: string; kind: 'desktop_thread'; label?: string; threadId: string }
  | { id: string; kind: 'lark_chat'; label?: string; chatId: string }

type WorkflowRecord = {
  id: string
  name: string
  status: WorkflowStatus
  userIntent: string
  aiDraft: string | null
  workflowSpec: CompiledWorkflowSpec
  compiledPrompt: string
  capabilitySummary: CompiledWorkflowCapabilitySummary
  schedule: WorkflowSchedule
  scheduleEnabled: boolean
  outputConfig: {
    version: 'v1'
    destinations: WorkflowDestination[]
    defaultDestinationIds: string[]
  }
  publishedAt: string | null
  nextRunAt: string | null
  lastRunAt: string | null
  departmentId: string | null
  ownershipScope: 'personal'
  updatedAt: string
  planningState: WorkflowPlanningState
  messages: WorkflowAuthorMessage[]
}

type WorkflowAuthorResponse = WorkflowRecord & {
  compilerNotes?: string
  model?: { provider: string; modelId: string }
}

type WorkflowAttachedFile = {
  fileAssetId: string
  cloudinaryUrl: string
  mimeType: string
  fileName: string
}

type ThreadSummary = {
  id: string
  title: string | null
  updatedAt?: string
}

type ScheduleModalDraft = {
  frequency: ScheduleFrequency
  timezone: string
  intervalHours: number
  minute: number
  time: string
  dayOfWeek: string
  dayOfMonth: number
  runDate: string
}

type WorkflowBuilderView = 'chat' | 'workflow'

const WEEKDAY_OPTIONS = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
] as const

const WEEKDAY_CODE_BY_VALUE: Record<(typeof WEEKDAY_OPTIONS)[number]['value'], 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'> = {
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
  sunday: 'SU',
}

const WEEKDAY_VALUE_BY_CODE: Record<'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU', (typeof WEEKDAY_OPTIONS)[number]['value']> = {
  MO: 'monday',
  TU: 'tuesday',
  WE: 'wednesday',
  TH: 'thursday',
  FR: 'friday',
  SA: 'saturday',
  SU: 'sunday',
}

const isWorkflowBuilt = (workflow: WorkflowRecord | null): boolean =>
  Boolean(workflow && workflow.planningState?.phase === 'built')

const hasWorkflowMap = (workflow: WorkflowRecord | null): boolean =>
  Boolean(
    workflow
      && (
        workflow.planningState?.phase === 'built'
        || workflow.compiledPrompt.trim().length > 0
        || workflow.status !== 'draft'
      ),
  )

const WORKFLOW_BUILDER_VIEW_STORAGE_KEY = 'workflow_builder_views_v1'

const buildClarificationAnswerText = (question: WorkflowPlanningQuestion, option?: WorkflowPlanningQuestionOption): string => {
  const value = option?.value ?? ''
  switch (question.field) {
    case 'execution_order':
      return `Execution order: ${value || 'sequential'}`
    case 'source':
      return `Source selection: ${value || question.label}`
    case 'destination':
      return `Destination: ${value || question.label}`
    case 'approval':
      return `Approval preference: ${value || question.label}`
    case 'schedule':
      return `Schedule: ${value || question.label}`
    case 'delivery':
      return `Delivery requirement: ${value || question.label}`
    default:
      return value || question.question
  }
}

const formatPlanningPhase = (planningState: WorkflowPlanningState | null | undefined): string => {
  if (!planningState) return 'Planning'
  if (planningState.phase === 'built') return 'Workflow ready'
  if (planningState.readyToBuild) return 'Ready to build'
  return 'Planning'
}

const readWorkflowBuilderViews = (): Record<string, WorkflowBuilderView> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(WORKFLOW_BUILDER_VIEW_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === 'chat' || value === 'workflow'),
    ) as Record<string, WorkflowBuilderView>
  } catch {
    return {}
  }
}

const persistWorkflowBuilderViews = (views: Record<string, WorkflowBuilderView>): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORKFLOW_BUILDER_VIEW_STORAGE_KEY, JSON.stringify(views))
  } catch {
    // Ignore storage failures in renderer.
  }
}

const WorkflowNodeCard = ({ data }: NodeProps<{ node: CompiledWorkflowNode }>): JSX.Element => {
  const node = data.node
  const actionLabel = node.capability ? `${node.capability.toolId}.${node.capability.actionGroup}` : 'logic'

  return (
    <div className="w-[280px] rounded-2xl border border-border bg-background/95 p-5 shadow-sm text-foreground/90">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">{node.kind}</div>
          <div className="mt-1 text-[15px] font-semibold text-foreground/90">{node.title}</div>
        </div>
        <span
          className={cn(
            'rounded-lg border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
            node.capability?.actionGroup && ['create', 'update', 'delete', 'send', 'execute'].includes(node.capability.actionGroup)
              ? 'border-amber-500/20 bg-amber-500/10 text-amber-500/80'
              : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500/80',
          )}
        >
          {actionLabel}
        </span>
      </div>
      {node.instructions ? (
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground/80">{node.instructions}</p>
      ) : null}
      {node.expectedOutput ? (
        <div className="mt-4 rounded-xl border border-border bg-secondary/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground/60 font-medium">
          {node.expectedOutput}
        </div>
      ) : null}
    </div>
  )
}

const nodeTypes = {
  workflowNode: WorkflowNodeCard,
}

function buildGraph(spec: CompiledWorkflowSpec | null): { nodes: Node[]; edges: Edge[] } {
  if (!spec || spec.nodes.length === 0) {
    return { nodes: [], edges: [] }
  }

  const effectiveEdges = spec.edges.length > 0
    ? spec.edges
    : spec.nodes.slice(1).map((node, index) => ({
        sourceId: spec.nodes[index]!.id,
        targetId: node.id,
        condition: 'always',
      }))

  const incoming = new Map<string, number>(spec.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>(spec.nodes.map((node) => [node.id, []]))
  for (const edge of effectiveEdges) {
    incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1)
    outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge.targetId])
  }

  const queue = spec.nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id)

  const levelById = new Map<string, number>()
  while (queue.length > 0) {
    const currentId = queue.shift()!
    const currentLevel = levelById.get(currentId) ?? 0
    for (const nextId of outgoing.get(currentId) ?? []) {
      const nextLevel = currentLevel + 1
      levelById.set(nextId, Math.max(levelById.get(nextId) ?? 0, nextLevel))
      incoming.set(nextId, (incoming.get(nextId) ?? 0) - 1)
      if ((incoming.get(nextId) ?? 0) === 0) {
        queue.push(nextId)
      }
    }
  }

  const nodesByLevel = new Map<number, CompiledWorkflowNode[]>()
  for (const node of spec.nodes) {
    const level = levelById.get(node.id) ?? 0
    const existing = nodesByLevel.get(level) ?? []
    existing.push(node)
    nodesByLevel.set(level, existing)
  }

  const nodes: Node[] = spec.nodes.map((node) => {
    const level = levelById.get(node.id) ?? 0
    const siblings = nodesByLevel.get(level) ?? [node]
    const rowIndex = siblings.findIndex((entry) => entry.id === node.id)
    return {
      id: node.id,
      type: 'workflowNode',
      data: { node },
      position: { x: level * 380 + 60, y: rowIndex * 280 + 60 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      selectable: false,
    }
  })

  const edges: Edge[] = effectiveEdges.map((edge, index) => ({
    id: `${edge.sourceId}-${edge.targetId}-${index}`,
    source: edge.sourceId,
    target: edge.targetId,
    label: edge.label ?? (edge.condition !== 'always' ? edge.condition : undefined),
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20 },
    animated: edge.condition !== 'always',
    style: { stroke: 'hsl(var(--primary) / 0.3)', strokeWidth: 2 },
    labelStyle: { fill: 'hsl(var(--muted-foreground))', fontSize: 10, fontWeight: 500 },
    pathOptions: { offset: 20, borderRadius: 16 },
  }))

  return { nodes, edges }
}

function fromScheduleModalDraft(draft: ScheduleModalDraft): Record<string, unknown> {
  if (draft.frequency === 'hourly') {
    return {
      frequency: 'hourly',
      timezone: draft.timezone,
      intervalHours: draft.intervalHours,
      minute: draft.minute,
    }
  }
  if (draft.frequency === 'daily') {
    return { frequency: 'daily', timezone: draft.timezone, time: draft.time }
  }
  if (draft.frequency === 'weekly') {
    return {
      frequency: 'weekly',
      timezone: draft.timezone,
      time: draft.time,
      dayOfWeek: draft.dayOfWeek,
    }
  }
  if (draft.frequency === 'monthly') {
    return { frequency: 'monthly', timezone: draft.timezone, time: draft.time, dayOfMonth: draft.dayOfMonth }
  }
  return { frequency: 'one_time', timezone: draft.timezone, time: draft.time, runAt: draft.runAt }
}

function toScheduleModalDraft(schedule: WorkflowSchedule): ScheduleModalDraft {
  if (schedule.type === 'hourly') {
    return {
      frequency: 'hourly',
      timezone: schedule.timezone,
      intervalHours: schedule.intervalHours,
      minute: schedule.minute,
      time: '09:00',
      dayOfWeek: 'monday',
      dayOfMonth: 1,
      runDate: new Date().toISOString().slice(0, 10),
    }
  }
  if (schedule.type === 'daily') {
    return {
      frequency: 'daily',
      timezone: schedule.timezone,
      intervalHours: 1,
      minute: 0,
      time: `${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')}`,
      dayOfWeek: 'monday',
      dayOfMonth: 1,
      runDate: new Date().toISOString().slice(0, 10),
    }
  }
  if (schedule.type === 'weekly') {
    return {
      frequency: 'weekly',
      timezone: schedule.timezone,
      intervalHours: 1,
      minute: 0,
      time: `${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')}`,
      dayOfWeek: WEEKDAY_VALUE_BY_CODE[schedule.daysOfWeek[0] ?? 'MO'],
      dayOfMonth: 1,
      runDate: new Date().toISOString().slice(0, 10),
    }
  }
  if (schedule.type === 'monthly') {
    return {
      frequency: 'monthly',
      timezone: schedule.timezone,
      intervalHours: 1,
      minute: 0,
      time: `${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')}`,
      dayOfWeek: 'monday',
      dayOfMonth: schedule.dayOfMonth,
      runDate: new Date().toISOString().slice(0, 10),
    }
  }

  const date = new Date(schedule.runAt)
  return {
    frequency: 'one_time',
    timezone: schedule.timezone,
    intervalHours: 1,
    minute: 0,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    dayOfWeek: 'monday',
    dayOfMonth: 1,
    runDate: date.toISOString().slice(0, 10),
  }
}

function createSkeletonBlocks(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex w-full max-w-lg flex-col items-center gap-6 px-8">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex w-full flex-col items-center gap-4">
            <div className="h-20 w-full max-w-[280px] animate-pulse rounded-2xl border border-border bg-white/[0.03]" />
            {index < 2 ? <ArrowRight className="text-muted-foreground/10" size={18} /> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ScheduleWorkView({ onExit }: { onExit?: () => void }): JSX.Element {
  const { token } = useAuth()
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingPromptDraft, setIsSavingPromptDraft] = useState(false)
  const [isScheduling, setIsScheduling] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [isDuplicating, setIsDuplicating] = useState(false)
  const [composerText, setComposerText] = useState('')
  const [builderViewsByWorkflow, setBuilderViewsByWorkflow] = useState<Record<string, WorkflowBuilderView>>(() => readWorkflowBuilderViews())
  const [error, setError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [planningSummaryOpen, setPlanningSummaryOpen] = useState(false)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [jsonDraft, setJsonDraft] = useState('')
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleModalDraft | null>(null)
  const [availableThreads, setAvailableThreads] = useState<ThreadSummary[]>([])
  const [outputMode, setOutputMode] = useState<'new_thread' | 'existing_thread'>('new_thread')
  const [threadSearch, setThreadSearch] = useState('')
  const [selectedExistingThreadId, setSelectedExistingThreadId] = useState<string | null>(null)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const [isFilesDrawerOpen, setIsFilesDrawerOpen] = useState(false)
  const [referencedFiles, setReferencedFiles] = useState<FileAssetRecord[]>([])

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null
  const graph = useMemo(() => buildGraph(selectedWorkflow?.workflowSpec ?? null), [selectedWorkflow?.workflowSpec])
  const hasGeneratedDraft = isWorkflowBuilt(selectedWorkflow)
  const hasVisibleWorkflowMap = hasWorkflowMap(selectedWorkflow)
  const selectedBuilderView: WorkflowBuilderView = selectedWorkflowId
    ? (builderViewsByWorkflow[selectedWorkflowId] ?? 'chat')
    : 'chat'
  const filteredThreads = useMemo(() => {
    const needle = threadSearch.trim().toLowerCase()
    if (!needle) return availableThreads
    return availableThreads.filter((thread) => (thread.title ?? 'Untitled thread').toLowerCase().includes(needle))
  }, [availableThreads, threadSearch])
  const selectedExistingThread = useMemo(
    () => availableThreads.find((thread) => thread.id === selectedExistingThreadId) ?? null,
    [availableThreads, selectedExistingThreadId],
  )
  const referencedFileIds = useMemo(() => new Set(referencedFiles.map((file) => file.id)), [referencedFiles])
  const referencedFilePayload = useMemo<WorkflowAttachedFile[]>(
    () => referencedFiles.map((file) => ({
      fileAssetId: file.id,
      cloudinaryUrl: file.cloudinaryUrl,
      mimeType: file.mimeType,
      fileName: file.fileName,
    })),
    [referencedFiles],
  )

  const upsertWorkflow = (workflow: WorkflowRecord) => {
    setWorkflows((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === workflow.id)
      if (existingIndex === -1) return [workflow, ...prev]
      const next = [...prev]
      next[existingIndex] = workflow
      return next.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    })
    setSelectedWorkflowId(workflow.id)
  }

  const setBuilderView = (view: WorkflowBuilderView): void => {
    if (!selectedWorkflowId) return
    setBuilderViewsByWorkflow((current) => {
      const next = { ...current, [selectedWorkflowId]: view }
      persistWorkflowBuilderViews(next)
      return next
    })
  }

  const loadWorkflows = async (preferredId?: string | null): Promise<void> => {
    if (!token) return
    setIsLoading(true)
    setError(null)
    try {
      const response = await window.desktopAPI.fetch('/api/desktop/workflows', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Failed to load workflows')
      }
      const parsed = JSON.parse(response.body) as { data?: WorkflowRecord[] }
      const nextWorkflows = parsed.data ?? []
      if (nextWorkflows.length === 0) {
        const created = await createDraft()
        setSelectedWorkflowId(created.id)
        return
      }
      setWorkflows(nextWorkflows)
      setSelectedWorkflowId((current) => preferredId ?? current ?? nextWorkflows[0]?.id ?? null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load workflows')
    } finally {
      setIsLoading(false)
    }
  }

  const loadWorkflow = async (workflowId: string): Promise<WorkflowRecord> => {
    if (!token) {
      throw new Error('Sign in again before loading the workflow.')
    }
    const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${workflowId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (response.status < 200 || response.status >= 300) {
      const parsed = JSON.parse(response.body) as { message?: string }
      throw new Error(parsed.message || 'Failed to load workflow')
    }
    const parsed = JSON.parse(response.body) as { data: WorkflowRecord }
    upsertWorkflow(parsed.data)
    return parsed.data
  }

  const loadThreads = async (): Promise<void> => {
    if (!token) return
    try {
      const response = await window.desktopAPI.threads.list(token)
      if (response?.success && Array.isArray(response.data)) {
        setAvailableThreads(response.data as ThreadSummary[])
      }
    } catch {
      // Non-blocking for the workflow UI.
    }
  }

  const createDraft = async (): Promise<WorkflowRecord> => {
    if (!token) {
      throw new Error('Sign in again before creating a workflow.')
    }
    const payload = JSON.stringify({})
    const requestOptions = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: payload,
    }

    let response = await window.desktopAPI.fetch('/api/desktop/workflows/new-draft', requestOptions)
    if (response.status < 200 || response.status >= 300) {
      response = await window.desktopAPI.fetch('/api/desktop/workflows/drafts', requestOptions)
    }
    if (response.status < 200 || response.status >= 300) {
      const parsed = JSON.parse(response.body) as { message?: string }
      throw new Error(parsed.message || 'Failed to create a workflow draft')
    }
    const parsed = JSON.parse(response.body) as { data: WorkflowRecord }
    upsertWorkflow(parsed.data)
    return parsed.data
  }

  useEffect(() => {
    void loadWorkflows()
  }, [token])

  useEffect(() => {
    void loadThreads()
  }, [token])

  useEffect(() => {
    if (!selectedWorkflow) return
    setPromptDraft(selectedWorkflow.aiDraft ?? '')
    setJsonDraft(JSON.stringify(selectedWorkflow.workflowSpec, null, 2))
    setScheduleDraft(toScheduleModalDraft(selectedWorkflow.schedule))
    setComposerText('')
    const explicitThread = selectedWorkflow.outputConfig.destinations.find((destination) => destination.kind === 'desktop_thread')
    if (explicitThread?.kind === 'desktop_thread') {
      setOutputMode('existing_thread')
      setSelectedExistingThreadId(explicitThread.threadId)
    } else {
      setOutputMode('new_thread')
      setSelectedExistingThreadId(null)
    }
    setThreadSearch('')
    setPromptOpen(false)
    setAdvancedOpen(false)
    setPlanningSummaryOpen(false)
    setReferencedFiles([])
  }, [selectedWorkflowId])

  const handleReferenceFile = (file: FileAssetRecord): void => {
    setReferencedFiles((current) => {
      if (current.some((entry) => entry.id === file.id)) {
        return current.filter((entry) => entry.id !== file.id)
      }
      return [...current, file]
    })
  }

  const removeReferencedFile = (fileId: string): void => {
    setReferencedFiles((current) => current.filter((file) => file.id !== fileId))
  }

  const applyClarificationAnswer = (question: WorkflowPlanningQuestion, option?: WorkflowPlanningQuestionOption): void => {
    const nextText = buildClarificationAnswerText(question, option)
    setComposerText(nextText)
  }

  const buildDestinationsPayload = (): Array<{ kind: 'desktop_thread'; label?: string; value?: string }> => {
    if (outputMode === 'existing_thread' && selectedExistingThread) {
      return [{
        kind: 'desktop_thread',
        label: selectedExistingThread.title ?? 'Existing thread',
        value: selectedExistingThread.id,
      }]
    }
    return []
  }

  const authorWorkflow = async (): Promise<void> => {
    if (!selectedWorkflow || !token || !composerText.trim()) return
    setIsGenerating(true)
    setError(null)
    setStatusNotice(null)
    try {
      const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedWorkflow.id}/author`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: composerText.trim(),
          attachedFiles: referencedFilePayload,
        }),
      })
      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Failed to generate workflow')
      }
      const parsed = JSON.parse(response.body) as { data: WorkflowAuthorResponse }
      upsertWorkflow(parsed.data)
      setComposerText('')
      setReferencedFiles([])
      setPromptDraft(parsed.data.aiDraft ?? '')
      setJsonDraft(JSON.stringify(parsed.data.workflowSpec, null, 2))
      setScheduleDraft(toScheduleModalDraft(parsed.data.schedule))
    } catch (authorError) {
      setError(authorError instanceof Error ? authorError.message : 'Failed to generate workflow')
    } finally {
      setIsGenerating(false)
    }
  }

  const buildReadyWorkflow = async (): Promise<void> => {
    if (!selectedWorkflow || !token || !selectedWorkflow.planningState?.readyToBuild) return
    setIsGenerating(true)
    setError(null)
    setStatusNotice(null)
    try {
      const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedWorkflow.id}/author`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Build the workflow now.',
          attachedFiles: [],
        }),
      })
      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Failed to build workflow')
      }
      const parsed = JSON.parse(response.body) as { data: WorkflowAuthorResponse }
      upsertWorkflow(parsed.data)
      setPromptDraft(parsed.data.aiDraft ?? '')
      setJsonDraft(JSON.stringify(parsed.data.workflowSpec, null, 2))
      setScheduleDraft(toScheduleModalDraft(parsed.data.schedule))
      setStatusNotice('Workflow compiled. You can review it in the Workflow tab and save it when ready.')
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : 'Failed to build workflow')
    } finally {
      setIsGenerating(false)
    }
  }

  const publishWorkflow = async (): Promise<void> => {
    if (!selectedWorkflow || !token) return
    setIsSaving(true)
    setError(null)
    setStatusNotice(null)
    try {
      const response = await window.desktopAPI.fetch('/api/desktop/workflows/publish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflowId: selectedWorkflow.id,
          name: selectedWorkflow.name,
          userIntent: selectedWorkflow.userIntent,
          aiDraft: selectedWorkflow.aiDraft ?? undefined,
          scheduleEnabled: false,
          schedule: fromScheduleModalDraft(scheduleDraft ?? toScheduleModalDraft(selectedWorkflow.schedule)),
          destinations: buildDestinationsPayload(),
          compiledPrompt: selectedWorkflow.compiledPrompt,
          workflowSpec: selectedWorkflow.workflowSpec,
          capabilitySummary: selectedWorkflow.capabilitySummary,
          departmentId: selectedWorkflow.departmentId,
        }),
      })
      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Failed to save workflow')
      }
      await loadWorkflow(selectedWorkflow.id)
      setStatusNotice('Workflow saved to your library.')
      setSaveModalOpen(true)
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Failed to save workflow')
    } finally {
      setIsSaving(false)
    }
  }

  const updateWorkflow = async (payload: Record<string, unknown>): Promise<void> => {
    if (!selectedWorkflow || !token) return
    const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedWorkflow.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (response.status < 200 || response.status >= 300) {
      const parsed = JSON.parse(response.body) as { message?: string }
      throw new Error(parsed.message || 'Failed to update workflow')
    }
    const parsed = JSON.parse(response.body) as { data: WorkflowRecord }
    upsertWorkflow(parsed.data)
  }

  const savePromptEdits = async (): Promise<void> => {
    if (!selectedWorkflow) return
    if ((selectedWorkflow.aiDraft ?? '') === promptDraft) return
    setIsSavingPromptDraft(true)
    try {
      await updateWorkflow({ aiDraft: promptDraft, name: selectedWorkflow.name })
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to save prompt edits')
    } finally {
      setIsSavingPromptDraft(false)
    }
  }

  const saveJsonEdits = async (): Promise<void> => {
    if (!selectedWorkflow) return
    try {
      const parsedJson = JSON.parse(jsonDraft) as CompiledWorkflowSpec
      await updateWorkflow({ workflowSpec: parsedJson, name: selectedWorkflow.name })
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to save workflow JSON')
    }
  }

  const duplicateWorkflow = async (): Promise<void> => {
    if (!selectedWorkflow) return
    setIsDuplicating(true)
    setError(null)
    setStatusNotice(null)
    try {
      const created = await createDraft()
      await window.desktopAPI.fetch(`/api/desktop/workflows/${created.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `${selectedWorkflow.name} copy`,
          userIntent: selectedWorkflow.userIntent,
          aiDraft: selectedWorkflow.aiDraft,
          workflowSpec: selectedWorkflow.workflowSpec,
          schedule: fromScheduleModalDraft(toScheduleModalDraft(selectedWorkflow.schedule)),
        }),
      })
      await loadWorkflows(created.id)
    } catch (duplicateError) {
      setError(duplicateError instanceof Error ? duplicateError.message : 'Failed to duplicate workflow')
    } finally {
      setIsDuplicating(false)
    }
  }

  const archiveWorkflow = async (): Promise<void> => {
    if (!selectedWorkflow || !token) return
    setIsArchiving(true)
    setError(null)
    setStatusNotice(null)
    try {
      const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedWorkflow.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      if (response.status !== 204) {
        const parsed = response.body ? (JSON.parse(response.body) as { message?: string }) : {}
        throw new Error(parsed.message || 'Failed to archive workflow')
      }
      await loadWorkflows()
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : 'Failed to archive workflow')
    } finally {
      setIsArchiving(false)
    }
  }

  const activateSchedule = async (enabled: boolean): Promise<void> => {
    if (!selectedWorkflow || !token) return
    setIsScheduling(true)
    setError(null)
    setStatusNotice(null)
    try {
      await updateWorkflow({
        schedule: fromScheduleModalDraft(scheduleDraft ?? toScheduleModalDraft(selectedWorkflow.schedule)),
        destinations: buildDestinationsPayload(),
      })
      const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedWorkflow.id}/schedule`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scheduleEnabled: enabled }),
      })
      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Failed to update schedule')
      }
      await loadWorkflow(selectedWorkflow.id)
      setStatusNotice(enabled ? 'Schedule activated.' : 'Workflow saved without a schedule.')
      setScheduleModalOpen(false)
      setSaveModalOpen(false)
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : 'Failed to update schedule')
    } finally {
      setIsScheduling(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading workflows...
      </div>
    )
  }

  return (
    <ReactFlowProvider>
      <div className="flex h-full min-h-0 bg-background text-foreground relative">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-background/50 backdrop-blur-md px-4 py-5 z-20">
          <div className="mb-6 flex items-center justify-between px-1">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Workflows</div>
              <div className="mt-0.5 text-sm font-bold text-foreground/90">Library</div>
            </div>
            <button
              onClick={() => void createDraft()}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
              title="New workflow"
            >
              <Plus size={16} />
            </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto pr-1">
            {workflows.map((workflow) => (
              <button
                key={workflow.id}
                onClick={() => setSelectedWorkflowId(workflow.id)}
                className={cn(
                  'w-full rounded-xl border px-4 py-3 text-left transition-all',
                  selectedWorkflowId === workflow.id
                    ? 'border-primary/20 bg-primary/5 shadow-sm'
                    : 'border-transparent hover:bg-secondary/30 text-muted-foreground/70 hover:text-muted-foreground',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className={cn('truncate text-[13px] font-semibold', selectedWorkflowId === workflow.id ? 'text-foreground' : '')}>{workflow.name}</div>
                    <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed opacity-60">
                      {workflow.userIntent || workflow.aiDraft || 'Empty workflow draft'}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider opacity-40">
                  <span>{workflow.schedule.type}</span>
                  <span>{workflow.status.replace('_', ' ')}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col relative">
          <div className="border-b border-border/50 px-8 py-6 z-20 bg-background/80 backdrop-blur-md shrink-0">
            <div className="mx-auto flex w-full max-w-[1400px] items-start justify-between gap-8">
              <div className="min-w-0 flex-1">
                <div className="inline-flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary/80">
                  Workflow builder
                </div>
                <h1 className="mt-4 text-[36px] font-bold tracking-tight text-foreground/90 truncate">
                  {selectedWorkflow?.name || 'Workflow builder'}
                </h1>
                <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-muted-foreground/60 font-medium">
                  Define reusable jobs in natural language. Divo will compile them into execution maps that you can trigger manually or on a schedule.
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3 pt-4">
              <div className="inline-flex items-center rounded-xl border border-border bg-background/75 p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => setBuilderView('chat')}
                  className={cn(
                    'inline-flex h-8 items-center justify-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-all',
                    selectedBuilderView === 'chat'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )}
                >
                  <Bot size={14} />
                  Chat
                </button>
                <button
                  type="button"
                  onClick={() => setBuilderView('workflow')}
                  className={cn(
                    'inline-flex h-8 items-center justify-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-all',
                    selectedBuilderView === 'workflow'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )}
                >
                  <Workflow size={14} />
                  Workflow
                </button>
              </div>
              {onExit ? (
                <button
                  onClick={onExit}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-secondary/50 px-3.5 text-[13px] font-semibold text-muted-foreground transition-all hover:bg-secondary hover:text-foreground shadow-sm"
                >
                  Back to chat
                </button>
              ) : null}
              <button
                onClick={() => void duplicateWorkflow()}
                disabled={!selectedWorkflow || isDuplicating}
                className="group relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground transition-all hover:bg-secondary hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
              >
                <CopyPlus size={15} />
                <span className="absolute -bottom-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg group-hover:opacity-100 transition-opacity pointer-events-none border border-border">
                  Duplicate
                </span>
              </button>
              <button
                onClick={() => setScheduleModalOpen(true)}
                disabled={!selectedWorkflow}
                className="group relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground transition-all hover:bg-secondary hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
              >
                <CalendarClock size={15} />
                <span className="absolute -bottom-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg group-hover:opacity-100 transition-opacity pointer-events-none border border-border">
                  Schedule
                </span>
              </button>
              <button
                onClick={() => void archiveWorkflow()}
                disabled={!selectedWorkflow || isArchiving}
                className="group relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground transition-all hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
              >
                <Archive size={15} />
                <span className="absolute -bottom-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg group-hover:opacity-100 transition-opacity pointer-events-none border border-border">
                  Archive
                </span>
              </button>
              </div>
            </div>
          </div>

          <div className="flex-1 relative overflow-hidden bg-black/5">
            {/* --- Background Canvas (Full size) --- */}
            <div className="absolute inset-0 z-0">
              <ReactFlow
                nodes={hasVisibleWorkflowMap && selectedBuilderView === 'workflow' ? graph.nodes : []}
                edges={graph.edges}
                nodeTypes={nodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="hsl(var(--muted-foreground))" opacity={0.05} gap={24} />
                <Controls 
                  showInteractive={false} 
                  className="bg-background border-border fill-muted-foreground"
                />
              </ReactFlow>
            </div>

            {/* --- Overlay Layers --- */}
            <div className="relative h-full w-full z-10 pointer-events-none flex flex-col">
              {error ? (
                <div className="mx-auto mt-6 w-full max-w-[1400px] rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-500 pointer-events-auto shadow-sm">
                  {error}
                </div>
              ) : null}
              {statusNotice ? (
                <div className="mx-auto mt-6 w-full max-w-[1400px] rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-[13px] font-medium text-emerald-500 pointer-events-auto shadow-sm">
                  {statusNotice}
                </div>
              ) : null}

              {/* Main Workspace Stage */}
              <div className="flex-1 relative flex overflow-hidden">
                {hasVisibleWorkflowMap && selectedBuilderView === 'workflow' && !isGenerating && (
                  <div className="absolute top-8 right-8 bottom-[140px] w-[340px] overflow-y-auto pointer-events-auto flex flex-col gap-4">
                    <div className="rounded-2xl border border-border bg-background/80 backdrop-blur-xl p-5 space-y-4 shadow-2xl ring-1 ring-white/5 transition-all duration-500">
                      
                      {/* Section: Prompt (Collapsible) */}
                      <div className="space-y-3">
                        <button 
                          onClick={() => setPromptOpen(!promptOpen)}
                          className="flex w-full items-center justify-between group"
                        >
                          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 group-hover:text-muted-foreground/70 transition-colors">
                            <Bot size={12} />
                            Generated Prompt
                          </div>
                          {promptOpen ? <ChevronDown size={14} className="text-muted-foreground/40" /> : <ChevronRight size={14} className="text-muted-foreground/40" />}
                        </button>
                        
                        {promptOpen && (
                          <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                            <textarea
                              value={promptDraft}
                              onChange={(event) => setPromptDraft(event.target.value)}
                              onBlur={() => void savePromptEdits()}
                              className="min-h-[160px] w-full resize-none rounded-xl border border-border bg-black/40 px-4 py-3 text-[13px] leading-relaxed text-foreground/80 outline-none transition-colors focus:border-primary/30 shadow-inner"
                            />
                            <div className="mt-2 text-[10px] font-medium text-muted-foreground/40 text-center">
                              {isSavingPromptDraft ? 'Saving...' : 'Auto-saves on exit'}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Section: JSON (Collapsible) */}
                      <div className="border-t border-border/50 pt-4">
                        <button
                          onClick={() => setAdvancedOpen((open) => !open)}
                          className="flex w-full items-center justify-between group"
                        >
                          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 group-hover:text-muted-foreground/70 transition-colors">
                            <FileJson2 size={12} />
                            Advanced JSON
                          </div>
                          {advancedOpen ? <ChevronDown size={14} className="text-muted-foreground/40" /> : <ChevronRight size={14} className="text-muted-foreground/40" />}
                        </button>

                        {advancedOpen && (
                          <div className="mt-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                            <textarea
                              value={jsonDraft}
                              onChange={(event) => setJsonDraft(event.target.value)}
                              className="min-h-[200px] w-full resize-y rounded-xl border border-border bg-black/60 px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground/70 outline-none focus:border-primary/30"
                            />
                            <button
                              onClick={() => void saveJsonEdits()}
                              className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
                            >
                              <Save size={13} />
                              Apply Changes
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Section: Destination (Always visible but streamlined) */}
                      <div className="border-t border-border/50 pt-4">
                        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-4">
                          <Target size={12} />
                          Destination
                        </div>
                        <div className="space-y-2">
                          <button
                            onClick={() => setOutputMode('new_thread')}
                            className={cn(
                              'flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-all shadow-sm',
                              outputMode === 'new_thread'
                                ? 'border-primary/20 bg-primary/10'
                                : 'border-border bg-black/40 hover:bg-secondary/30',
                            )}
                          >
                            <div className="min-w-0">
                              <div className="text-[13px] font-semibold text-foreground/90">New thread</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground/60 leading-tight">Post to new thread</div>
                            </div>
                            {outputMode === 'new_thread' ? <Check size={14} className="text-primary" /> : null}
                          </button>

                          <button
                            onClick={() => setOutputMode('existing_thread')}
                            className={cn(
                              'flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-all shadow-sm',
                              outputMode === 'existing_thread'
                                ? 'border-primary/20 bg-primary/10'
                                : 'border-border bg-black/40 hover:bg-secondary/30',
                            )}
                          >
                            <div className="min-w-0">
                              <div className="text-[13px] font-semibold text-foreground/90">Existing thread</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground/60 leading-tight">Fixed desktop thread</div>
                            </div>
                            {outputMode === 'existing_thread' ? <Check size={14} className="text-primary" /> : null}
                          </button>

                          {outputMode === 'existing_thread' ? (
                            <div className="mt-3 rounded-xl border border-border bg-black/40 p-2 space-y-2">
                              <input
                                value={threadSearch}
                                onChange={(event) => setThreadSearch(event.target.value)}
                                placeholder="Search threads..."
                                className="w-full bg-secondary/20 rounded-lg px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/40 border border-transparent focus:border-border"
                              />
                              <div className="max-h-40 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                                {filteredThreads.map((thread) => (
                                  <button
                                    key={thread.id}
                                    onClick={() => setSelectedExistingThreadId(thread.id)}
                                    className={cn(
                                      'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-all',
                                      selectedExistingThreadId === thread.id
                                        ? 'bg-primary/10 text-primary'
                                        : 'hover:bg-secondary/50 text-muted-foreground',
                                    )}
                                  >
                                    <div className="truncate text-[12px] font-medium">{thread.title ?? 'Untitled thread'}</div>
                                    {selectedExistingThreadId === thread.id ? <Check size={12} /> : null}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="border-t border-border/50 pt-4 pb-2">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-4">Capabilities</div>
                        <div className="flex flex-wrap gap-2">
                          {selectedWorkflow.capabilitySummary.requiredTools.map((toolId) => (
                            <span key={toolId} className="rounded-lg border border-border bg-black/40 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground/80 shadow-sm">
                              {toolId}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {selectedBuilderView === 'chat' ? (
                  <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-8 py-8 pb-[180px]">
                    <div className="pointer-events-auto mb-5 rounded-2xl border border-border bg-background/70 px-4 py-3 shadow-sm backdrop-blur">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Planning session</div>
                          <div className="mt-1 text-[14px] font-semibold text-foreground/90">{formatPlanningPhase(selectedWorkflow?.planningState)}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedWorkflow?.planningState?.readyToBuild ? (
                            <>
                              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-500">
                                Ready
                              </div>
                              {!hasGeneratedDraft ? (
                                <button
                                  type="button"
                                  onClick={() => void buildReadyWorkflow()}
                                  disabled={isGenerating}
                                  className="inline-flex h-8 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[11px] font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-30"
                                >
                                  {isGenerating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                  Build now
                                </button>
                              ) : null}
                            </>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => setPlanningSummaryOpen(true)}
                            className="rounded-lg border border-border bg-secondary/30 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                          >
                            View plan
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 text-[12px] leading-relaxed text-muted-foreground/65">
                        {selectedWorkflow?.planningState?.intentSummary
                          ? `${selectedWorkflow.planningState.intentSummary.slice(0, 220)}${selectedWorkflow.planningState.intentSummary.length > 220 ? '...' : ''}`
                          : 'Describe the job, references, outputs, or constraints. Divo will ask for missing details before it builds the workflow.'}
                      </div>
                    </div>

                    {selectedWorkflow?.messages.length ? (
                      <div className="pointer-events-auto flex-1 space-y-4 overflow-y-auto pr-2 custom-scrollbar">
                        {selectedWorkflow.messages.map((message) => (
                          <div
                            key={message.id}
                            className={cn(
                              'max-w-[860px] rounded-2xl border px-5 py-4 shadow-sm',
                              message.role === 'assistant'
                                ? 'border-border bg-background/80 backdrop-blur'
                                : 'ml-auto border-primary/20 bg-primary/10',
                            )}
                          >
                            <div className="flex items-center justify-between gap-4">
                              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">
                                {message.role === 'assistant' ? <Bot size={12} /> : <PencilLine size={12} />}
                                {message.role === 'assistant' ? 'Planner' : 'You'}
                              </div>
                              {message.role === 'assistant' && message.planningState ? (
                                <span className="rounded-lg border border-border bg-secondary/40 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
                                  {formatPlanningPhase(message.planningState)}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/85">
                              {message.role === 'assistant' ? (
                                <MarkdownContent
                                  content={message.content}
                                  className="desktop-markdown break-words [overflow-wrap:anywhere] text-[14px] leading-relaxed text-foreground/85"
                                />
                              ) : (
                                message.content
                              )}
                            </div>
                            {message.referenceContext ? (
                              <div className="mt-3 rounded-xl border border-border bg-black/30 px-3 py-3 text-[12px] leading-relaxed text-muted-foreground/70">
                                <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Referenced context</div>
                                <div className="whitespace-pre-wrap">{message.referenceContext}</div>
                              </div>
                            ) : null}
                            {message.clarificationQuestions?.length ? (
                              <div className="mt-4 grid gap-3">
                                {message.clarificationQuestions.map((question) => (
                                  <div key={question.id} className="rounded-xl border border-border bg-secondary/20 px-4 py-3">
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">
                                      {question.label}
                                    </div>
                                    <div className="mt-2 text-[13px] leading-relaxed text-foreground/85">{question.question}</div>
                                    {question.options?.length ? (
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        {question.options.map((option) => (
                                          <button
                                            key={option.value}
                                            type="button"
                                            onClick={() => applyClarificationAnswer(question, option)}
                                            className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-left text-[12px] font-semibold text-primary transition hover:bg-primary/15"
                                          >
                                            {option.label}
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {message.role === 'assistant' && message.planningState?.planningFindings?.length ? (
                              <div className="mt-4 rounded-xl border border-border bg-black/20 px-4 py-3">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Findings</div>
                                <div className="mt-2 space-y-1 text-[12px] leading-relaxed text-muted-foreground/75">
                                  {message.planningState.planningFindings.map((finding, index) => (
                                    <div key={`${message.id}-finding-${index}`}>- {finding}</div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ))}
                        {isGenerating ? (
                          <div className="max-w-[860px] rounded-2xl border border-border bg-background/80 px-5 py-4 shadow-sm backdrop-blur">
                            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">
                              <Bot size={12} />
                              Planner
                            </div>
                            <div className="mt-3 inline-flex items-center gap-2 text-[13px] text-muted-foreground/75">
                              <Loader2 size={14} className="animate-spin" />
                              Thinking through the workflow...
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex flex-1 items-center justify-center p-12">
                        <div className="max-w-2xl text-center pointer-events-auto -mt-24 flex flex-col items-center">
                          <div className="flex items-center gap-6 mb-6 animate-in fade-in duration-1000 slide-in-from-bottom-2">
                            <div className="relative group">
                              <div className="absolute -inset-3 bg-primary/10 rounded-full blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                              <Logo size={48} className="relative transition-transform duration-500 group-hover:scale-105" />
                            </div>
                            <h2 className="text-[32px] sm:text-[40px] font-medium tracking-[-0.03em] text-foreground/85 leading-none">
                              Plan your workflow
                            </h2>
                          </div>
                          <p className="text-[16px] leading-relaxed text-muted-foreground/50 font-medium max-w-xl mx-auto animate-in fade-in duration-1000 delay-200">
                            Describe the job in plain English. Divo will reason about the task, inspect any references you attach, ask for missing details if needed, and build the workflow when it has enough context.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mx-auto flex w-full max-w-[1100px] flex-1 items-center justify-center px-8 py-8 pb-[140px]">
                    {!hasVisibleWorkflowMap ? (
                      <div className="pointer-events-auto max-w-xl rounded-2xl border border-border bg-background/70 px-6 py-5 text-center shadow-sm backdrop-blur">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Workflow view</div>
                        <div className="mt-2 text-[20px] font-semibold text-foreground/90">No workflow map yet</div>
                        <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground/65">
                          Keep chatting with the planner until you are happy with the plan, then tell it to proceed. Switch back to Chat anytime to continue refining.
                        </div>
                        {selectedWorkflow?.planningState?.readyToBuild ? (
                          <button
                            type="button"
                            onClick={() => void buildReadyWorkflow()}
                            disabled={isGenerating}
                            className="mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[12px] font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-30"
                          >
                            {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Workflow size={14} />}
                            Build workflow now
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}

              </div>

              <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-full max-w-[640px] pointer-events-auto px-5 mb-2">
                <div className={cn(
                  "rounded-2xl border border-border bg-background/82 backdrop-blur-xl px-3.5 pt-3 pb-2.5 shadow-2xl ring-1 ring-white/5 transition-all duration-300",
                  isGenerating && "opacity-60 grayscale-[0.5] pointer-events-none scale-[0.99]"
                )}>
                  {selectedBuilderView === 'chat' ? (
                    <>
                      <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
                        <Bot size={12} />
                        Planning chat
                      </div>
                      {referencedFiles.length > 0 ? (
                        <div className="mb-3 space-y-2">
                          <div className="rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-[11px] leading-relaxed text-primary/85 shadow-sm">
                            Divo will first try indexed company docs for these references, then fall back to OCR if retrieval is insufficient. It will turn those sources into a retrieval, extraction, execution, and reporting workflow.
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {referencedFiles.map((file) => (
                              <div
                                key={file.id}
                                className="inline-flex max-w-full items-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-[11px] text-primary/90 shadow-sm"
                              >
                                {file.mimeType.startsWith('image/') ? <ImageIcon size={12} /> : <FileText size={12} />}
                                <span className="max-w-[220px] truncate font-medium">{file.fileName}</span>
                                <button
                                  type="button"
                                  disabled={isGenerating}
                                  onClick={() => removeReferencedFile(file.id)}
                                  className="rounded-md text-primary/70 transition-colors hover:text-primary"
                                  aria-label={`Remove ${file.fileName}`}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <textarea
                        value={composerText}
                        onChange={(event) => setComposerText(event.target.value)}
                        disabled={isGenerating}
                        placeholder={isGenerating ? "AI is generating your workflow..." : "Describe the workflow step by step..."}
                        className="min-h-[40px] w-full resize-none bg-transparent text-[14px] leading-relaxed tracking-tight text-foreground/90 outline-none placeholder:text-muted-foreground/30"
                      />
                      <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-border/30 pt-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setIsFilesDrawerOpen(true)}
                            disabled={!selectedWorkflow || isGenerating}
                            className={cn(
                              'group relative inline-flex h-7 w-7 items-center justify-center rounded-lg border text-[11px] font-semibold transition-all shadow-sm',
                              referencedFiles.length > 0
                                ? 'border-primary/20 bg-primary/10 text-primary hover:bg-primary/15'
                                : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground',
                              (!selectedWorkflow || isGenerating) && 'cursor-not-allowed opacity-30',
                            )}
                            title={referencedFiles.length > 0 ? `${referencedFiles.length} references selected` : 'Add reference'}
                          >
                            <Paperclip size={14} />
                            {referencedFiles.length > 0 ? (
                              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                                {referencedFiles.length}
                              </span>
                            ) : null}
                            <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                              Add reference
                            </span>
                          </button>
                          {hasVisibleWorkflowMap ? (
                            <button
                              onClick={() => setBuilderView('workflow')}
                              disabled={isGenerating}
                              className="group relative inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-secondary/50 text-[11px] font-semibold text-muted-foreground transition-all shadow-sm hover:bg-secondary hover:text-foreground disabled:opacity-30"
                              title="Back to flow"
                            >
                              <ArrowRight size={14} className="rotate-180" />
                              <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                                Back to flow
                              </span>
                            </button>
                          ) : null}
                          <button
                            onClick={() => void authorWorkflow()}
                            disabled={!composerText.trim() || isGenerating}
                            className="group relative inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-[11px] font-semibold transition-all shadow-sm hover:opacity-90 disabled:opacity-30"
                            title="Send"
                          >
                            {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                            <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                              Send
                            </span>
                          </button>
                          {selectedWorkflow?.planningState?.readyToBuild && !hasGeneratedDraft ? (
                            <button
                              onClick={() => void buildReadyWorkflow()}
                              disabled={isGenerating}
                              className="group relative inline-flex h-7 w-7 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary text-[11px] font-semibold transition-all shadow-sm hover:bg-primary/20 disabled:opacity-30"
                              title="Build workflow now"
                            >
                              <Workflow size={14} />
                              <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                                Build now
                              </span>
                            </button>
                          ) : null}
                          {hasVisibleWorkflowMap ? (
                            <button
                              onClick={() => void publishWorkflow()}
                              disabled={isSaving || isGenerating}
                              className="group relative inline-flex h-7 w-7 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary text-[11px] font-semibold transition-all shadow-sm hover:bg-primary/20 disabled:opacity-30"
                              title="Save workflow"
                            >
                              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                              <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                                Save workflow
                              </span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between gap-6">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                          {hasVisibleWorkflowMap ? <Check size={12} className="text-emerald-500" /> : <Workflow size={12} />}
                          {hasVisibleWorkflowMap ? 'Flow Draft Prepared' : 'Workflow view'}
                        </div>
                        <div className="text-[13px] font-medium text-muted-foreground/60 truncate">
                          {hasVisibleWorkflowMap
                            ? 'Review the map above. Switch back to chat whenever you want to refine the planner logic.'
                            : 'No workflow map is available yet. Switch back to chat and tell the planner when to proceed.'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => setBuilderView('chat')}
                          disabled={isGenerating}
                          className="group relative inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-secondary/50 text-[11px] font-semibold text-muted-foreground transition-all shadow-sm hover:bg-secondary hover:text-foreground disabled:opacity-30"
                          title="Refine logic"
                        >
                          <PencilLine size={14} />
                          <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                            Refine logic
                          </span>
                        </button>
                        <button
                          onClick={() => void publishWorkflow()}
                          disabled={!hasVisibleWorkflowMap || isSaving || isGenerating}
                          className="group relative inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-[11px] font-semibold transition-all shadow-sm hover:opacity-90 disabled:opacity-30"
                          title="Save workflow"
                        >
                          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                          <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                            Save workflow
                          </span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <Dialog.Root open={planningSummaryOpen} onOpenChange={setPlanningSummaryOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 backdrop-blur-md" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(680px,92vw)] max-h-[80vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-background p-0 shadow-xl text-foreground">
              <div className="flex items-start justify-between gap-6 border-b border-border px-6 py-5">
                <div>
                  <Dialog.Title className="text-xl font-bold text-foreground/90">Workflow planning summary</Dialog.Title>
                  <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-muted-foreground/60">
                    Review the current planning conclusions without obscuring the planning chat.
                  </Dialog.Description>
                </div>
                <Dialog.Close className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground transition hover:bg-secondary hover:text-foreground">
                  <X size={16} />
                </Dialog.Close>
              </div>

              <div className="max-h-[calc(80vh-88px)] space-y-5 overflow-y-auto px-6 py-5">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Status</div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="rounded-lg border border-border bg-secondary/40 px-2.5 py-1 text-[11px] font-semibold text-foreground/80">
                      {formatPlanningPhase(selectedWorkflow?.planningState)}
                    </div>
                    {selectedWorkflow?.planningState?.readyToBuild ? (
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-500">
                        Ready to build
                      </div>
                    ) : null}
                  </div>
                </div>

                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Objective</div>
                  <div className="mt-2 text-[14px] leading-relaxed text-foreground/90">
                    {selectedWorkflow?.planningState?.objective || selectedWorkflow?.userIntent || 'No planning objective yet.'}
                  </div>
                </div>

                {selectedWorkflow?.planningState?.intentSummary ? (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Execution summary</div>
                    <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground/75">
                      {selectedWorkflow.planningState.intentSummary}
                    </div>
                  </div>
                ) : null}

                {selectedWorkflow?.planningState?.sourceSummary ? (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Source plan</div>
                    <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground/75">
                      {selectedWorkflow.planningState.sourceSummary}
                    </div>
                  </div>
                ) : null}

                {selectedWorkflow?.planningState?.outputSummary ? (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Output</div>
                    <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground/75">
                      {selectedWorkflow.planningState.outputSummary}
                    </div>
                  </div>
                ) : null}

                {selectedWorkflow?.planningState?.approvalSummary ? (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Approval handling</div>
                    <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground/75">
                      {selectedWorkflow.planningState.approvalSummary}
                    </div>
                  </div>
                ) : null}

                {selectedWorkflow?.planningState?.planningFindings?.length ? (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Findings</div>
                    <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-muted-foreground/75">
                      {selectedWorkflow.planningState.planningFindings.map((finding, index) => (
                        <div key={`planning-finding-${index}`}>- {finding}</div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {selectedWorkflow?.planningState?.suggestedToolFamilies?.length ? (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/45">Suggested tool families</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedWorkflow.planningState.suggestedToolFamilies.map((tool) => (
                        <span key={tool} className="rounded-lg border border-border bg-secondary/20 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground/80">
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root open={saveModalOpen} onOpenChange={setSaveModalOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 backdrop-blur-md" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-8 shadow-xl text-foreground">
              <div className="text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary mb-6 shadow-sm">
                  <Save size={24} />
                </div>
                <Dialog.Title className="text-xl font-bold text-foreground/90">Workflow saved</Dialog.Title>
                <Dialog.Description className="mt-3 text-[14px] leading-relaxed text-muted-foreground/60 font-medium">
                  Your workflow is now in the library. Reference it in chat using <span className="text-primary/80 font-bold">@</span> or activate a schedule to run it automatically.
                </Dialog.Description>
              </div>

              <div className="mt-8 grid gap-2">
                <button
                  onClick={() => {
                    setSaveModalOpen(false)
                    onExit?.()
                  }}
                  className="flex h-11 items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground text-[14px] font-bold hover:opacity-90 transition-all shadow-sm"
                >
                  <AtSign size={16} />
                  Open in Chat
                </button>
                <button
                  onClick={() => {
                    setSaveModalOpen(false)
                    setScheduleModalOpen(true)
                  }}
                  className="flex h-11 items-center justify-center gap-2 rounded-lg border border-primary/20 bg-primary/10 text-primary text-[14px] font-bold hover:bg-primary/20 transition-all shadow-sm"
                >
                  <CalendarClock size={16} />
                  Set Schedule
                </button>
                <button
                  onClick={() => setSaveModalOpen(false)}
                  className="h-11 rounded-lg border border-border bg-secondary/50 text-[14px] font-bold text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
                >
                  Done
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root open={scheduleModalOpen} onOpenChange={setScheduleModalOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 backdrop-blur-md" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-8 shadow-xl overflow-hidden text-foreground">
              <div className="flex items-start justify-between gap-6 mb-8">
                <div>
                  <Dialog.Title className="text-xl font-bold text-foreground/90">Schedule workflow</Dialog.Title>
                  <Dialog.Description className="mt-2 text-[14px] leading-relaxed text-muted-foreground/60 font-medium">
                    Automate this job. Scheduled runs use your saved permissions.
                  </Dialog.Description>
                </div>
                <Dialog.Close className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm">
                  <X size={16} />
                </Dialog.Close>
              </div>

              {scheduleDraft ? (
                <div className="grid gap-6">
                  <div className="rounded-xl border border-border bg-secondary/10 px-4 py-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">Destination</div>
                    <div className="text-[13px] font-medium text-muted-foreground/80">
                      {outputMode === 'existing_thread'
                        ? `Target: ${selectedExistingThread?.title ?? 'selected thread'}`
                        : 'Target: New auto-named thread'}
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Frequency</label>
                      <select
                        value={scheduleDraft.frequency}
                        onChange={(event) => setScheduleDraft((current) => current ? { ...current, frequency: event.target.value as ScheduleFrequency } : current)}
                        className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                      >
                        <option value="hourly">Hourly</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="one_time">One-time</option>
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Timezone</label>
                      <input
                        value={scheduleDraft.timezone}
                        onChange={(event) => setScheduleDraft((current) => current ? { ...current, timezone: event.target.value } : current)}
                        className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                      />
                    </div>
                  </div>

                  {scheduleDraft.frequency === 'hourly' ? (
                    <div className="grid gap-4 sm:grid-cols-2 animate-in fade-in slide-in-from-top-2">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Interval (Hours)</label>
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={scheduleDraft.intervalHours}
                          onChange={(event) => setScheduleDraft((current) => current ? { ...current, intervalHours: Number(event.target.value) || 1 } : current)}
                          className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Minute</label>
                        <input
                          type="number"
                          min={0}
                          max={59}
                          value={scheduleDraft.minute}
                          onChange={(event) => setScheduleDraft((current) => current ? { ...current, minute: Number(event.target.value) || 0 } : current)}
                          className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                        />
                      </div>
                    </div>
                  ) : null}

                  {scheduleDraft.frequency === 'daily' || scheduleDraft.frequency === 'weekly' || scheduleDraft.frequency === 'monthly' || scheduleDraft.frequency === 'one_time' ? (
                    <div className="grid gap-4 sm:grid-cols-2 animate-in fade-in slide-in-from-top-2">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Time</label>
                        <input
                          type="time"
                          value={scheduleDraft.time}
                          onChange={(event) => setScheduleDraft((current) => current ? { ...current, time: event.target.value } : current)}
                          className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                        />
                      </div>

                      {scheduleDraft.frequency === 'weekly' ? (
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Day of Week</label>
                          <select
                            value={scheduleDraft.dayOfWeek}
                            onChange={(event) => setScheduleDraft((current) => current ? { ...current, dayOfWeek: event.target.value } : current)}
                            className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                          >
                            {WEEKDAY_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                      ) : scheduleDraft.frequency === 'monthly' ? (
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Day of Month</label>
                          <input
                            type="number"
                            min={1}
                            max={31}
                            value={scheduleDraft.dayOfMonth}
                            onChange={(event) => setScheduleDraft((current) => current ? { ...current, dayOfMonth: Number(event.target.value) || 1 } : current)}
                            className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                          />
                        </div>
                      ) : scheduleDraft.frequency === 'one_time' ? (
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Run Date</label>
                          <input
                            type="date"
                            value={scheduleDraft.runDate}
                            onChange={(event) => setScheduleDraft((current) => current ? { ...current, runDate: event.target.value } : current)}
                            className="w-full rounded-xl border border-border bg-black/40 px-4 py-2.5 text-[14px] text-foreground outline-none focus:border-primary/30"
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-4 flex items-center justify-end gap-2 pt-4 border-t border-border/50">
                    <button
                      onClick={() => void activateSchedule(false)}
                      disabled={isScheduling}
                      className="h-10 px-4 rounded-lg border border-border bg-secondary/50 text-[13px] font-bold text-muted-foreground hover:bg-secondary hover:text-foreground transition-all disabled:opacity-30 shadow-sm"
                    >
                      {isScheduling ? 'Saving...' : 'Save Draft Schedule'}
                    </button>
                    <button
                      onClick={() => void activateSchedule(true)}
                      disabled={isScheduling}
                      className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-[13px] font-bold hover:opacity-90 transition-all disabled:opacity-30 flex items-center gap-2 shadow-sm"
                    >
                      {isScheduling ? <Loader2 size={14} className="animate-spin" /> : <CalendarClock size={15} />}
                      {isScheduling ? 'Activating...' : 'Activate Schedule'}
                    </button>
                  </div>
                </div>
              ) : null}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <FilesDrawer
          open={isFilesDrawerOpen}
          onClose={() => setIsFilesDrawerOpen(false)}
          onReference={handleReferenceFile}
          referencedIds={referencedFileIds}
        />
      </div>
    </ReactFlowProvider>
  )
}
