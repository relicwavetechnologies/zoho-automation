import { Codicon } from '@/components/ui/codicon'
import { followUpStatusLabel } from '@/lib/follow-ups/status-label'
import type { FollowUpTask } from '@/lib/follow-ups/types'
import { cn } from '@/lib/utils'

const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'

export function FollowUpTaskList({
  className,
  onSelectTask,
  tasks
}: {
  className?: string
  tasks: FollowUpTask[]
  onSelectTask?: (task: FollowUpTask) => void
}) {
  if (!tasks.length) {
    return null
  }

  return (
    <div
      className={cn(
        'w-[min(310px,calc(100vw-2rem))] overflow-hidden rounded-[13px] bg-[#181818] shadow-[0_20px_70px_rgba(0,0,0,0.42)]',
        PANEL_BORDER,
        className
      )}
      data-slot="follow-up-task-list"
    >
      <div className="border-b border-[#272727] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[#7a7a7a]">
        Tasks
      </div>
      {tasks.map(task => (
        <button
          className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-2 border-b border-[#272727] px-3 py-3 text-left last:border-b-0 hover:bg-[#1f1f1f]"
          key={task.id}
          onClick={() => onSelectTask?.(task)}
          type="button"
        >
          <span className="grid size-6 place-items-center rounded-full border border-[#3a3a3a] text-[11px] text-[#9a9a9a]">
            <Codicon name="circle-outline" size="0.75rem" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-[#dcdcdc]">{task.title}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#888]">
              <span>
                {followUpStatusLabel(task.status)} · {task.dueLabel}
              </span>
              {task.lifecycleActions.isFollowUp && task.delegatedTag && (
                <span className={cn('rounded px-1.5 py-0.5 text-[10px]', PANEL_BORDER, 'text-[#cd9883]')}>
                  {task.delegatedTag}
                </span>
              )}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
