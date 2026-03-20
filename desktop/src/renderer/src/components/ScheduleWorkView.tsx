import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import ReactFlow, { Background, Controls, MarkerType, ReactFlowProvider, type Edge, type Node, type NodeProps } from 'reactflow'
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
  PencilLine,
  Plus,
  Save,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'

import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'

type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'one_time'
type WorkflowStatus = 'draft' | 'published' | 'scheduled_active' | 'paused' | 'archived'
type ToolActionGroup = 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'

type WorkflowAuthorMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
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
  messages: WorkflowAuthorMessage[]
}

type WorkflowAuthorResponse = WorkflowRecord & {
  compilerNotes?: string
  model?: { provider: string; modelId: string }
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

const WEEKDAY_OPTIONS = [
  { value: 'MO', label: 'Monday' },
  { value: 'TU', label: 'Tuesday' },
  { value: 'WE', label: 'Wednesday' },
  { value: 'TH', label: 'Thursday' },
  { value: 'FR', label: 'Friday' },
  { value: 'SA', label: 'Saturday' },
  { value: 'SU', label: 'Sunday' },
] as const

const WorkflowNodeCard = ({ data }: NodeProps<{ node: CompiledWorkflowNode }>): JSX.Element => {
  const node = data.node
  const actionLabel = node.capability ? `${node.capability.toolId}.${node.capability.actionGroup}` : 'logic'

  return (
    <div className="w-[280px] rounded-3xl border border-white/10 bg-[rgba(16,18,24,0.95)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-100/45">{node.kind}</div>
          <div className="mt-2 text-base font-semibold text-white">{node.title}</div>
        </div>
        <span
          className={cn(
            'rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
            node.capability?.actionGroup && ['create', 'update', 'delete', 'send', 'execute'].includes(node.capability.actionGroup)
              ? 'border-amber-300/20 bg-amber-400/10 text-amber-100'
              : 'border-emerald-300/20 bg-emerald-400/10 text-emerald-100',
          )}
        >
          {actionLabel}
        </span>
      </div>
      {node.instructions ? (
        <p className="mt-3 text-sm leading-6 text-white/65">{node.instructions}</p>
      ) : null}
      {node.expectedOutput ? (
        <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs leading-5 text-white/50">
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

  const nodes: Node[] = spec.nodes.map((node, index) => ({
    id: node.id,
    type: 'workflowNode',
    data: { node },
    position: { x: index % 2 === 0 ? 60 : 420, y: index * 190 },
    draggable: false,
    selectable: false,
  }))

  const edges: Edge[] = spec.edges.map((edge, index) => ({
    id: `${edge.sourceId}-${edge.targetId}-${index}`,
    source: edge.sourceId,
    target: edge.targetId,
    label: edge.label ?? (edge.condition !== 'always' ? edge.condition : undefined),
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: edge.condition !== 'always',
    style: { stroke: 'rgba(126, 231, 255, 0.42)', strokeWidth: 1.5 },
    labelStyle: { fill: 'rgba(255,255,255,0.55)', fontSize: 11 },
  }))

  return { nodes, edges }
}

function formatScheduleSummary(schedule: WorkflowSchedule): string {
  if (schedule.type === 'hourly') {
    return `Every ${schedule.intervalHours} hour${schedule.intervalHours === 1 ? '' : 's'}`
  }
  if (schedule.type === 'daily') {
    return `Daily at ${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')}`
  }
  if (schedule.type === 'weekly') {
    const day = WEEKDAY_OPTIONS.find((option) => option.value === schedule.daysOfWeek[0])?.label ?? schedule.daysOfWeek[0]
    return `Weekly on ${day}`
  }
  if (schedule.type === 'monthly') {
    return `Monthly on day ${schedule.dayOfMonth}`
  }
  return `One-time on ${new Date(schedule.runAt).toLocaleDateString()}`
}

function toScheduleModalDraft(schedule: WorkflowSchedule): ScheduleModalDraft {
  if (schedule.type === 'hourly') {
    return {
      frequency: 'hourly',
      timezone: schedule.timezone,
      intervalHours: schedule.intervalHours,
      minute: schedule.minute,
      time: '09:00',
      dayOfWeek: 'MO',
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
      dayOfWeek: 'MO',
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
      dayOfWeek: schedule.daysOfWeek[0] ?? 'MO',
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
      dayOfWeek: 'MO',
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
    dayOfWeek: 'MO',
    dayOfMonth: 1,
    runDate: date.toISOString().slice(0, 10),
  }
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
    return { frequency: 'weekly', timezone: draft.timezone, time: draft.time, dayOfWeek: draft.dayOfWeek }
  }
  if (draft.frequency === 'monthly') {
    return { frequency: 'monthly', timezone: draft.timezone, time: draft.time, dayOfMonth: draft.dayOfMonth }
  }
  return { frequency: 'one_time', timezone: draft.timezone, time: draft.time, runDate: draft.runDate }
}

function createSkeletonBlocks(): JSX.Element {
  return (
    <div className="flex h-full min-h-[520px] items-center justify-center rounded-[32px] border border-white/8 bg-[rgba(255,255,255,0.02)]">
      <div className="flex w-full max-w-3xl flex-col items-center gap-6 px-8">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex w-full flex-col items-center gap-4">
            <div className="h-28 w-full max-w-[320px] animate-pulse rounded-3xl border border-white/8 bg-white/[0.04]" />
            {index < 2 ? <ArrowRight className="text-white/15" size={18} /> : null}
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
  const [isArchiving, setIsArchiving] = useState(false)
  const [isDuplicating, setIsDuplicating] = useState(false)
  const [composerMode, setComposerMode] = useState<'compose' | 'actions'>('compose')
  const [composerText, setComposerText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [jsonDraft, setJsonDraft] = useState('')
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleModalDraft | null>(null)

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null
  const graph = useMemo(() => buildGraph(selectedWorkflow?.workflowSpec ?? null), [selectedWorkflow?.workflowSpec])
  const hasGeneratedDraft = Boolean(
    selectedWorkflow
    && (selectedWorkflow.messages.length > 0 || selectedWorkflow.aiDraft?.trim() || selectedWorkflow.compiledPrompt.trim()),
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

  const createDraft = async (): Promise<WorkflowRecord> => {
    if (!token) {
      throw new Error('Sign in again before creating a workflow.')
    }
    const response = await window.desktopAPI.fetch('/api/desktop/workflows/drafts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
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
    if (!selectedWorkflow) return
    setPromptDraft(selectedWorkflow.aiDraft ?? '')
    setJsonDraft(JSON.stringify(selectedWorkflow.workflowSpec, null, 2))
    setScheduleDraft(toScheduleModalDraft(selectedWorkflow.schedule))
    setComposerText('')
    setComposerMode(selectedWorkflow.messages.length > 0 || Boolean(selectedWorkflow.aiDraft?.trim()) ? 'actions' : 'compose')
  }, [selectedWorkflowId])

  const authorWorkflow = async (): Promise<void> => {
    if (!selectedWorkflow || !token || !composerText.trim()) return
    setIsGenerating(true)
    setError(null)
    try {
      const response = await window.desktopAPI.fetch(`/api/desktop/workflows/${selectedWorkflow.id}/author`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: composerText.trim() }),
      })
      if (response.status < 200 || response.status >= 300) {
        const parsed = JSON.parse(response.body) as { message?: string }
        throw new Error(parsed.message || 'Failed to generate workflow')
      }
      const parsed = JSON.parse(response.body) as { data: WorkflowAuthorResponse }
      upsertWorkflow(parsed.data)
      setComposerText('')
      setComposerMode('actions')
    } catch (authorError) {
      setError(authorError instanceof Error ? authorError.message : 'Failed to generate workflow')
    } finally {
      setIsGenerating(false)
    }
  }

  const publishWorkflow = async (): Promise<void> => {
    if (!selectedWorkflow || !token) return
    setIsSaving(true)
    setError(null)
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
          destinations: [],
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
      await loadWorkflows(selectedWorkflow.id)
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
    try {
      await updateWorkflow({ aiDraft: promptDraft, name: selectedWorkflow.name })
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to save prompt edits')
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
    try {
      await updateWorkflow({ schedule: fromScheduleModalDraft(scheduleDraft ?? toScheduleModalDraft(selectedWorkflow.schedule)) })
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
      await loadWorkflows(selectedWorkflow.id)
      setScheduleModalOpen(false)
      setSaveModalOpen(false)
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : 'Failed to update schedule')
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
      <div className="flex h-full min-h-0 bg-[radial-gradient(circle_at_top_right,_rgba(41,121,255,0.12),_transparent_28%),linear-gradient(180deg,_rgba(12,14,17,1)_0%,_rgba(10,10,12,1)_100%)]">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-white/6 bg-[rgba(8,10,14,0.88)] px-4 py-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-cyan-200/55">Workflows</div>
              <div className="mt-1 text-sm font-semibold text-white/92">Prompt library</div>
            </div>
            <button
              onClick={() => void createDraft()}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15"
            >
              <Plus size={14} />
              New
            </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto pr-1">
            {workflows.map((workflow) => (
              <button
                key={workflow.id}
                onClick={() => setSelectedWorkflowId(workflow.id)}
                className={cn(
                  'w-full rounded-3xl border px-4 py-4 text-left transition-all',
                  selectedWorkflowId === workflow.id
                    ? 'border-cyan-300/30 bg-cyan-400/10 shadow-[0_20px_40px_rgba(0,0,0,0.18)]'
                    : 'border-white/6 bg-white/[0.03] hover:border-white/12 hover:bg-white/[0.05]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{workflow.name}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-white/45">
                      {workflow.userIntent || workflow.aiDraft || 'Describe what this workflow should do.'}
                    </div>
                  </div>
                  <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/55">
                    {workflow.status.replace('_', ' ')}
                  </span>
                </div>
                <div className="mt-4 flex items-center justify-between text-[11px] text-white/45">
                  <span>{formatScheduleSummary(workflow.schedule)}</span>
                  <span>{workflow.nextRunAt ? new Date(workflow.nextRunAt).toLocaleDateString() : 'draft'}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/6 px-6 py-5">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100/80">
                <Workflow size={12} />
                Workflow builder
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">
                {selectedWorkflow?.name || 'Workflow builder'}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-white/55">
                Describe a reusable job once, let AI turn it into a clean execution map, then save it for reuse with <span className="font-medium text-white/75">@</span> or attach a schedule when you are ready.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {onExit ? (
                <button
                  onClick={onExit}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/75 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  Chat
                </button>
              ) : null}
              <button
                onClick={() => void duplicateWorkflow()}
                disabled={!selectedWorkflow || isDuplicating}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CopyPlus size={15} />
                Duplicate
              </button>
              <button
                onClick={() => setScheduleModalOpen(true)}
                disabled={!selectedWorkflow}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CalendarClock size={15} />
                Schedule
              </button>
              <button
                onClick={() => void archiveWorkflow()}
                disabled={!selectedWorkflow || isArchiving}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:border-red-400/25 hover:bg-red-500/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Archive size={15} />
                Archive
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-6">
            {error ? (
              <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {error}
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-hidden rounded-[32px] border border-white/8 bg-[rgba(255,255,255,0.02)]">
                {isGenerating ? (
                  createSkeletonBlocks()
                ) : hasGeneratedDraft ? (
                  <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.5fr)_360px] overflow-hidden">
                    <div className="min-h-0 border-r border-white/8">
                      <ReactFlow
                        nodes={graph.nodes}
                        edges={graph.edges}
                        nodeTypes={nodeTypes}
                        nodesDraggable={false}
                        nodesConnectable={false}
                        elementsSelectable={false}
                        fitView
                        fitViewOptions={{ padding: 0.16 }}
                        proOptions={{ hideAttribution: true }}
                      >
                        <Background color="rgba(255,255,255,0.06)" gap={28} />
                        <Controls showInteractive={false} />
                      </ReactFlow>
                    </div>

                    <div className="min-h-0 overflow-y-auto px-5 py-5">
                      <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4">
                        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-cyan-100/45">
                          <Bot size={12} />
                          Reusable prompt
                        </div>
                        <textarea
                          value={promptDraft}
                          onChange={(event) => setPromptDraft(event.target.value)}
                          className="mt-3 min-h-[180px] w-full resize-none rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-white/85 outline-none transition-colors focus:border-cyan-300/35"
                        />
                        <button
                          onClick={() => void savePromptEdits()}
                          className="mt-3 inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15"
                        >
                          <Save size={13} />
                          Save prompt text
                        </button>
                      </div>

                      <div className="mt-4 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
                        <button
                          onClick={() => setAdvancedOpen((open) => !open)}
                          className="flex w-full items-center justify-between text-left"
                        >
                          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                            <FileJson2 size={12} />
                            Advanced JSON
                          </div>
                          {advancedOpen ? <ChevronDown size={16} className="text-white/40" /> : <ChevronRight size={16} className="text-white/40" />}
                        </button>

                        {advancedOpen ? (
                          <div className="mt-3">
                            <textarea
                              value={jsonDraft}
                              onChange={(event) => setJsonDraft(event.target.value)}
                              className="min-h-[240px] w-full resize-y rounded-2xl border border-white/8 bg-black/20 px-4 py-3 font-mono text-[12px] leading-6 text-white/80 outline-none transition-colors focus:border-cyan-300/35"
                            />
                            <button
                              onClick={() => void saveJsonEdits()}
                              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                            >
                              <Save size={13} />
                              Save JSON changes
                            </button>
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-4 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Capabilities</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {selectedWorkflow.capabilitySummary.requiredTools.map((toolId) => (
                            <span key={toolId} className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/70">
                              {toolId}
                            </span>
                          ))}
                        </div>
                        <div className="mt-3 text-xs text-white/45">
                          {selectedWorkflow.capabilitySummary.requiresPublishApproval
                            ? 'This workflow includes write-capable actions and keeps strict approval behavior.'
                            : 'This workflow is currently read-only safe for reuse.'}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full min-h-[520px] items-center justify-center px-8">
                    <div className="max-w-2xl text-center">
                      <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100/80">
                        <Sparkles size={12} />
                        Start with the composer
                      </div>
                      <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white">Describe the job in plain English</h2>
                      <p className="mt-3 text-sm leading-7 text-white/55">
                        Divo will turn it into a reusable prompt and a visual workflow map. Once the draft looks right, save it and reuse it later with <span className="font-medium text-white/75">@</span>.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-5 shrink-0">
                <div className="mx-auto max-w-5xl rounded-[28px] border border-white/8 bg-[rgba(18,20,26,0.95)] px-5 py-4 shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
                  {composerMode === 'compose' ? (
                    <>
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                        <PencilLine size={12} />
                        Workflow composer
                      </div>
                      <textarea
                        value={composerText}
                        onChange={(event) => setComposerText(event.target.value)}
                        placeholder="Describe what this workflow should do, step by step if you want. For example: every Monday gather open finance blockers, summarize risks, update the weekly Lark note, and send me a digest."
                        className="mt-3 min-h-[112px] w-full resize-none bg-transparent text-[15px] leading-7 text-white/90 outline-none placeholder:text-white/25"
                      />
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div className="text-xs text-white/40">
                          {hasGeneratedDraft
                            ? 'Keep editing in natural language. You can refine again, or save this version right away.'
                            : 'Use plain language. Divo will compile it into a reusable prompt plus a visual execution map.'}
                        </div>
                        <div className="flex items-center gap-2">
                          {hasGeneratedDraft ? (
                            <button
                              onClick={() => setComposerMode('actions')}
                              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                            >
                              Back to actions
                            </button>
                          ) : null}
                          <button
                            onClick={() => void authorWorkflow()}
                            disabled={!composerText.trim() || isGenerating}
                            className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-50 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Sparkles size={15} />
                            {hasGeneratedDraft ? 'Refine with AI' : 'Generate workflow'}
                          </button>
                          {hasGeneratedDraft ? (
                            <button
                              onClick={() => void publishWorkflow()}
                              disabled={isSaving}
                              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-50 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Save size={15} />
                              Save
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                          <Check size={12} />
                          Draft ready
                        </div>
                        <div className="mt-2 text-sm text-white/70">
                          Edit further to keep iterating in natural language, or save this workflow to the reusable library.
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setComposerMode('compose')}
                          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                        >
                          Edit further
                        </button>
                        <button
                          onClick={() => void publishWorkflow()}
                          disabled={isSaving}
                          className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-50 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Save size={15} />
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <Dialog.Root open={saveModalOpen} onOpenChange={setSaveModalOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-white/10 bg-[rgba(12,14,18,0.98)] p-6 shadow-[0_30px_90px_rgba(0,0,0,0.45)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-2xl font-semibold text-white">Workflow saved</Dialog.Title>
                  <Dialog.Description className="mt-2 text-sm leading-6 text-white/60">
                    This workflow now lives in your personal library. You can reference it from chat using <span className="font-medium text-white/80">@</span>, or attach a schedule right now.
                  </Dialog.Description>
                </div>
                <Dialog.Close className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white">
                  <X size={16} />
                </Dialog.Close>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <button
                  onClick={() => {
                    setSaveModalOpen(false)
                    onExit?.()
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                >
                  <AtSign size={15} />
                  Use in chat
                </button>
                <button
                  onClick={() => {
                    setSaveModalOpen(false)
                    setScheduleModalOpen(true)
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm font-medium text-cyan-50 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15"
                >
                  <CalendarClock size={15} />
                  Schedule now
                </button>
                <button
                  onClick={() => setSaveModalOpen(false)}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                >
                  Close
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root open={scheduleModalOpen} onOpenChange={setScheduleModalOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(620px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-white/10 bg-[rgba(12,14,18,0.98)] p-6 shadow-[0_30px_90px_rgba(0,0,0,0.45)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-2xl font-semibold text-white">Schedule workflow</Dialog.Title>
                  <Dialog.Description className="mt-2 text-sm leading-6 text-white/60">
                    Choose when this saved workflow should run. Scheduled runs still use the same desktop runtime and tool permissions.
                  </Dialog.Description>
                </div>
                <Dialog.Close className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white">
                  <X size={16} />
                </Dialog.Close>
              </div>

              {scheduleDraft ? (
                <div className="mt-6 grid gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Frequency</span>
                      <select
                        value={scheduleDraft.frequency}
                        onChange={(event) => setScheduleDraft((current) => current ? { ...current, frequency: event.target.value as ScheduleFrequency } : current)}
                        className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                      >
                        <option value="hourly">Every X hours</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="one_time">One-time</option>
                      </select>
                    </label>

                    <label className="block">
                      <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Timezone</span>
                      <input
                        value={scheduleDraft.timezone}
                        onChange={(event) => setScheduleDraft((current) => current ? { ...current, timezone: event.target.value } : current)}
                        className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                      />
                    </label>
                  </div>

                  {scheduleDraft.frequency === 'hourly' ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Every how many hours?</span>
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={scheduleDraft.intervalHours}
                          onChange={(event) => setScheduleDraft((current) => current ? { ...current, intervalHours: Number(event.target.value) || 1 } : current)}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Minute of the hour</span>
                        <input
                          type="number"
                          min={0}
                          max={59}
                          value={scheduleDraft.minute}
                          onChange={(event) => setScheduleDraft((current) => current ? { ...current, minute: Number(event.target.value) || 0 } : current)}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                        />
                      </label>
                    </div>
                  ) : null}

                  {scheduleDraft.frequency === 'daily' || scheduleDraft.frequency === 'weekly' || scheduleDraft.frequency === 'monthly' || scheduleDraft.frequency === 'one_time' ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Time</span>
                        <input
                          type="time"
                          value={scheduleDraft.time}
                          onChange={(event) => setScheduleDraft((current) => current ? { ...current, time: event.target.value } : current)}
                          className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                        />
                      </label>

                      {scheduleDraft.frequency === 'weekly' ? (
                        <label className="block">
                          <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Day of week</span>
                          <select
                            value={scheduleDraft.dayOfWeek}
                            onChange={(event) => setScheduleDraft((current) => current ? { ...current, dayOfWeek: event.target.value } : current)}
                            className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                          >
                            {WEEKDAY_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                      ) : scheduleDraft.frequency === 'monthly' ? (
                        <label className="block">
                          <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Day of month</span>
                          <input
                            type="number"
                            min={1}
                            max={31}
                            value={scheduleDraft.dayOfMonth}
                            onChange={(event) => setScheduleDraft((current) => current ? { ...current, dayOfMonth: Number(event.target.value) || 1 } : current)}
                            className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                          />
                        </label>
                      ) : scheduleDraft.frequency === 'one_time' ? (
                        <label className="block">
                          <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-white/45">Run date</span>
                          <input
                            type="date"
                            value={scheduleDraft.runDate}
                            onChange={(event) => setScheduleDraft((current) => current ? { ...current, runDate: event.target.value } : current)}
                            className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
                          />
                        </label>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm text-white/65">
                    <div className="flex items-center gap-2">
                      <Clock3 size={15} className="text-cyan-200/70" />
                      {scheduleDraft.frequency === 'hourly'
                        ? `This workflow will run every ${scheduleDraft.intervalHours} hour${scheduleDraft.intervalHours === 1 ? '' : 's'}.`
                        : 'This schedule will be saved on the workflow and can be paused or resumed later.'}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => void activateSchedule(false)}
                      className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                    >
                      Save without schedule
                    </button>
                    <button
                      onClick={() => void activateSchedule(true)}
                      className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-50 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15"
                    >
                      <CalendarClock size={15} />
                      Activate schedule
                    </button>
                  </div>
                </div>
              ) : null}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </ReactFlowProvider>
  )
}
