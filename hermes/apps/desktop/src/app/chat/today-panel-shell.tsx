import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { FollowUpsChrome } from '@/app/follow-ups/follow-ups-chrome'
import {
  buildDayPrompt,
  contextRefFromTask,
  useTodayPanelData,
  type LarkContextRef
} from '@/lib/today-panel'
import {
  $followUpCreateSignal,
  $followUpLifecycleSignal,
  $todayPanelComposerBridge,
  $todayPanelLandingRefs,
  bumpFollowUpCreateSignal,
  requestFollowUpLifecycle,
  toggleTodayPanelLandingRef
} from '@/store/today-panel-bridge'

import { TodayPanel } from './landing/today-panel'

export function TodayPanelShell() {
  const todayPanel = useTodayPanelData()
  const landingRefs = useStore($todayPanelLandingRefs)
  const composerBridge = useStore($todayPanelComposerBridge)
  const followUpCreateSignal = useStore($followUpCreateSignal)
  const followUpLifecycleSignal = useStore($followUpLifecycleSignal)

  const referencedIds = useMemo(() => new Set(landingRefs.map(ref => ref.id)), [landingRefs])
  const taskRecordsById = useMemo(
    () => new Map((todayPanel.data?.tasks ?? []).map(record => [record.id, record])),
    [todayPanel.data?.tasks]
  )
  const meetingsById = useMemo(
    () => new Map((todayPanel.data?.meetings ?? []).map(meeting => [meeting.id, meeting])),
    [todayPanel.data?.meetings]
  )

  const followUpConfirmedStartSignal = useMemo(() => {
    if (!composerBridge?.landing || !composerBridge.busy) {
      return null
    }

    const lastAssistant = composerBridge.messages.findLast(
      message =>
        message.role === 'assistant' &&
        !message.hidden &&
        message.parts.length > 0 &&
        'pending' in message &&
        Boolean((message as { pending?: boolean }).pending)
    )

    if (!lastAssistant) {
      return null
    }

    return {
      activeSessionId: composerBridge.sessionId ?? composerBridge.activeQueueSessionKey,
      sequence: lastAssistant.id
    }
  }, [composerBridge])

  const handleToggleReference = (ref: LarkContextRef) => {
    toggleTodayPanelLandingRef(ref)
    composerBridge?.requestMainFocus()
  }

  const handleUsePrompt = (prompt: string) => {
    composerBridge?.insertText(prompt)
    composerBridge?.requestMainFocus()
  }

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-[#101010]">
      {todayPanel.error && !todayPanel.loading ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#3a2a2a] bg-[#221818] px-4 py-2 text-[11px] text-[#e0b0b0]">
          <span className="min-w-0 truncate">Lark sync failed: {todayPanel.error}</span>
          <button
            className="shrink-0 rounded border border-[#5a3a3a] px-2 py-0.5 text-[10px] text-[#f0d0d0] hover:bg-[#2a1818]"
            onClick={() => void todayPanel.refresh()}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
      <FollowUpsChrome
        activeContextTaskIds={composerBridge?.referencedTaskIds}
        confirmedStartSignal={followUpConfirmedStartSignal}
        createRequestSignal={followUpCreateSignal}
        externalTasks={todayPanel.tasks}
        externalTasksLoading={todayPanel.loading}
        lifecycleRequestSignal={followUpLifecycleSignal}
        overlay={false}
        onGenerateCompletionSummary={composerBridge?.generateFollowUpCompletionSummary}
        onTasksRefresh={todayPanel.refresh}
        onAddToContext={task => {
          const taskGuid = task.id.replace(/^lark:/, '')
          handleToggleReference({
            id: task.id,
            kind: 'task',
            label: task.title,
            detail: `${task.assignedBy} · ${task.dueLabel}`,
            larkRef: `@lark-task:${taskGuid}`,
            payload: {
              taskGuid,
              ...(task.larkTaskUrl ? { larkTaskUrl: task.larkTaskUrl } : {})
            }
          })
        }}
      />
      <TodayPanel
        activeFollowUps={todayPanel.brief.activeFollowUps}
        className="h-full w-full"
        counts={todayPanel.brief.counts}
        dateLabel={todayPanel.brief.dateLabel}
        docs={todayPanel.brief.docs}
        loading={todayPanel.loading}
        meetings={todayPanel.brief.meetings}
        meetingsById={meetingsById}
        needsYou={todayPanel.brief.needsYou}
        nextMeeting={todayPanel.brief.nextMeeting}
        onActiveLifecycle={requestFollowUpLifecycle}
        onAssignFollowUp={bumpFollowUpCreateSignal}
        onSummarizeDay={() => {
          if (!todayPanel.data) {
            return
          }
          handleUsePrompt(buildDayPrompt(todayPanel.data, 'all'))
        }}
        onToggleReference={ref => {
          if (ref.kind === 'task') {
            const record = taskRecordsById.get(ref.id)
            if (record) {
              handleToggleReference(contextRefFromTask(record))
              return
            }
          }
          handleToggleReference(ref)
        }}
        onUsePrompt={handleUsePrompt}
        referencedIds={referencedIds}
        syncState={
          todayPanel.loading ? 'loading' : todayPanel.error ? 'error' : todayPanel.data ? 'synced' : 'idle'
        }
        syncedAt={todayPanel.brief.syncedAt}
        taskRecordsById={taskRecordsById}
        tasks={todayPanel.brief.tasks}
      />
    </div>
  )
}
