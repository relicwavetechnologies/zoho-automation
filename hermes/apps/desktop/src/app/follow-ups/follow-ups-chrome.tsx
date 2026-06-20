import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  createRequestFromDraft,
  followUpRecordToTask,
  getFollowUpsClient,
  isDivoFollowUpTask,
  type FollowUpsClient
} from '@/lib/follow-ups'
import { FollowUpsClientError, type FollowUpActionResponse } from '@/lib/follow-ups/api-types'
import type { FollowUpCreateDraft, FollowUpTask } from '@/lib/follow-ups/types'
import { cn } from '@/lib/utils'

import { FollowUpActiveBanner } from './active-banner'
import { FollowUpCompleteModal } from './complete-modal'
import { FollowUpCreateModal } from './create-modal'
import { FollowUpTaskDetailDrawer } from './task-detail-drawer'
import { FollowUpTaskList } from './task-list'
import { FollowUpUpdateDocModal } from './update-doc-modal'

const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'
const DEFAULT_CONFIRMED_START_DELAY_MS = 30_000

export interface FollowUpConfirmedStartSignal {
  sequence: string | number
  activeSessionId?: string | null
}

export interface FollowUpLifecycleRequestSignal {
  sequence: number
  action: 'pause' | 'updateDoc' | 'done'
  followUpId: string
}

interface PendingConfirmedStart {
  ignoredSignalKey: string | null
  taskId: string
}

