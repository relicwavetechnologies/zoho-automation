import { useEffect, useState } from 'react'
import {
  AlarmClock,
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
  Workflow,
} from 'lucide-react'

import { cn } from '../lib/utils'

type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'one_time'
type WorkflowDraftStatus = 'draft' | 'reviewed' | 'published'

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
  status: WorkflowDraftStatus
  updatedAt: string
}

type WorkflowStepPreview = {
  id: string
  kind: 'read' | 'analyze' | 'createDraft' | 'updateSystem' | 'send' | 'deliver'
  title: string
  description: string
  capability: string
  approvalLevel: 'none' | 'publish'
}

type WorkflowReviewSummary = {
  steps: WorkflowStepPreview[]
  tools: string[]
  actionGroups: string[]
  destinations: string[]
  publishApprovalRequired: boolean
  compiledPrompt: string
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

function inferWorkflowSummary(draft: WorkflowDraft): WorkflowReviewSummary {
  const source = `${draft.name} ${draft.userIntent}`.toLowerCase()
  const wantsUpdate = /\b(update|edit|change|sync|write|modify|patch)\b/.test(source)
  const wantsCreate = /\b(create|draft|prepare|compose|build)\b/.test(source)
  const wantsSend = /\b(send|post|notify|message|email|share|deliver)\b/.test(source)
  const wantsExecute = /\b(run|execute|deploy|command)\b/.test(source)
  const mentionsFinance = /\b(invoice|finance|books|zoho)\b/.test(source)
  const mentionsCalendar = /\b(calendar|meeting|schedule)\b/.test(source)

  const steps: WorkflowStepPreview[] = [
    {
      id: 'collect-context',
      kind: 'read',
      title: 'Gather source context',
      description: 'Read the relevant systems, documents, and recent state needed for the scheduled run.',
      capability: mentionsFinance ? 'zoho-books-read.read' : mentionsCalendar ? 'lark-calendar-read.read' : 'search-read.read',
      approvalLevel: 'none',
    },
    {
      id: 'analyze-findings',
      kind: 'analyze',
      title: 'Analyze and rank findings',
      description: 'Condense the raw inputs into a structured summary with priorities, blockers, and follow-ups.',
      capability: 'runtime.reason',
      approvalLevel: 'none',
    },
  ]

  if (wantsCreate) {
    steps.push({
      id: 'prepare-draft',
      kind: 'createDraft',
      title: 'Prepare draft output',
      description: 'Create a clean draft artifact before anything is sent or updated.',
      capability: 'workspace.createDraft',
      approvalLevel: 'none',
    })
  }

  if (wantsUpdate || wantsExecute) {
    steps.push({
      id: 'apply-changes',
      kind: 'updateSystem',
      title: wantsExecute ? 'Run system action' : 'Apply approved updates',
      description: wantsExecute
        ? 'Execute the requested operational action when the scheduled run reaches that step.'
        : 'Write approved changes back to the target system only if they are covered by publish-time approval.',
      capability: wantsExecute ? 'coding.execute' : mentionsFinance ? 'zoho-books-write.update' : 'coding.update',
      approvalLevel: 'publish',
    })
  }

  if (wantsSend || draft.larkChat || draft.desktopInbox || draft.desktopThread) {
    steps.push({
      id: 'send-results',
      kind: 'send',
      title: 'Send result to destination',
      description: 'Deliver the final summary to the configured destination set for this workflow.',
      capability: draft.larkChat ? 'lark-response.send' : 'response.send',
      approvalLevel: 'publish',
    })
  }

  steps.push({
    id: 'persist-history',
    kind: 'deliver',
    title: 'Persist run history',
    description: 'Store the execution summary, delivery state, and the latest published plan for auditing.',
    capability: 'execution.history',
    approvalLevel: 'none',
  })

  const tools = Array.from(new Set(steps.map((step) => step.capability.split('.')[0])))
  const actionGroups = Array.from(new Set(
    steps
      .filter((step) => step.approvalLevel === 'publish')
      .map((step) => step.capability.split('.')[1] ?? 'send'),
  ))

  const destinations = [
    draft.desktopInbox ? 'Desktop inbox' : null,
    draft.desktopThread ? `Desktop thread: ${draft.desktopThreadLabel || 'Selected thread'}` : null,
    draft.larkChat ? `Lark chat: ${draft.larkChatLabel || 'Configured chat'}` : null,
  ].filter(Boolean) as string[]

  const compiledPrompt = [
    `Workflow: ${draft.name || 'Untitled workflow'}`,
    `Intent: ${draft.userIntent || 'No workflow intent has been written yet.'}`,
    `Schedule: ${formatScheduleLabel(draft)}`,
    `Destinations: ${destinations.join(', ') || 'No destinations selected'}`,
    'Steps:',
    ...steps.map((step, index) => `${index + 1}. ${step.title} [${step.capability}]`),
  ].join('\n')

  return {
    steps,
    tools,
    actionGroups,
    destinations,
    publishApprovalRequired: actionGroups.length > 0,
    compiledPrompt,
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

export function ScheduleWorkView(): JSX.Element {
  const [drafts, setDrafts] = useState<WorkflowDraft[]>(() => readDraftsFromStorage())
  const [selectedDraftId, setSelectedDraftId] = useState<string>(() => readDraftsFromStorage()[0]?.id ?? '')
  const [activePanel, setActivePanel] = useState<'graph' | 'prompt'>('graph')

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  }, [drafts])

  useEffect(() => {
    if (!drafts.find((draft) => draft.id === selectedDraftId) && drafts[0]) {
      setSelectedDraftId(drafts[0].id)
    }
  }, [drafts, selectedDraftId])

  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? drafts[0]
  const summary = selectedDraft ? inferWorkflowSummary(selectedDraft) : null

  const updateSelectedDraft = (updates: Partial<WorkflowDraft>): void => {
    if (!selectedDraft) return

    setDrafts((current) =>
      current.map((draft) =>
        draft.id === selectedDraft.id
          ? {
            ...draft,
            ...updates,
            status: updates.status ?? 'draft',
            updatedAt: new Date().toISOString(),
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
      status: 'draft' as const,
      updatedAt: new Date().toISOString(),
    }
    setDrafts((current) => [copy, ...current])
    setSelectedDraftId(copy.id)
  }

  const deleteDraft = (): void => {
    if (!selectedDraft) return
    if (!window.confirm(`Delete workflow draft "${selectedDraft.name}"?`)) return

    setDrafts((current) => {
      const remaining = current.filter((draft) => draft.id !== selectedDraft.id)
      return remaining.length > 0 ? remaining : [createBlankDraft()]
    })
  }

  const reviewDraft = (): void => {
    updateSelectedDraft({ status: 'reviewed' })
  }

  const publishDraft = (): void => {
    updateSelectedDraft({ status: 'published' })
  }

  if (!selectedDraft || !summary) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No workflow draft available.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_top_right,_rgba(41,121,255,0.12),_transparent_28%),linear-gradient(180deg,_rgba(12,14,17,1)_0%,_rgba(10,10,12,1)_100%)]">
      <div className="min-h-0 w-[290px] shrink-0 border-r border-white/5 bg-[rgba(8,10,14,0.86)] px-3 py-4">
        <div className="mb-4 flex items-center justify-between px-2">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-cyan-200/55">Schedule Work</div>
            <div className="mt-1 text-sm font-semibold text-white/92">Workflow drafts</div>
          </div>
          <button
            onClick={createDraft}
            className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15"
          >
            <Plus size={14} />
            New
          </button>
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
                <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/55">
                  {statusLabel(draft.status)}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-white/45">
                <span>{formatScheduleLabel(draft)}</span>
                <span>{new Date(draft.updatedAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

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
                <button
                  onClick={duplicateDraft}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                >
                  <CopyPlus size={15} />
                  Duplicate
                </button>
                <button
                  onClick={deleteDraft}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:border-red-400/25 hover:bg-red-500/10 hover:text-red-100"
                >
                  <Trash2 size={15} />
                  Delete
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
                      <p className="mt-1 text-sm text-white/45">The graph updates live as you change the workflow brief.</p>
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
                    <div className="mt-6 space-y-3">
                      {summary.steps.map((step, index) => (
                        <div key={step.id}>
                          <div className="rounded-3xl border border-white/8 bg-black/20 p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-100/55">{step.kind}</div>
                                <div className="mt-1 text-sm font-semibold text-white">{step.title}</div>
                                <p className="mt-2 text-sm leading-6 text-white/50">{step.description}</p>
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-white/60">
                                  {step.capability}
                                </span>
                                <span
                                  className={cn(
                                    'rounded-full px-3 py-1 text-[11px] font-medium',
                                    step.approvalLevel === 'publish'
                                      ? 'border border-amber-300/20 bg-amber-400/10 text-amber-100'
                                      : 'border border-emerald-300/20 bg-emerald-400/10 text-emerald-100',
                                  )}
                                >
                                  {step.approvalLevel === 'publish' ? 'Needs publish approval' : 'Read-only'}
                                </span>
                              </div>
                            </div>
                          </div>
                          {index < summary.steps.length - 1 && (
                            <div className="flex justify-center py-2 text-white/20">
                              <ChevronRight className="rotate-90" size={16} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <pre className="mt-6 overflow-x-auto rounded-3xl border border-white/8 bg-black/30 p-4 text-xs leading-6 text-white/70">
                      {summary.compiledPrompt}
                    </pre>
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

                  <div className="mt-5 grid gap-4">
                    <SummaryStrip icon={<Layers3 size={15} />} label="Likely tools" values={summary.tools} />
                    <SummaryStrip icon={<AlarmClock size={15} />} label="Action groups" values={summary.actionGroups.length > 0 ? summary.actionGroups : ['read only']} />
                    <SummaryStrip icon={<Clock3 size={15} />} label="Destinations" values={summary.destinations.length > 0 ? summary.destinations : ['No destination selected']} />
                  </div>

                  <div className="mt-5 rounded-3xl border border-white/8 bg-black/20 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-white">
                          {summary.publishApprovalRequired ? 'Publish approval required' : 'Ready to publish'}
                        </div>
                        <p className="mt-1 text-sm text-white/45">
                          {summary.publishApprovalRequired
                            ? 'This workflow includes send, update, or execute capabilities and should capture approval at publish time.'
                            : 'This workflow is currently read-only and can be activated without extra write approval.'}
                        </p>
                      </div>
                      <div className="rounded-full border border-white/10 px-3 py-2 text-xs uppercase tracking-[0.18em] text-white/55">
                        {statusLabel(selectedDraft.status)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <button
                      onClick={reviewDraft}
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
                    >
                      <Save size={15} />
                      Mark ready
                    </button>
                    <button
                      onClick={publishDraft}
                      className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/25 bg-cyan-400/12 px-4 py-3 text-sm font-medium text-cyan-50 transition-colors hover:bg-cyan-400/20"
                    >
                      <CheckCircle2 size={15} />
                      Publish workflow
                    </button>
                  </div>
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
