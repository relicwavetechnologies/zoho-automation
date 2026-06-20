import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { followUpStatusLabel } from '@/lib/follow-ups/status-label'
import type { FollowUpTask } from '@/lib/follow-ups/types'
import { cn } from '@/lib/utils'

const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'

export function FollowUpActiveBanner({
  className,
  onMarkDone,
  onOpenDoc,
  onPause,
  onSelectTask,
  tasks
}: {
  className?: string
  tasks: FollowUpTask[]
  onSelectTask?: (task: FollowUpTask) => void
  onPause?: (task: FollowUpTask) => void
  onMarkDone?: (task: FollowUpTask) => void
  onOpenDoc?: (task: FollowUpTask) => void
}) {
  const [open, setOpen] = useState(false)
  const activeTasks = tasks.filter(
    task =>
      task.lifecycleActions.isFollowUp &&
      (task.lifecycleActions.canPause || task.lifecycleActions.canComplete)
  )
  const headline = activeTasks[0]

  if (!activeTasks.length) {
    return null
  }

  return (
    <div className={cn('w-[min(310px,calc(100vw-2rem))]', className)} data-slot="follow-up-active-banner">
      <button
        className={cn(
          'flex w-full items-center gap-2.5 rounded-[13px] bg-[#1a1a1a] px-3 py-2.5 text-left shadow-[0_10px_40px_rgba(0,0,0,0.35)]',
          PANEL_BORDER
        )}
        onClick={() => setOpen(current => !current)}
        type="button"
      >
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-[#6fc08a] shadow-[0_0_0_0_rgba(111,192,138,0.45)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[#eee]">Active follow-ups</span>
          <span className="mt-0.5 block truncate text-xs text-[#888]">
            {headline ? headline.title : 'No task started yet'}
          </span>
        </span>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#242424] text-xs font-bold text-[#d0d0d0]">
          {activeTasks.length}
        </span>
      </button>

      {open && (
        <div
          className={cn(
            'mt-2 overflow-hidden rounded-[13px] bg-[#181818] shadow-[0_20px_70px_rgba(0,0,0,0.42)]',
            PANEL_BORDER
          )}
        >
          {activeTasks.map(task => (
            <div
              className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-2 border-b border-[#272727] px-3 py-3 last:border-b-0"
              key={task.id}
            >
              <span className="grid size-6 place-items-center rounded-full border border-[#3a3a3a] text-[11px] text-[#9a9a9a]">
                <Codicon name="circle-outline" size="0.75rem" />
              </span>
              <button
                className="min-w-0 text-left"
                onClick={() => onSelectTask?.(task)}
                type="button"
              >
                <span className="block truncate text-[13px] text-[#dcdcdc]">{task.title}</span>
                <span className="mt-0.5 block text-[11px] text-[#888]">
                  {followUpStatusLabel(task.status)} · {task.dueLabel}
                </span>
              </button>
              <div className="flex flex-col gap-1">
                {task.lifecycleActions.canPause && (
                  <Button
                    className="h-7 px-2 text-[11px]"
                    onClick={() => onPause?.(task)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    Pause
                  </Button>
                )}
                {task.lifecycleActions.canComplete && (
                  <Button
                    className="h-7 px-2 text-[11px]"
                    onClick={() => onMarkDone?.(task)}
                    size="xs"
                    type="button"
                    variant="secondary"
                  >
                    Done
                  </Button>
                )}
              </div>
            </div>
          ))}
          <div className="flex gap-2 border-t border-[#272727] p-2.5">
            {activeTasks[0]?.lifecycleActions.canOpenTrackingDoc && (
              <Button
                className="h-8 flex-1 text-xs"
                onClick={() => activeTasks[0] && onOpenDoc?.(activeTasks[0])}
                type="button"
                variant="outline"
              >
                Open doc
              </Button>
            )}
            {activeTasks[0]?.lifecycleActions.canComplete && (
              <Button
                className="h-8 flex-1 text-xs"
                onClick={() => activeTasks[0] && onMarkDone?.(activeTasks[0])}
                type="button"
                variant="secondary"
              >
                Mark done
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