export function FollowUpsChrome({
  activeContextTaskIds,
  className,
  client: clientProp,
  confirmedStartDelayMs = DEFAULT_CONFIRMED_START_DELAY_MS,
  confirmedStartSignal,
  createRequestSignal,
  externalTasks,
  externalTasksLoading,
  lifecycleRequestSignal,
  onGenerateCompletionSummary,
  onAddToContext,
  onTasksRefresh,
  overlay = true
}: {
  activeContextTaskIds?: ReadonlySet<string>
  className?: string
  client?: FollowUpsClient
  confirmedStartDelayMs?: number
  confirmedStartSignal?: FollowUpConfirmedStartSignal | null
  createRequestSignal?: number
  externalTasks?: FollowUpTask[]
  externalTasksLoading?: boolean
  lifecycleRequestSignal?: FollowUpLifecycleRequestSignal | null
  onGenerateCompletionSummary?: (task: FollowUpTask) => Promise<string> | string
  onAddToContext?: (task: FollowUpTask) => void
  onTasksRefresh?: () => Promise<void>
  /** When false, only lifecycle modals/drawer render (Today panel owns the surface). */
  overlay?: boolean
}) {
  const client = useMemo(() => clientProp ?? getFollowUpsClient(), [clientProp])
  const usesExternalTasks = externalTasks !== undefined

  useEffect(() => {
    if (createRequestSignal && createRequestSignal > 0) {
      setCreateOpen(true)
    }
  }, [createRequestSignal])
  const [createOpen, setCreateOpen] = useState(false)
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [internalTasks, setInternalTasks] = useState<FollowUpTask[]>([])
  const [internalTasksLoading, setInternalTasksLoading] = useState(true)
  const [updateDocOpen, setUpdateDocOpen] = useState(false)
  const [updateDocTask, setUpdateDocTask] = useState<FollowUpTask | null>(null)
  const [updateDocSubmitting, setUpdateDocSubmitting] = useState(false)
  const [updateDocError, setUpdateDocError] = useState<string | null>(null)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeTask, setCompleteTask] = useState<FollowUpTask | null>(null)
  const [completeSubmitting, setCompleteSubmitting] = useState(false)
  const [completeGenerating, setCompleteGenerating] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [pendingStarts, setPendingStarts] = useState<PendingConfirmedStart[]>([])

  const confirmedStartSignalKey = confirmedStartSignal?.sequence
    ? String(confirmedStartSignal.sequence)
    : null

  const refreshTasks = useCallback(async () => {
    if (onTasksRefresh) {
      await onTasksRefresh()
      return
    }
    const response = await client.listTaskMetadata()
    setInternalTasks(response.tasks.map(followUpRecordToTask))
  }, [client, onTasksRefresh])

  useEffect(() => {
    if (usesExternalTasks) {
      return undefined
    }
    let cancelled = false
    setInternalTasksLoading(true)
    void refreshTasks()
      .catch(() => {
        if (!cancelled) {
          setInternalTasks([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setInternalTasksLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [refreshTasks, usesExternalTasks])

  const tasks = externalTasks ?? internalTasks
  const tasksLoading = externalTasksLoading ?? internalTasksLoading

  const selectedTask = useMemo(
    () => tasks.find(task => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  )

  useEffect(() => {
    if (!activeContextTaskIds) {
      return
    }

    setPendingStarts(current => current.filter(pending => activeContextTaskIds.has(pending.taskId)))
  }, [activeContextTaskIds])

  const openTask = (task: FollowUpTask) => {
    setSelectedTaskId(task.id)
    setDrawerOpen(true)
  }

  const handleCreate = async (draft: FollowUpCreateDraft) => {
    setCreateSubmitting(true)
    setCreateError(null)
    try {
      const response = await client.createFollowUp(createRequestFromDraft(draft))
      const created = followUpRecordToTask(response.followUp)
      if (!usesExternalTasks) {
        setInternalTasks(current => [created, ...current.filter(task => task.id !== created.id)])
      } else {
        await refreshTasks()
      }
      setCreateOpen(false)
      openTask(created)
    } catch (error) {
      const message =
        error instanceof FollowUpsClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Could not create follow-up'
      setCreateError(message)
    } finally {
      setCreateSubmitting(false)
    }
  }

  const runLifecycle = useCallback(async (
    task: FollowUpTask,
    action: (id: string) => Promise<FollowUpActionResponse>
  ) => {
    if (!isDivoFollowUpTask(task)) {
      return
    }
    const response = await action(task.id)
    const updated = followUpRecordToTask(response.followUp)
    if (!usesExternalTasks) {
      setInternalTasks(current => current.map(row => (row.id === task.id ? updated : row)))
    } else {
      await refreshTasks()
    }
    return updated
  }, [refreshTasks, usesExternalTasks])

  const queueConfirmedStart = useCallback(
    (task: FollowUpTask) => {
      setPendingStarts(current => {
        const pending: PendingConfirmedStart = {
          ignoredSignalKey: confirmedStartSignalKey,
          taskId: task.id
        }

        return current.some(row => row.taskId === task.id)
          ? current.map(row => (row.taskId === task.id ? pending : row))
          : [...current, pending]
      })
    },
    [confirmedStartSignalKey]
  )

  useEffect(() => {
    if (!confirmedStartSignalKey || pendingStarts.length === 0) {
      return undefined
    }

    const starters = pendingStarts.filter(pending => pending.ignoredSignalKey !== confirmedStartSignalKey)

    if (starters.length === 0) {
      return undefined
    }

    const activeSessionId = confirmedStartSignal?.activeSessionId ?? undefined
    const starterIds = new Set(starters.map(starter => starter.taskId))
    const timer = window.setTimeout(() => {
      void Promise.all(
        starters.map(async starter => {
          const task = tasks.find(row => row.id === starter.taskId)

          if (!task || !task.lifecycleActions.canStart || !isDivoFollowUpTask(task)) {
            return
          }

          await runLifecycle(task, id =>
            client.startFollowUpIntent(
              activeSessionId
                ? {
                    activeSessionId,
                    followUpId: id
                  }
                : { followUpId: id }
            )
          )
        })
      ).finally(() => {
        setPendingStarts(current => current.filter(row => !starterIds.has(row.taskId)))
      })
    }, confirmedStartDelayMs)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    client,
    confirmedStartDelayMs,
    confirmedStartSignal?.activeSessionId,
    confirmedStartSignalKey,
    pendingStarts,
    runLifecycle,
    tasks
  ])

  const handleUpdateDoc = async (note: string) => {
    if (!updateDocTask) {
      return
    }
    setUpdateDocSubmitting(true)
    setUpdateDocError(null)
    try {
      const response = await client.updateFollowUpDoc({
        followUpId: updateDocTask.id,
        note
      })
      const updated = followUpRecordToTask(response.followUp)
      if (!usesExternalTasks) {
        setInternalTasks(current => current.map(row => (row.id === updateDocTask.id ? updated : row)))
      } else {
        await refreshTasks()
      }
      setUpdateDocOpen(false)
      setUpdateDocTask(null)
    } catch (error) {
      const message =
        error instanceof FollowUpsClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Could not update tracking doc'
      setUpdateDocError(message)
    } finally {
      setUpdateDocSubmitting(false)
    }
  }

  const openCompleteModal = (task: FollowUpTask) => {
    setCompleteError(null)
    setCompleteTask(task)
    setCompleteOpen(true)
  }

  useEffect(() => {
    if (!lifecycleRequestSignal) {
      return
    }
    const task = tasks.find(row => row.id === lifecycleRequestSignal.followUpId)
    if (!task || !isDivoFollowUpTask(task)) {
      return
    }
    if (lifecycleRequestSignal.action === 'pause') {
      if (!task.lifecycleActions.canPause) {
        return
      }
      void runLifecycle(task, id => client.pauseFollowUp({ followUpId: id }))
      return
    }
    if (lifecycleRequestSignal.action === 'updateDoc') {
      if (!task.lifecycleActions.canUpdateDoc) {
        return
      }
      setUpdateDocError(null)
      setUpdateDocTask(task)
      setUpdateDocOpen(true)
      return
    }
    if (lifecycleRequestSignal.action === 'done') {
      if (!task.lifecycleActions.canComplete) {
        return
      }
      openCompleteModal(task)
    }
  }, [client, lifecycleRequestSignal, runLifecycle, tasks])

  const handleComplete = async (summary: string) => {
    if (!completeTask) {
      return
    }

    setCompleteSubmitting(true)
    setCompleteError(null)
    try {
      const response = await client.completeFollowUp({
        followUpId: completeTask.id,
        summary
      })
      const updated = followUpRecordToTask(response.followUp)
      if (!usesExternalTasks) {
        setInternalTasks(current => current.map(row => (row.id === completeTask.id ? updated : row)))
      } else {
        await refreshTasks()
      }
      setCompleteOpen(false)
      setCompleteTask(null)
    } catch (error) {
      const message =
        error instanceof FollowUpsClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Could not complete follow-up'
      setCompleteError(message)
    } finally {
      setCompleteSubmitting(false)
    }
  }

  const handleGenerateCompletionSummary = async () => {
    if (!completeTask || !onGenerateCompletionSummary) {
      return ''
    }

    setCompleteGenerating(true)
    setCompleteError(null)
    try {
      return await onGenerateCompletionSummary(completeTask)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not generate summary'
      setCompleteError(message)
      return ''
    } finally {
      setCompleteGenerating(false)
    }
  }

  return (
    <div
      className={cn(overlay ? 'pointer-events-none absolute inset-0 z-40' : 'contents', className)}
      data-slot="follow-ups-chrome"
    >
      {overlay ? (
        <div className="pointer-events-auto absolute right-6 top-[4.5rem] flex flex-col items-end gap-3 sm:right-7">
          <Button
            className={cn(
              'h-9 rounded-full bg-[#1a1a1a] px-3.5 text-xs font-medium text-[#dcdcdc] shadow-[0_10px_30px_rgba(0,0,0,0.35)] hover:bg-[#222]',
              PANEL_BORDER
            )}
            onClick={() => {
              setCreateError(null)
              setCreateOpen(true)
            }}
            type="button"
            variant="outline"
          >
            <Codicon className="mr-1.5" name="add" size="0.85rem" />
            Assign follow-up
          </Button>

          {!tasksLoading && (
            <>
              <FollowUpTaskList onSelectTask={openTask} tasks={tasks} />
              <FollowUpActiveBanner
                onMarkDone={task => {
                  if (!task.lifecycleActions.canComplete) {
                    return
                  }
                  openCompleteModal(task)
                }}
                onOpenDoc={task => {
                  if (!task.lifecycleActions.canOpenTrackingDoc || !task.trackingDocUrl) {
                    return
                  }
                  void window.hermesDesktop?.openExternal?.(task.trackingDocUrl)
                }}
                onPause={task => {
                  if (!task.lifecycleActions.canPause) {
                    return
                  }
                  void runLifecycle(task, id => client.pauseFollowUp({ followUpId: id }))
                }}
                onSelectTask={openTask}
                tasks={tasks}
              />
            </>
          )}
        </div>
      ) : null}

      <FollowUpCreateModal
        errorMessage={createError}
        onOpenChange={open => {
          if (!createSubmitting) {
            setCreateOpen(open)
            if (!open) {
              setCreateError(null)
            }
          }
        }}
        onSubmit={handleCreate}
        open={createOpen}
        submitting={createSubmitting}
      />

      <FollowUpUpdateDocModal
        errorMessage={updateDocError}
        onOpenChange={open => {
          if (!updateDocSubmitting) {
            setUpdateDocOpen(open)
            if (!open) {
              setUpdateDocError(null)
              setUpdateDocTask(null)
            }
          }
        }}
        onSubmit={handleUpdateDoc}
        open={updateDocOpen}
        submitting={updateDocSubmitting}
        taskTitle={updateDocTask?.title}
      />

      <FollowUpCompleteModal
        errorMessage={completeError}
        generating={completeGenerating}
        onGenerateSummary={onGenerateCompletionSummary ? handleGenerateCompletionSummary : undefined}
        onOpenChange={open => {
          if (!completeSubmitting && !completeGenerating) {
            setCompleteOpen(open)
            if (!open) {
              setCompleteError(null)
              setCompleteTask(null)
            }
          }
        }}
        onSubmit={handleComplete}
        open={completeOpen}
        submitting={completeSubmitting}
        taskTitle={completeTask?.title}
      />

      <FollowUpTaskDetailDrawer
        onAddToContext={task => {
          if (!task.lifecycleActions.canStart) {
            return
          }
          onAddToContext?.(task)
          queueConfirmedStart(task)
        }}
        onMarkDone={task => {
          if (!task.lifecycleActions.canComplete) {
            return
          }
          openCompleteModal(task)
        }}
        onOpenChange={setDrawerOpen}
        onOpenDoc={task => {
          if (!task.lifecycleActions.canOpenTrackingDoc || !task.trackingDocUrl) {
            return
          }
          void window.hermesDesktop?.openExternal?.(task.trackingDocUrl)
        }}
        onPause={task => {
          if (!task.lifecycleActions.canPause) {
            return
          }
          void runLifecycle(task, id => client.pauseFollowUp({ followUpId: id }))
        }}
        onUpdateDoc={task => {
          if (!task.lifecycleActions.canUpdateDoc) {
            return
          }
          setUpdateDocError(null)
          setUpdateDocTask(task)
          setUpdateDocOpen(true)
        }}
        open={drawerOpen}
        task={selectedTask}
      />
    </div>
  )
}

export { FollowUpActiveBanner } from './active-banner'
export { FollowUpCompleteModal } from './complete-modal'
export { FollowUpCreateModal } from './create-modal'
export { FollowUpTaskDetailDrawer } from './task-detail-drawer'
